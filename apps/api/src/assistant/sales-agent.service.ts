import { Injectable, Logger } from '@nestjs/common';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { formatRial } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService, STATUS_FA } from '../orders/orders.service';
import { TelegramService } from '../common/telegram.service';
import { quote } from '../orders/pricing';
import { AssistantService, DraftLine } from './assistant.service';
import { AccountingService, METHOD_FA, PAY_STATUS_FA } from '../accounting/accounting';

const AI_PREFIX = '[دستیار]\n';

const INSTRUCTIONS = `تو «ایجنت فروش» اصفهان پلاست هستی؛ تولیدکننده‌ی لوله و اتصالات پلی‌اتیلن، شیرآلات و تجهیزات آبیاری. مشتری‌ها عمده‌فروش و پیمانکارند.
تو کار فروش را از اول تا ثبت پیش‌فاکتور پیش می‌بری؛ کارشناس فروش انسانی فقط پیش‌فاکتوری را که تو ثبت می‌کنی تأیید می‌کند و بعد مدیر ارشد تأیید نهایی می‌دهد.

روش کار:
1. سفارش مشتری را با search_catalog پیدا کن و با set_draft در پیش‌نویس بگذار. هر بار که اقلام تغییر کرد، set_draft را با فهرست کامل و جدید صدا بزن.
2. اگر کالا یا سایز مبهم است، کوتاه بپرس؛ حدس نزن. «نری» = اتصال نر، «مادگی» = اتصال ماده، «بوشن/رابط» = رابط. اعداد ۲۰ تا ۲۰۰ معمولاً قطر لوله و ½ تا ۴ اینچ سایز رزوه است. کارتن/کیسه/بسته = pack؛ عدد/شاخه = unit.
3. وقتی پیش‌نویس کامل شد، فهرست کوتاه و جمع را بگو و بپرس «ثبت کنم؟».
4. فقط وقتی مشتری صریحاً تأیید کرد (مثلاً «بله»، «ثبت کن»، «اوکی»)، submit_order را صدا بزن. اگر نام فروشگاه/شرکت لازم بود، اول بپرس و بعد با companyName صدا بزن.
5. بعد از ثبت بگو: «پیش‌فاکتور شماره‌ی X ثبت شد و برای تأیید کارشناس فروش رفت.» تأیید، تخفیف، زمان ارسال و قیمت استعلامی با کارشناس است؛ قول نده.
6. برای پیگیری سفارش از my_orders و برای جزئیات یک سفارش (اقلام، مبلغ نقد و چک، بارنامه، راننده) از order_detail استفاده کن.
7. وقتی کارشناس قیمت‌ها را نهایی کرد، سفارش «پیش‌فاکتور نهایی؛ منتظر تأیید مشتری» است. مبلغ و مهلت را بگو و بپرس تأیید می‌کند یا نه. فقط با تأیید صریح مشتری answer_proforma با ok=true، و اگر تغییر خواست با ok=false و توضیح او صدا بزن.
8. برای مانده‌ی حساب، فاکتورها، چک‌های در جریان و سررسیدها از my_account استفاده کن. برای ثبت پرداخت بگو عکس یا PDF فیش یا چک را از مینی‌اپ ← سفارش‌ها ← حساب من بفرستد.
9. در این موارد handoff را صدا بزن و به مشتری بگو کارشناس فروش به‌زودی جواب می‌دهد: مشتری آدم/کارشناس خواست؛ شکایت، تأخیر یا خرابی بار؛ اختلاف حساب یا چک برگشتی؛ درخواست تخفیف یا شرایط ویژه؛ سؤالی که با ابزارها جوابش را نداری.

قواعد:
- فقط از نتیجه‌ی ابزارها استفاده کن. هرگز کالا، سایز، قیمت، موجودی یا زمان ارسال از خودت نساز. «استعلامی» یعنی قیمت را کارشناس اعلام می‌کند.
- فارسی، مؤدب، کوتاه (حداکثر چند جمله). اعداد را فارسی بنویس.
- پیام کوتاهی مثل سلام یا تشکر را کوتاه جواب بده.`;

export interface AgentTurn {
  mode: 'ai' | 'human';
  conversationId: string;
  messageId: string; // the customer's message
  reply?: string;
  heard?: string | null;
  draft?: Awaited<ReturnType<AssistantService['view']>> | null;
  orderNumber?: number | null;
  handoff?: string | null;
}

/**
 * The AI sales agent: every customer message (bot or mini app) comes here first. It answers, builds the order,
 * places the proforma once the customer confirms, and hands the chat to a person when needed.
 * Sales agents then only approve proformas; the senior manager gives the final approval.
 */
@Injectable()
export class SalesAgentService {
  private readonly log = new Logger('SalesAgent');
  constructor(private readonly prisma: PrismaService, private readonly ai: AssistantService, private readonly orders: OrdersService, private readonly tg: TelegramService, private readonly acc: AccountingService) {}

  get enabled() { return this.ai.enabled && process.env.SALES_AGENT !== '0'; }

  async conversationFor(telegramId: bigint, customerId?: string | null) {
    const c = await this.prisma.conversation.findFirst({ where: { userTelegramId: telegramId, isOpen: true }, orderBy: { updatedAt: 'desc' } });
    return c ?? this.prisma.conversation.create({ data: { userTelegramId: telegramId, customerId: customerId ?? undefined } });
  }

  /** One customer message. Text, or a voice note (transcribed); photos and files go to a person. */
  async handle(userId: string, input: { text?: string | null; kind: 'TEXT' | 'VOICE' | 'PHOTO' | 'DOCUMENT'; fileId?: string | null; audio?: { buf: Buffer; name: string } }): Promise<AgentTurn> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { memberships: { include: { customer: { include: { terms: true, categoryDiscounts: { include: { category: { select: { name: true } } } }, support: { select: { firstName: true, lastName: true } } } } } } } });
    const account = user.memberships[0]?.customer ?? null;
    const conv = await this.conversationFor(user.telegramId, account?.id);
    const msg = await this.prisma.message.create({ data: { conversationId: conv.id, direction: 'IN', kind: input.kind, text: input.text ?? null, telegramFileId: input.fileId ?? null } });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { isOpen: true } });
    const base = { conversationId: conv.id, messageId: msg.id };

    if (!this.enabled || conv.handoffAt) return { mode: 'human', ...base };
    if (input.kind === 'PHOTO' || input.kind === 'DOCUMENT') {
      await this.handoff(conv.id, 'مشتری عکس یا فایل فرستاد');
      return this.say(base, 'فایل شما رسید و برای کارشناس فروش فرستاده شد؛ به‌زودی جواب می‌دهد.', { handoff: 'مشتری عکس یا فایل فرستاد' });
    }

    let text = (input.text ?? '').trim();
    let heard: string | null = null;
    if (input.kind === 'VOICE') {
      try {
        const f = input.audio ?? (input.fileId ? await this.ai.telegramFile(input.fileId) : null);
        if (!f) throw new Error('no audio');
        text = heard = await this.ai.transcribe(f.buf, f.name.endsWith('.oga') ? f.name.replace(/\.oga$/, '.ogg') : f.name);
        await this.prisma.message.update({ where: { id: msg.id }, data: { text: `🎙 ${heard}` } });
      } catch {
        await this.handoff(conv.id, 'پیام صوتی خوانده نشد');
        return this.say(base, 'پیام صوتی‌تان را برای کارشناس فروش فرستادم؛ به‌زودی جواب می‌دهد.', { handoff: 'پیام صوتی خوانده نشد' });
      }
    }
    if (!text) return { mode: 'ai', ...base };

    // state the tools change during this turn
    let draftId: string | null = (await this.prisma.assistantDraft.findFirst({ where: { userId, usedAt: null, createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } }, orderBy: { createdAt: 'desc' } }))?.id ?? null;
    let orderNumber: number | null = null;
    let handoff: string | null = null;
    const customerId = account?.id ?? null;

    const search = tool({
      name: 'search_catalog', description: 'جست‌وجو در کاتالوگ و لیست قیمت فعال؛ نام کالا بدون عدد سایز. همه‌ی سایزها با شناسه، تعداد در بسته و قیمت برمی‌گردد.',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => JSON.stringify(await this.ai.searchCatalog(query)),
    });
    const setDraft = tool({
      name: 'set_draft', description: 'پیش‌نویس سفارش را با فهرست کامل اقلام جایگزین می‌کند (variantId فقط از search_catalog). فهرست خالی یعنی پاک کردن پیش‌نویس.',
      parameters: z.object({ items: z.array(z.object({ variantId: z.string(), quantity: z.number().int().positive(), unit: z.enum(['unit', 'pack']) })) }),
      execute: async ({ items }) => {
        const q = await quote(this.prisma, items.map(i => i.variantId), customerId);
        const lines: DraftLine[] = [];
        const missing: string[] = [];
        for (const i of items) {
          const v = q.get(i.variantId);
          if (!v) { missing.push(i.variantId); continue; }
          const pack = i.unit === 'pack' && !!v.perPack;
          lines.push({ variantId: v.variantId, quantity: pack ? i.quantity * v.perPack! : i.quantity, mode: pack ? 'pack' : 'unit', packs: pack ? i.quantity : null });
        }
        const d = await this.prisma.assistantDraft.create({ data: { userId, source: 'agent', inputText: text.slice(0, 1500), reply: '', items: lines as object[], model: process.env.OPENAI_MODEL ?? null } });
        draftId = d.id;
        const v = await this.ai.view(d.id, userId, customerId);
        return JSON.stringify({ lines: v.lines.map(l => ({ name: `${l.name} ${l.label}`, quantity: l.quantity, unit: l.unitName, packs: l.mode === 'pack' ? l.n : null, price: l.price ? formatRial(BigInt(l.price) * BigInt(l.quantity)) : 'استعلامی' })), total: formatRial(BigInt(v.total)), invalidIds: missing });
      },
    });
    const owned = user.memberships.filter(m => m.role === 'OWNER' || m.role === 'VIEWER').map(m => m.customerId);
    const visible = { OR: [{ placedById: userId }, { customerId: { in: owned } }] };
    const myOrders = tool({
      name: 'my_orders', description: 'آخرین سفارش‌ها و پیش‌فاکتورهای این مشتری با وضعیت و مبلغ قابل پرداخت.',
      parameters: z.object({}),
      execute: async () => {
        const os = await this.prisma.order.findMany({ where: visible, orderBy: { createdAt: 'desc' }, take: 8, include: { items: true, proformas: { orderBy: { version: 'desc' }, take: 1 } } });
        return JSON.stringify(os.map(o => ({
          number: o.number, status: STATUS_FA[o.status], items: o.items.length, payable: formatRial(this.orders.breakdown(o).total),
          inquiry: o.items.filter(i => i.unitPrice === null).length, date: o.createdAt.toISOString().slice(0, 10),
          proformaExpires: o.status === 'PROFORMA_SENT' && o.proformas[0] ? o.proformas[0].expiresAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : null,
        })));
      },
    });
    const orderDetail = tool({
      name: 'order_detail', description: 'جزئیات یک سفارش با شماره: اقلام، تخفیف، سهم نقد و چک، چک‌ها، و اطلاعات ارسال (باربری، بارنامه، راننده، پلاک).',
      parameters: z.object({ number: z.number().int() }),
      execute: async ({ number }) => {
        const o = await this.prisma.order.findFirst({ where: { number, ...visible }, include: { items: true, shipments: true, proformas: { orderBy: { version: 'desc' }, take: 1 } } });
        if (!o) return 'سفارشی با این شماره برای این مشتری نیست.';
        const b = this.orders.breakdown(o);
        return JSON.stringify({
          number: o.number, status: STATUS_FA[o.status],
          items: o.items.map(i => ({ name: i.title, quantity: i.quantity, packs: i.packs, unitPrice: formatRial(i.unitPrice) })),
          subtotal: formatRial(b.subtotal), discount: b.discount ? formatRial(b.discount) : null, freight: b.shipping ? formatRial(b.shipping) : null,
          cash: `${b.cashPercent}٪: ${formatRial(b.cash)}${b.cashDiscount ? ` (تخفیف نقدی ${b.cashDiscountPct}٪)` : ''}`,
          cheque: b.cheque ? `${100 - b.cashPercent}٪: ${formatRial(b.cheque)}${b.chequeMarkup ? ` (افزایش چکی ${b.chequeMarkupPct}٪)` : ''}` : null,
          cheques: b.cheques.map(c => ({ amount: formatRial(c.amount), days: c.days })), payable: formatRial(b.total),
          proformaExpires: o.status === 'PROFORMA_SENT' && o.proformas[0] ? o.proformas[0].expiresAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : null,
          shipments: o.shipments.map(sh => ({ date: sh.shippedAt.toLocaleDateString('fa-IR'), carrier: sh.carrier, waybillNo: sh.waybillNo, driver: sh.driverName, driverPhone: sh.driverPhone, plate: sh.plate, freight: sh.freight !== null ? formatRial(sh.freight) : null })),
        });
      },
    });
    const answerProforma = tool({
      name: 'answer_proforma', description: 'پاسخ مشتری به پیش‌فاکتور نهایی: ok=true تأیید (فقط با تأیید صریح مشتری)، ok=false یعنی تغییر می‌خواهد (comment = تغییر موردنظر).',
      parameters: z.object({ number: z.number().int(), ok: z.boolean(), comment: z.string().nullable() }),
      execute: async ({ number, ok, comment }) => {
        const o = await this.prisma.order.findFirst({ where: { number, ...visible }, select: { id: true } });
        if (!o) return 'سفارشی با این شماره برای این مشتری نیست.';
        try { const r = await this.orders.customerDecide(userId, o.id, ok, comment ?? undefined); return `ثبت شد؛ وضعیت: ${r.statusFa}`; } catch (e) { return `ثبت نشد: ${(e as Error).message}`; }
      },
    });
    const myAccount = tool({
      name: 'my_account', description: 'حساب مالی مشتری: مانده‌ی بدهی، جمع فاکتورها و دریافتی‌ها، چک‌های در جریان با سررسید، آخرین فاکتورها.',
      parameters: z.object({}),
      execute: async () => {
        if (!owned.length) return 'حساب مالی فقط برای مدیر حساب یا کاربر مشاهده قابل دیدن است؛ بگو از مدیر حسابشان بپرسد یا handoff کن.';
        const a = await this.acc.account(owned[0]);
        return JSON.stringify({
          customer: a.customer.name, balance: formatRial(a.summary.balance), invoiced: formatRial(a.summary.invoiced), paid: formatRial(a.summary.paid),
          pendingCheques: formatRial(a.summary.pendingCheques), balanceAfterCheques: formatRial(a.summary.balanceAfterCheques), waitingReview: a.summary.reported ? formatRial(a.summary.reported) : null,
          cheques: a.payments.filter(p => p.method === 'CHEQUE' && ['PENDING', 'BOUNCED', 'REPORTED'].includes(p.status)).slice(0, 10).map(p => ({ amount: formatRial(p.amount), due: p.dueDate?.toLocaleDateString('fa-IR') ?? null, number: p.chequeNumber, status: PAY_STATUS_FA[p.status] })),
          lastPayments: a.payments.filter(p => p.status === 'CLEARED').slice(0, 5).map(p => ({ amount: formatRial(p.amount), method: METHOD_FA[p.method], date: p.receivedAt.toLocaleDateString('fa-IR') })),
          lastInvoices: a.invoices.filter(i => i.status === 'ISSUED').slice(0, 5).map(i => ({ number: i.number, total: formatRial(i.total), date: i.issuedAt.toLocaleDateString('fa-IR'), order: i.order?.number ?? null })),
        });
      },
    });
    const submit = tool({
      name: 'submit_order', description: 'پیش‌نویس فعلی را به‌عنوان پیش‌فاکتور ثبت می‌کند. فقط بعد از تأیید صریح مشتری. برای مشتری جدید companyName لازم است.',
      parameters: z.object({ companyName: z.string().nullable(), note: z.string().nullable() }),
      execute: async ({ companyName, note }) => {
        if (!draftId) return 'پیش‌نویسی نیست؛ اول set_draft.';
        const d = await this.prisma.assistantDraft.findUnique({ where: { id: draftId } });
        const items = (d?.items as unknown as DraftLine[] | undefined) ?? [];
        if (!items.length) return 'پیش‌نویس خالی است.';
        const ms = user.memberships.filter(m => m.role === 'OWNER' || m.role === 'BUYER');
        if (!ms.length && user.memberships.length) return 'این کاربر اجازه‌ی ثبت سفارش ندارد؛ handoff کن.';
        if (!ms.length && !companyName?.trim()) return 'NEED_COMPANY_NAME: نام فروشگاه یا شرکت را از مشتری بپرس.';
        try {
          const o = await this.orders.create(userId, {
            customerId: ms[0]?.customerId, newCustomer: ms.length ? undefined : { name: companyName!.trim() },
            items: items.map(i => ({ variantId: i.variantId, quantity: i.quantity, ...(i.packs ? { packs: i.packs } : {}) })),
            idempotencyKey: `draft:${draftId}`, note: [note?.trim(), 'ثبت توسط ایجنت فروش در گفتگو'].filter(Boolean).join('\n'),
          }, 'agent');
          await this.prisma.assistantDraft.update({ where: { id: draftId }, data: { usedAt: new Date() } });
          orderNumber = o.number;
          return `ثبت شد: پیش‌فاکتور ${o.number}، وضعیت: ${o.statusFa}`;
        } catch (e) { return `ثبت نشد: ${(e as Error).message}`; }
      },
    });
    const toHuman = tool({
      name: 'handoff', description: 'گفتگو را به کارشناس فروش انسانی می‌سپارد؛ از این به بعد کارشناس جواب می‌دهد.',
      parameters: z.object({ reason: z.string() }),
      execute: async ({ reason }) => { handoff = reason.slice(0, 200); return 'سپرده شد.'; },
    });

    const history = await this.prisma.message.findMany({ where: { conversationId: conv.id, id: { not: msg.id } }, orderBy: { createdAt: 'desc' }, take: 16 });
    const transcript = history.reverse().map(m => `${m.direction === 'IN' ? 'مشتری' : m.text?.startsWith(AI_PREFIX) ? 'تو' : 'کارشناس'}: ${(m.text ?? `[${m.kind}]`).replace(AI_PREFIX, '').slice(0, 600)}`).join('\n');
    const current = draftId ? await this.ai.view(draftId, userId, customerId).catch(() => null) : null;
    const context = [
      `مشتری: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || 'بی‌نام'}${account ? ` · ${account.name}${account.isApproved ? '' : ' (حساب هنوز تأیید نشده)'}` : ' · هنوز حساب مشتری ندارد (برای اولین سفارش نام فروشگاه لازم است)'}`,
      account?.terms ? `شرایط پرداخت: ${account.terms.cashPercent}٪ نقد${Number(account.terms.cashDiscountPct) ? ` با ${account.terms.cashDiscountPct}٪ تخفیف نقدی` : ''}${account.terms.cashPercent < 100 ? `، ${100 - account.terms.cashPercent}٪ چک${account.terms.chequeDueDays.length ? ` ${account.terms.chequeDueDays.join('/')} روزه` : ''}${Number(account.terms.chequeMarkupPct) ? ` با ${account.terms.chequeMarkupPct}٪ افزایش` : ''}` : ''}` : '',
      account?.categoryDiscounts.length ? `تخفیف اختصاصی این مشتری: ${account.categoryDiscounts.map(d => `${d.category.name} ${Number(d.pct)}٪`).join('، ')}. قیمت search_catalog قیمت لیست است؛ قیمت با تخفیف مشتری در نتیجه‌ی set_draft می‌آید و همان را بگو.` : '',
      current?.lines.length ? `پیش‌نویس فعلی: ${current.lines.map(l => `${l.name} ${l.label} × ${l.quantity}`).join('، ')}` : 'پیش‌نویس فعلی: خالی',
      transcript ? `گفتگوی قبلی:\n${transcript}` : '',
      `پیام جدید مشتری: ${text}`,
    ].filter(Boolean).join('\n\n');

    let reply: string;
    try {
      const agent = new Agent({ name: 'iPlast sales agent', instructions: INSTRUCTIONS, tools: [search, setDraft, myOrders, orderDetail, answerProforma, myAccount, submit, toHuman], outputType: z.object({ reply: z.string() }), ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}) });
      const r = await run(agent, context, { maxTurns: 12 });
      reply = (r.finalOutput as { reply: string }).reply.trim();
    } catch (e) {
      this.log.warn(`agent failed: ${(e as Error).message}`);
      handoff = 'ایجنت پاسخ نداد';
      reply = 'پیامتان را برای کارشناس فروش فرستادم؛ به‌زودی جواب می‌دهد.';
    }
    if (handoff) await this.handoff(conv.id, handoff);
    const draft = draftId && !orderNumber ? await this.ai.view(draftId, userId, customerId).catch(() => null) : null;
    return this.say(base, reply, { heard, draft: draft?.lines.length ? draft : null, orderNumber, handoff });
  }

  private async say(base: { conversationId: string; messageId: string }, reply: string, extra: Partial<AgentTurn>): Promise<AgentTurn> {
    await this.prisma.message.create({ data: { conversationId: base.conversationId, direction: 'OUT', kind: 'TEXT', text: AI_PREFIX + reply } });
    return { mode: 'ai', ...base, reply, ...extra };
  }

  /** Hands the chat to a person: the customer's agent (or a sales agent) gets a summary in Telegram. */
  async handoff(conversationId: string, reason: string) {
    const conv = await this.prisma.conversation.update({ where: { id: conversationId }, data: { handoffAt: new Date(), handoffReason: reason }, include: { customer: { select: { name: true, support: { select: { id: true, telegramId: true, isActive: true } } } }, messages: { orderBy: { createdAt: 'desc' }, take: 6 } } });
    const user = await this.prisma.user.findUnique({ where: { telegramId: conv.userTelegramId } });
    const agent = await this.agentFor(conv.assigneeId, conv.customer?.support?.isActive ? conv.customer.support : null);
    if (!agent) return;
    if (!conv.assigneeId) await this.prisma.conversation.update({ where: { id: conversationId }, data: { assigneeId: agent.id } });
    const who = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'مشتری';
    const last = conv.messages.reverse().map(m => `${m.direction === 'IN' ? '👤' : m.text?.startsWith(AI_PREFIX) ? '🤖' : '🧑‍💼'} ${(m.text ?? `[${m.kind}]`).replace(AI_PREFIX, '').slice(0, 300)}`).join('\n');
    const id = await this.tg.sendForId(agent.telegramId, `🙋 گفتگوی ${who}${conv.customer ? ` · ${conv.customer.name}` : ''} به شما سپرده شد.\nدلیل: ${reason}\n\n${last}\n\nبرای پاسخ روی همین پیام Reply بزنید یا از پنل مدیریت ← گفتگوها جواب دهید.`);
    const lastIn = conv.messages.filter(m => m.direction === 'IN').at(-1);
    if (id && lastIn) await this.prisma.message.update({ where: { id: lastIn.id }, data: { relayChatId: agent.telegramId, relayMessageId: id } });
  }

  /** Back to the AI agent (from the admin panel). */
  async resume(conversationId: string) {
    return this.prisma.conversation.update({ where: { id: conversationId }, data: { handoffAt: null, handoffReason: null } });
  }

  /** Who answers a handed-off chat: the assigned person, else the customer's fixed agent, else a sales agent, else a manager. */
  async agentFor(assigneeId: string | null, fixed: { id: string; telegramId: bigint } | null) {
    if (assigneeId) {
      const a = await this.prisma.user.findUnique({ where: { id: assigneeId } });
      if (a?.isActive && a.staffRole) return a;
    }
    if (fixed) return this.prisma.user.findUnique({ where: { id: fixed.id } });
    const pool = await this.prisma.user.findMany({ where: { staffRole: 'SALES', isActive: true } });
    const list = pool.length ? pool : await this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } });
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }
}
