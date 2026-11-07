import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Agent, run, setDefaultOpenAIClient, tool } from '@openai/agents';
import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import { formatRial, toFaDigits } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';
import { quote } from '../orders/pricing';

/** What the agent must hand back: sizes picked only from catalog search results. */
const DraftSchema = z.object({
  reply: z.string().describe('پاسخ کوتاه و مؤدبانه به فارسی برای مشتری'),
  items: z.array(z.object({
    variantId: z.string().describe('شناسه‌ی سایز دقیقاً از نتیجه‌ی search_catalog'),
    quantity: z.number().int().positive(),
    unit: z.enum(['unit', 'pack']).describe('unit = عدد/شاخه؛ pack = کارتن/بسته/کیسه'),
  })),
  unclear: z.array(z.string()).describe('بخش‌هایی از درخواست که کالا یا سایزش مشخص نشد'),
});
type Draft = z.infer<typeof DraftSchema>;

const INSTRUCTIONS = `تو دستیار سفارش «اصفهان پلاست» هستی؛ تولیدکننده‌ی لوله و اتصالات پلی‌اتیلن، شیرآلات و تجهیزات آبیاری.
مشتری عمده‌فروش است و سفارشش را محاوره‌ای می‌نویسد، مثلاً «دو کارتن نری ۶۳ در ۲ و یه کیسه رابط ۵۰».
وظیفه: هر قلم را با ابزار search_catalog پیدا کن و سایز دقیقش را انتخاب کن.
قواعد:
- فقط از نتیجه‌ی search_catalog استفاده کن. هرگز کالا، سایز یا قیمت از خودت نساز.
- «نری» یعنی اتصال نر، «مادگی» یعنی اتصال ماده، «بوشن/رابط» یعنی رابط. اعداد ۲۰ تا ۲۰۰ معمولاً قطر لوله (میلی‌متر) و ½ تا ۴ اینچ سایز رزوه است.
- کارتن/کیسه/بسته = unit:"pack"؛ عدد/شاخه/تا = unit:"unit". اگر واحد گفته نشد و کالا بسته‌بندی دارد، "pack" نگیر؛ "unit" بگیر.
- اگر سایز یا کالا مبهم بود یا در کاتالوگ نبود، آن را در unclear بنویس و در reply کوتاه بپرس؛ حدس نزن.
- درباره‌ی قیمت فقط عدد همان نتیجه را بگو؛ «استعلامی» یعنی قیمت را کارشناس فروش اعلام می‌کند.
- reply کوتاه باشد (حداکثر دو جمله) و فهرست اقلام را تکرار نکند؛ برنامه خودش فهرست را نشان می‌دهد.
- تو سفارش را ثبت نمی‌کنی؛ فقط پیش‌نویس می‌سازی که مشتری خودش بررسی و ثبت می‌کند. هرگز نگو «ثبت شد» یا «سفارش شما ثبت شد»؛ بگو «پیش‌نویس آماده شد».
- اگر پیام سفارش نبود (سؤال یا احوال‌پرسی)، items خالی و پاسخ کوتاه بده.`;

const FA = '۰۱۲۳۴۵۶۷۸۹';
const en = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d)));
const fa = (s: string) => s.replace(/\d/g, d => FA[+d]);
const STOP = new Set(['و', 'با', 'در', 'از', 'به', 'تا', 'عدد', 'کارتن', 'کیسه', 'بسته', 'شاخه', 'اینچ', 'سایز', 'میخوام', 'می‌خوام', 'لطفا', 'لطفاً']);

export interface DraftLine { variantId: string; quantity: number; mode: 'unit' | 'pack'; packs: number | null }

@Injectable()
export class AssistantService {
  private readonly log = new Logger('Assistant');
  private readonly calls = new Map<string, number[]>();
  readonly enabled = !!process.env.OPENAI_API_KEY;
  private client?: OpenAI;

  constructor(private readonly prisma: PrismaService) {
    if (this.enabled) {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
      setDefaultOpenAIClient(this.client as never);
    }
  }

  /** At most `n` assistant calls per user per minute (each call costs API credit). */
  private limit(userId: string, n = 12) {
    const now = Date.now();
    const recent = (this.calls.get(userId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= n) throw new BadRequestException('کمی صبر کنید و دوباره بفرستید');
    recent.push(now); this.calls.set(userId, recent);
  }

  private ensure() {
    if (!this.enabled) throw new ServiceUnavailableException('دستیار هوشمند هنوز فعال نشده است');
  }

  /** Catalog search the agent calls: families by name or synonym, with every size, pack count and price. */
  async searchCatalog(query: string) {
    const words = en(query).split(/[\s،,]+/).map(w => w.trim()).filter(w => w.length >= 2 && !/^[\d/½¼¾.×x*"″]+$/.test(w) && !STOP.has(w));
    const terms = words.length ? words.map(fa) : [query.trim()];
    // «سه راه» and «سه‌راه» are the same word: also try neighbours joined with a zero-width non-joiner or nothing
    for (let i = 0; i + 1 < words.length; i++) terms.push(fa(words[i] + '\u200c' + words[i + 1]), fa(words[i] + words[i + 1]));
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    const fams = await this.prisma.productFamily.findMany({
      where: { isActive: true, OR: terms.flatMap(t => [{ name: { contains: t } }, { synonyms: { some: { term: { contains: t } } } }]) },
      take: 30, orderBy: { sortOrder: 'asc' },
      include: {
        axes: { orderBy: { sortOrder: 'asc' } },
        variants: { where: { isActive: true }, orderBy: { sku: 'asc' }, take: 60, include: { options: true, prices: list ? { where: { priceListId: list.id } } : { where: { id: '-' } } } },
      },
    });
    // best matches first: families whose name holds more of the words
    const score = (name: string) => terms.filter(t => name.includes(t)).length;
    fams.sort((a, b) => score(b.name) - score(a.name));
    return fams.slice(0, 6).map(f => ({
      family: f.name, unit: f.unitName, pack: f.packName, axes: f.axes.map(a => a.name),
      sizes: f.variants.map(v => {
        const p = v.prices[0];
        return {
          variantId: v.id,
          size: f.axes.length ? f.axes.map(a => v.options.find(o => o.axisId === a.id)?.value ?? '').join(' × ') : v.title,
          perPack: v.perPack,
          price: p && p.status === 'PRICED' && p.amount !== null ? formatRial(p.amount) : 'استعلامی',
        };
      }),
    }));
  }

  private agent() {
    const search = tool({
      name: 'search_catalog',
      description: 'جست‌وجو در کاتالوگ و لیست قیمت فعال. نام کالا را بده (مثلاً «اتصال نر» یا «فیلتر دیسکی»)؛ همه‌ی سایزها با شناسه، تعداد در بسته و قیمت برمی‌گردد.',
      parameters: z.object({ query: z.string().describe('نام کالا، بدون عدد سایز') }),
      execute: async ({ query }) => { const r = await this.searchCatalog(query); this.log.debug(`search_catalog «${query}» → ${r.map(f => f.family).join('، ') || '—'}`); return JSON.stringify(r); },
    });
    return new Agent({
      name: 'iPlast order assistant',
      instructions: INSTRUCTIONS,
      tools: [search],
      outputType: DraftSchema,
      ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
    });
  }

  /** Persian speech to text for voice notes. */
  async transcribe(audio: Buffer, filename = 'voice.ogg'): Promise<string> {
    this.ensure();
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';
    const r = await this.client!.audio.transcriptions.create({ file: await toFile(audio, filename), model, language: 'fa' });
    return (r as { text: string }).text.trim();
  }

  /** Turns free text into a validated order draft and stores it, so the mini app can open it as a cart. */
  async draft(userId: string, text: string, source: string, customerId: string | null) {
    this.ensure();
    this.limit(userId);
    const input = text.trim().slice(0, 1500);
    if (!input) throw new BadRequestException('متن سفارش خالی است');
    let out: Draft;
    try {
      const result = await run(this.agent(), input, { maxTurns: 8 });
      out = DraftSchema.parse(result.finalOutput);
    } catch (e) {
      this.log.warn(`agent failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('دستیار الان پاسخ نداد؛ سفارش را برای کارشناس فروش بفرستید');
    }
    // never trust ids from the model: keep only real, active sizes
    const q = await quote(this.prisma, out.items.map(i => i.variantId), customerId);
    const lines: DraftLine[] = [];
    for (const i of out.items) {
      const v = q.get(i.variantId);
      if (!v) continue;
      const pack = i.unit === 'pack' && !!v.perPack;
      lines.push({ variantId: v.variantId, quantity: pack ? i.quantity * v.perPack! : i.quantity, mode: pack ? 'pack' : 'unit', packs: pack ? i.quantity : null });
    }
    const d = await this.prisma.assistantDraft.create({
      data: { userId, source, inputText: input, reply: out.reply.replace(/(سفارش(\s*شما)?\s*)?ثبت شد/g, 'در پیش‌نویس آمد').slice(0, 1000), items: lines as object[], unclear: out.unclear.slice(0, 20), model: process.env.OPENAI_MODEL ?? null },
    });
    return this.view(d.id, userId, customerId);
  }

  /** A draft with titles, sizes and prices, ready for the cart or a chat message. */
  async view(id: string, userId: string, customerId: string | null) {
    const d = await this.prisma.assistantDraft.findUnique({ where: { id } });
    if (!d || d.userId !== userId) throw new BadRequestException('پیش‌نویس پیدا نشد');
    const items = d.items as unknown as DraftLine[];
    const q = await quote(this.prisma, items.map(i => i.variantId), customerId);
    const vs = await this.prisma.variant.findMany({
      where: { id: { in: items.map(i => i.variantId) } },
      include: { options: true, family: { include: { axes: { orderBy: { sortOrder: 'asc' } }, media: { where: { isPrimary: true }, take: 1 } } } },
    });
    const lines = items.map(i => {
      const v = vs.find(x => x.id === i.variantId)!;
      const f = v.family;
      const label = f.axes.length ? f.axes.map(a => v.options.find(o => o.axisId === a.id)?.value ?? '').filter(Boolean).join(' × ') : v.title;
      const unitPrice = q.get(i.variantId)?.unitPrice ?? null;
      return {
        variantId: v.id, slug: f.slug, name: f.name, label, photo: f.media[0] ? '/' + f.media[0].key : null, perPack: v.perPack, packName: f.packName, unitName: f.unitName,
        price: unitPrice === null ? null : unitPrice.toString(), n: i.packs ?? i.quantity, mode: i.mode, quantity: i.quantity,
      };
    });
    const total = lines.reduce((s, l) => s + (l.price ? BigInt(l.price) * BigInt(l.quantity) : 0n), 0n);
    return { id: d.id, reply: d.reply, unclear: (d.unclear as string[] | null) ?? [], lines, total: total.toString(), inputText: d.inputText };
  }

  /** Plain-text version for the bot chat. */
  chatText(v: Awaited<ReturnType<AssistantService['view']>>) {
    const rows = v.lines.map((l, k) => `${toFaDigits(k + 1)}. ${l.name} ${l.label} — ${l.mode === 'pack' ? `${toFaDigits(l.n)} ${l.packName ?? 'بسته'} (${toFaDigits(l.quantity)} ${l.unitName})` : `${toFaDigits(l.quantity)} ${l.unitName}`} — ${l.price ? formatRial(BigInt(l.price) * BigInt(l.quantity)) : 'استعلامی'}`);
    const parts = [v.reply];
    if (rows.length) parts.push('', '🧾 پیش‌نویس سفارش:', ...rows, '', `جمع تقریبی: ${formatRial(BigInt(v.total))}`);
    if (v.unclear.length) parts.push('', `❔ مشخص نشد: ${v.unclear.join('، ')}`);
    return parts.join('\n');
  }

  /** Downloads a voice note the customer sent to the bot. */
  async telegramFile(fileId: string): Promise<{ buf: Buffer; name: string }> {
    const token = process.env.BOT_TOKEN;
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`).then(r => r.json()).catch(() => ({ ok: false })) as { ok: boolean; result?: { file_path?: string } };
    if (!info.ok || !info.result?.file_path) throw new BadRequestException('فایل صوتی دریافت نشد');
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`).catch(() => null);
    if (!r?.ok) throw new BadRequestException('فایل صوتی دریافت نشد');
    return { buf: Buffer.from(await r.arrayBuffer()), name: info.result.file_path.split('/').pop() ?? 'voice.ogg' };
  }
}
