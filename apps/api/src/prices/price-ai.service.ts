import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type { ParsedRow } from './pdf-parse';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const en = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d)));

const Extracted = z.object({
  title: z.string().describe('عنوان لیست، مثلاً «لیست قیمت آذر ۱۴۰۵»؛ اگر نبود خالی'),
  rows: z.array(z.object({
    page: z.number().int(),
    familyTitle: z.string().describe('عنوان گروه/جدولی که ردیف زیر آن است'),
    description: z.string().describe('شرح یا سایز ردیف، همان‌طور که در فایل آمده'),
    accountingCode: z.string().describe('کد کالا با رقم لاتین؛ اگر نبود خالی'),
    perPack: z.number().int().nullable().describe('تعداد در کارتن/بسته؛ اگر نبود null'),
    priceRial: z.number().int().nullable().describe('قیمت به ریال؛ برای «بزودی»، «*»، «تماس بگیرید» یا خالی null'),
  })),
});

const Matches = z.object({
  matches: z.array(z.object({
    row: z.number().int().describe('شماره‌ی ردیف PDF'),
    size: z.number().int().nullable().describe('شماره‌ی سایز کاتالوگ؛ اگر مطمئن نیستی یا در کاتالوگ نیست null'),
    sure: z.boolean().describe('true فقط وقتی نام کالا، سایز و (اگر هست) تعداد در بسته با هم جورند'),
  })),
});

const MATCH_RULES = `تو کارشناس لیست قیمت «اصفهان پلاست» (لوله و اتصالات پلی‌اتیلن، شیرآلات و تجهیزات آبیاری) هستی.
ردیف‌های یک لیست قیمت جدید را باید به سایزهای کاتالوگ وصل کنی.
- هر ردیف را فقط به سایزی وصل کن که نوع کالا (مثلاً اتصال نر، زانو، سه‌راه، فیلتر) و همه‌ی ابعادش یکی باشد. «نری» = اتصال نر، «مادگی» = اتصال ماده، «سراه/سه راه» = سه‌راه.
- ابعاد را دقیق مقایسه کن: ۶۳ × ۲″ با ۶۳ × ۱½″ فرق دارد. اگر تعداد در بسته‌ی ردیف با سایز کاتالوگ فرق دارد، احتمالاً سایز دیگری است.
- هر سایز کاتالوگ حداکثر به یک ردیف وصل می‌شود.
- اگر مطمئن نیستی size را null بگذار؛ حدس غلط از وصل‌نکردن بدتر است. قیمت را تو تعیین نمی‌کنی.`;

/**
 * AI help for price-list updates: reads scanned or unusual PDFs, and connects rows the code rules could not
 * (no code, repeated code, new layout) to the right catalog size. A person still reviews and publishes.
 */
@Injectable()
export class PriceAiService {
  private readonly log = new Logger('PriceAI');
  readonly enabled = !!process.env.OPENAI_API_KEY;
  private client?: OpenAI;
  private get model() { return process.env.OPENAI_PRICE_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1'; }

  constructor(private readonly prisma: PrismaService) {
    if (this.enabled) this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
  }

  /** Reads the price rows straight from the PDF (for scanned files or layouts the text parser does not understand). */
  async extract(pdf: Buffer, filename: string): Promise<{ title: string | null; rows: ParsedRow[] }> {
    const r = await this.client!.responses.parse({
      model: this.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: filename || 'prices.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` },
          { type: 'input_text', text: 'همه‌ی ردیف‌های قیمت این لیست را دقیق و کامل استخراج کن. هیچ عددی را حدس نزن یا گرد نکن؛ اگر قیمت ردیفی عدد نیست null بگذار. اگر یک ردیف چند ستون قیمت دارد (مثلاً چند مدل)، برای هر ستون یک ردیف جدا بساز و نام ستون را به description اضافه کن.' },
        ],
      }],
      text: { format: zodTextFormat(Extracted, 'price_rows') },
    });
    const out = r.output_parsed;
    if (!out) throw new Error('پاسخ هوش مصنوعی خوانده نشد');
    return {
      title: out.title.trim() || null,
      rows: out.rows.map(x => ({
        page: x.page, familyTitle: x.familyTitle.trim() || null, rawText: x.description.trim(), accountingCode: en(x.accountingCode).replace(/\D/g, '') || null,
        perPack: x.perPack, amount: x.priceRial !== null && x.priceRial >= 1000 ? BigInt(x.priceRial) : null, note: x.priceRial === null ? 'استعلامی' : null,
      })),
    };
  }

  /**
   * Connects the draft's rows that are not matched yet (or only suggested) to catalog sizes.
   * Rows a person already decided are left alone. Returns how many rows were connected.
   */
  async matchDraft(priceListId: string) {
    const rows = await this.prisma.priceImportRow.findMany({
      where: { priceListId, resolvedBy: null, match: { in: ['UNMATCHED', 'AMBIGUOUS', 'NEW'] } },
      orderBy: [{ page: 'asc' }, { id: 'asc' }],
    });
    if (!rows.length) return { checked: 0, matched: 0, suggested: 0 };
    const taken = new Set((await this.prisma.priceImportRow.findMany({ where: { priceListId, variantId: { not: null }, match: 'MATCHED' }, select: { variantId: true } })).map(r => r.variantId!));
    const variants = await this.prisma.variant.findMany({
      where: { isActive: true, family: { isActive: true } },
      orderBy: [{ family: { sortOrder: 'asc' } }, { sku: 'asc' }],
      include: { family: { include: { axes: { orderBy: { sortOrder: 'asc' } } } }, options: true },
    });
    const free = variants.filter(v => !taken.has(v.id));
    const catalog = free.map((v, i) => {
      const size = v.family.axes.map(a => v.options.find(o => o.axisId === a.id)?.value).filter(Boolean).join(' × ') || v.title;
      return `${i}|${v.family.name}${v.family.model ? ` (${v.family.model})` : ''}|${size}|کد ${v.accountingCode ?? '-'}|${v.perPack ?? '-'} در بسته`;
    }).join('\n');

    let matched = 0, suggested = 0;
    const used = new Set<number>();
    for (let start = 0; start < rows.length; start += 60) {
      const chunk = rows.slice(start, start + 60);
      const list = chunk.map((r, i) => `${start + i}|${r.familyTitle ?? ''}|${r.rawText}|کد ${r.accountingCode ?? '-'}|${r.perPack ?? '-'} در بسته`).join('\n');
      let out: z.infer<typeof Matches> | null = null;
      try {
        const res = await this.client!.responses.parse({
          model: this.model,
          instructions: MATCH_RULES,
          input: `سایزهای کاتالوگ (شماره|کالا|سایز|کد|تعداد در بسته):\n${catalog}\n\nردیف‌های PDF (شماره|گروه|شرح|کد|تعداد در بسته):\n${list}`,
          text: { format: zodTextFormat(Matches, 'matches') },
        });
        out = res.output_parsed;
      } catch (e) {
        this.log.warn(`match failed: ${(e as Error).message}`);
        continue;
      }
      for (const m of out?.matches ?? []) {
        const row = rows[m.row];
        const v = m.size !== null ? free[m.size] : undefined;
        if (!row || !v || m.row < start || m.row >= start + chunk.length || used.has(m.size!)) continue;
        used.add(m.size!);
        await this.prisma.priceImportRow.update({ where: { id: row.id }, data: { variantId: v.id, match: m.sure ? 'MATCHED' : 'AMBIGUOUS', resolvedBy: 'ai' } });
        if (m.sure) matched++; else suggested++;
      }
    }
    return { checked: rows.length, matched, suggested };
  }
}
