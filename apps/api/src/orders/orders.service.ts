import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrderStatus } from '@iplast/db';
import { Breakdown, PayMode, SaleTerms, formatRial, netPrice, orderBreakdown, payModeFa, toFaDigits } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { int, req, rialOf } from '../common/validate';
import { modeFor, quote, saleTerms } from './pricing';

export interface OrderInput {
  customerId?: string;
  newCustomer?: { name?: string; city?: string };
  items?: { variantId?: string; quantity?: number; packs?: number }[];
  note?: string;
  idempotencyKey?: string;
  /** CASH (نقدی) or TERM (مدت‌دار); defaults to the customer's first allowed mode. */
  payMode?: string;
}

export const STATUS_FA: Record<OrderStatus, string> = {
  SUBMITTED: 'پیش‌فاکتور ثبت شد', SALES_REVIEW: 'در بررسی کارشناس فروش', SALES_APPROVED: 'تأیید کارشناس؛ منتظر تأیید نهایی مدیر', NEEDS_FIX: 'نیاز به اصلاح', PROFORMA_SENT: 'پیش‌فاکتور نهایی؛ منتظر تأیید مشتری',
  PROFORMA_EXPIRED: 'پیش‌فاکتور منقضی شد', CONFIRMED: 'تأیید نهایی؛ ارسال به انبار', PREPARING: 'در حال آماده‌سازی', SHIPPED: 'ارسال شد',
  DELIVERED: 'تحویل شد', REJECTED: 'رد شد', CANCELLED: 'لغو شد',
};

/** Statuses in which the sales agent can still price, change, approve, send back or reject a proforma. */
export const AGENT_OPEN: OrderStatus[] = ['SUBMITTED', 'SALES_REVIEW', 'NEEDS_FIX', 'PROFORMA_SENT', 'PROFORMA_EXPIRED'];

/** What the sales agent may change before approving: cash or term sale, per-line price and quantity, drop a line, discount, freight. */
export interface ProformaEdit {
  payMode?: unknown;
  termMonths?: unknown;
  items?: { id?: string; quantity?: unknown; unitPrice?: unknown; remove?: boolean }[];
  discount?: unknown;
  shipping?: unknown;
}

/** A breakdown as plain strings, for JSON. */
export const bdJson = (b: Breakdown) => JSON.parse(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export function breakdownText(b: Breakdown, dueFrom = new Date()) {
  const L: string[] = [`نوع فروش: ${payModeFa(b.mode, b.termMonths)}`];
  if (b.saleDiscount) L.push(`جمع به قیمت لیست: ${formatRial(b.listTotal)}`, `تخفیف ${b.mode === 'CASH' ? 'نقدی' : 'مدت‌دار'}: ${formatRial(b.saleDiscount)}`);
  L.push(`جمع اقلام: ${formatRial(b.subtotal)}`);
  if (b.discount) L.push(`تخفیف کارشناس: ${formatRial(b.discount)}`);
  if (b.shipping) L.push(`کرایه: ${formatRial(b.shipping)}`);
  L.push(`مبلغ کل: ${formatRial(b.total)}`);
  for (const c of b.cheques) {
    const due = c.days === null ? '' : ` با سررسید ${toFaDigits(b.termMonths)} ماه بعد (${new Date(dueFrom.getTime() + c.days * 86400000).toLocaleDateString('fa-IR')})`;
    L.push(`پرداخت: چک ${formatRial(c.amount)}${due}${b.cash ? ` و نقد ${formatRial(b.cash)} (کرایه)` : ''}`);
  }
  if (!b.cheques.length) L.push(`پرداخت: نقد ${formatRial(b.cash)}`);
  return L.join('\n');
}

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Orders');
  private timer?: NodeJS.Timeout;
  /** Set by AccountingService: issues the invoice once an order gets the final approval. */
  onConfirmed?: (byUserId: string, orderId: string) => Promise<void>;
  /** Jobs other services run on the same 10-minute clock (cheque reminders). */
  readonly ticks: (() => Promise<void>)[] = [];

  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const run = async () => {
      for (const job of [() => this.expireProformas(), ...this.ticks]) await job().catch(e => this.log.warn(`tick: ${(e as Error).message}`));
    };
    this.timer = setInterval(run, 10 * 60_000);
    setTimeout(run, 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Hours a proforma stays valid for the customer to accept (Setting proforma.ttlHours, default 48). */
  async ttlHours() {
    const s = await this.prisma.setting.findUnique({ where: { key: 'proforma.ttlHours' } });
    const n = Number(s?.value ?? process.env.PROFORMA_TTL_HOURS ?? 48);
    return Number.isFinite(n) && n >= 1 && n <= 24 * 30 ? n : 48;
  }

  breakdown(o: { items: { quantity: number; unitPrice: bigint | null; listPrice?: bigint | null }[]; payMode: PayMode; termMonths: number; discount: bigint; shipping: bigint }) {
    return orderBreakdown(o.items, o.payMode, o.termMonths, o.discount, o.shipping);
  }

  /** Everyone on the customer's side who should hear about a proforma: who placed it and the account owners. */
  private async customerChats(orderId: string) {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { placedBy: true, customer: { include: { members: { where: { role: 'OWNER' }, include: { user: true } } } } } });
    return [...new Set([String(o.placedBy.telegramId), ...o.customer.members.map(m => String(m.user.telegramId))])];
  }

  /** Customer accounts the user may order for (OWNER or BUYER). */
  private async orderableCustomer(userId: string, customerId?: string) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId, role: { in: ['OWNER', 'BUYER'] } } });
    if (customerId) {
      if (!ms.some(m => m.customerId === customerId)) throw new ForbiddenException('شما عضو این حساب مشتری نیستید');
      return customerId;
    }
    return ms.length === 1 ? ms[0].customerId : null;
  }

  async create(userId: string, input: OrderInput, channel = 'miniapp') {
    const items = req(input.items, 'سبد خالی است');
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new BadRequestException('سبد خالی است');
    if (input.idempotencyKey) {
      const dup = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (dup) return this.get(userId, dup.id);
    }
    let customerId = await this.orderableCustomer(userId, input.customerId);
    if (!customerId) {
      const existing = await this.prisma.customerMember.count({ where: { userId } });
      if (existing) throw new BadRequestException('حساب مشتری را انتخاب کنید');
      const name = req(input.newCustomer?.name, 'نام فروشگاه یا شرکت را وارد کنید').trim().slice(0, 120);
      const c = await this.prisma.customer.create({
        data: { name, city: input.newCustomer?.city?.slice(0, 60), members: { create: { userId, role: 'OWNER' } } },
      });
      customerId = c.id;
    }
    const lines = items.map(i => ({ variantId: req(i.variantId, 'کالا نامعتبر است'), quantity: int(i.quantity, 'تعداد نامعتبر است', 1, 1_000_000), packs: i.packs === undefined ? null : int(i.packs, 'تعداد کارتن نامعتبر است', 1, 100_000) }));
    const terms = await saleTerms(this.prisma, customerId);
    const payMode = modeFor(terms, input.payMode);
    const q = await quote(this.prisma, lines.map(l => l.variantId), customerId, payMode, terms);
    for (const l of lines) if (!q.has(l.variantId)) throw new BadRequestException('یکی از کالاها موجود نیست');
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    const order = await this.prisma.order.create({
      data: {
        customerId, placedById: userId, channel, note: input.note?.slice(0, 1000), idempotencyKey: input.idempotencyKey,
        priceListId: list?.id,
        termsSnapshot: terms as object, payMode, termMonths: payMode === 'TERM' ? terms.termMonths : 0,
        items: { create: lines.map(l => { const x = q.get(l.variantId)!; return { variantId: l.variantId, title: x.title, quantity: l.quantity, packs: l.packs, unitPrice: x.unitPrice, listPrice: x.listPrice, salePct: x.own || x.listPrice === null ? null : x.pct, priceStatus: x.unitPrice === null ? 'INQUIRY' : 'PRICED' }; }) },
        events: { create: { status: 'SUBMITTED', byUserId: userId } },
      },
      include: { items: true, customer: { include: { support: true } }, placedBy: true },
    });
    await this.notifyNewOrder(order.id);
    return this.get(userId, order.id);
  }

  orderTotal(items: { quantity: number; unitPrice: bigint | null }[]) {
    return items.reduce((s, i) => s + (i.unitPrice ?? 0n) * BigInt(i.quantity), 0n);
  }

  /** Who handles a customer's orders: their own sales agent, else every active sales agent, else the managers. */
  async salesAgentsOf(customerId: string) {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId }, include: { support: true } });
    if (c?.support?.isActive && c.support.staffRole) return [c.support];
    const sales = await this.prisma.user.findMany({ where: { staffRole: 'SALES', isActive: true } });
    if (sales.length) return sales;
    return this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } });
  }
  private admins() { return this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } }); }

  private async orderText(orderId: string, head: string) {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, customer: true, placedBy: true } });
    const b = this.breakdown(o);
    const inq = o.items.filter(i => i.unitPrice === null).length;
    const who = [o.placedBy.firstName, o.placedBy.lastName].filter(Boolean).join(' ') || `کاربر ${o.placedBy.telegramId}`;
    const lines = o.items.slice(0, 40).map((i, n) => `${n + 1}. ${i.title} — ${i.packs ? `${i.packs} بسته (${i.quantity})` : i.quantity}${i.unitPrice === null ? ' — استعلامی' : ` × ${formatRial(i.unitPrice)}`}`);
    if (o.items.length > 40) lines.push(`… و ${o.items.length - 40} قلم دیگر`);
    return { o, b, text: `${head} #${o.number}\nمشتری: ${o.customer.name}\nثبت‌کننده: ${who}${o.placedBy.username ? ` (@${o.placedBy.username})` : ''}\n\n${lines.join('\n')}\n\n${o.items.length} قلم${inq ? ` (${inq} استعلامی، قیمت را کارشناس می‌گذارد)` : ''}\n${breakdownText(b)}${o.note ? `\nتوضیح: ${o.note}` : ''}` };
  }

  /** Step 1: the customer's sales agent gets the proforma with approve / reject buttons (handled by the bot). */
  private async notifyNewOrder(orderId: string) {
    const { o, text } = await this.orderText(orderId, '🧾 پیش‌فاکتور جدید');
    const agents = await this.salesAgentsOf(o.customerId);
    const kb = { inline_keyboard: [[
      { text: '✅ تأیید کارشناس', callback_data: `os:${o.id}:sales_ok` },
      { text: '❌ رد', callback_data: `os:${o.id}:reject` },
    ]] };
    for (const a of agents) await this.tg.send(a.telegramId, `${text}\n\nبعد از هماهنگی با مشتری، تأیید کنید تا برای تأیید نهایی مدیر برود.`, kb);
    for (const id of (process.env.SUPPORT_TELEGRAM_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean))
      if (!agents.some(a => String(a.telegramId) === id)) await this.tg.send(id, text, kb);
    const agent = agents.length === 1 && agents[0].staffRole === 'SALES' ? [agents[0].firstName, agents[0].lastName].filter(Boolean).join(' ') : '';
    await this.tg.send(o.placedBy.telegramId, `پیش‌فاکتور #${o.number} ثبت شد و برای ${agent ? `کارشناس فروش شما، ${agent}،` : 'کارشناس فروش'} ارسال شد.\nبرای هماهنگی قیمت، تحویل و پرداخت، همین‌جا در ربات پیام یا ویس بدهید؛ مستقیم به کارشناس‌تان می‌رسد.`);
  }

  /** After the final approval the order goes to the warehouse (or the managers when no warehouse user is defined). */
  private async notifyWarehouse(orderId: string, approvedBy: string) {
    const { o, text } = await this.orderText(orderId, `📦 سفارش تأییدشده برای انبار (تأیید نهایی: ${approvedBy})`);
    let to = await this.prisma.user.findMany({ where: { staffRole: 'WAREHOUSE', isActive: true } });
    if (!to.length) to = await this.admins();
    const kb = { inline_keyboard: [[
      { text: '📦 در حال آماده‌سازی', callback_data: `os:${o.id}:prep` },
      { text: '🚚 ارسال شد', callback_data: `os:${o.id}:ship` },
    ]] };
    for (const w of to) await this.tg.send(w.telegramId, `${text}\n\nبعد از بارگیری «ارسال شد» را بزنید تا به مشتری خبر داده شود. شماره‌ی بارنامه را می‌توانید در پنل ثبت کنید.`, kb);
    if (o.customer.supportId) {
      const sup = await this.prisma.user.findUnique({ where: { id: o.customer.supportId } });
      if (sup?.isActive) await this.tg.send(sup.telegramId, `✅ پیش‌فاکتور #${o.number} (${o.customer.name}) تأیید نهایی شد و برای انبار رفت.`);
    }
  }

  /**
   * The approval chain. 1) The customer's sales agent prices inquiry lines, may change quantities, drop lines, add a
   * discount or freight, and approves («تأیید کارشناس»). 2) If the agent changed anything, the customer gets the final
   * proforma and accepts it (it expires after ttlHours). 3) A manager gives the final approval, the invoice is issued
   * and the order goes to the warehouse. A manager may approve directly only when there are no sales agents at all.
   */
  async decide(byUserId: string, orderId: string, action: string, comment?: string, edit?: ProformaEdit): Promise<{ status: OrderStatus }> {
    const [u, o] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: byUserId } }),
      this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: true } }),
    ]);
    if (!o) throw new NotFoundException();
    if (!u?.staffRole || !u.isActive) throw new ForbiddenException('دسترسی ندارید');
    const isAdmin = u.staffRole === 'ADMIN';
    const note = comment?.trim().slice(0, 1000) || undefined;
    const by = [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.staffRole === 'ADMIN' ? 'مدیر' : 'کارشناس');
    const ownAgent = () => { if (!isAdmin && o.customer.supportId && o.customer.supportId !== u.id) throw new ForbiddenException('این مشتری کارشناس دیگری دارد'); };
    if (action === 'sales_ok') {
      if (!AGENT_OPEN.includes(o.status)) throw new BadRequestException(o.status === 'SALES_APPROVED' ? 'قبلاً تأیید کارشناس خورده است' : 'این پیش‌فاکتور دیگر منتظر تأیید کارشناس نیست');
      if (u.staffRole === 'WAREHOUSE') throw new ForbiddenException('تأیید پیش‌فاکتور با کارشناس فروش است');
      ownAgent();
      const changed = await this.applyEdit(byUserId, o, edit);
      const fresh = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      const missing = fresh.items.filter(i => i.unitPrice === null);
      if (missing.length) throw new BadRequestException(`قیمت ${missing.length} قلم استعلامی را وارد کنید (در پنل مدیریت ← سفارش‌ها ← منتظر کارشناس)`);
      const b = this.breakdown(fresh);
      const last = await this.prisma.proforma.findFirst({ where: { orderId }, orderBy: { version: 'desc' } });
      const askCustomer = changed || o.status === 'PROFORMA_SENT' || o.status === 'PROFORMA_EXPIRED';
      const expiresAt = new Date(Date.now() + (await this.ttlHours()) * 3600_000);
      const pf = await this.prisma.proforma.create({
        data: {
          orderId, version: (last?.version ?? 0) + 1, total: b.total, issuedBy: byUserId, expiresAt, changed: askCustomer,
          acceptedAt: askCustomer ? null : new Date(), breakdown: bdJson(b),
          items: fresh.items.map(i => ({ title: i.title, quantity: i.quantity, packs: i.packs, unitPrice: i.unitPrice?.toString() ?? null, listPrice: i.listPrice?.toString() ?? null })),
        },
      });
      if (askCustomer) {
        await this.prisma.order.update({ where: { id: orderId }, data: { status: 'PROFORMA_SENT', events: { create: { status: 'PROFORMA_SENT', byUserId, comment: note } } } });
        const { text } = await this.orderText(orderId, `🧾 پیش‌فاکتور نهایی (نسخه ${pf.version})`);
        const kb = { inline_keyboard: [
          ...(process.env.MINIAPP_URL ? [[{ text: '📄 مشاهده پیش‌فاکتور', web_app: { url: `${process.env.MINIAPP_URL}?pf=${orderId}` } }]] : []),
          [{ text: '✅ تأیید پیش‌فاکتور', callback_data: `pf:${orderId}:ok` }, { text: '✏️ تغییر می‌خواهم', callback_data: `pf:${orderId}:no` }],
        ] };
        const until = expiresAt.toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
        for (const t of await this.customerChats(orderId)) await this.tg.send(t, `${text}${note ? `\nتوضیح کارشناس: ${note}` : ''}\n\nکارشناس فروش قیمت‌ها را نهایی کرده است. لطفاً تا ${until} تأیید کنید؛ بعد از آن پیش‌فاکتور منقضی می‌شود.`, kb);
        return { status: 'PROFORMA_SENT' as OrderStatus };
      }
      await this.setStatus(byUserId, orderId, 'SALES_APPROVED', note);
      await this.toManagers(orderId, `✅ تأیید کارشناس (${by}) — منتظر تأیید نهایی`, note, byUserId);
      if (isAdmin && (await this.admins()).length === 1) return this.decide(byUserId, orderId, 'final_ok', note);
      return { status: 'SALES_APPROVED' as OrderStatus };
    }
    if (action === 'final_ok') {
      if (!isAdmin) throw new ForbiddenException('تأیید نهایی با مدیر است');
      const noSales = !(await this.prisma.user.count({ where: { staffRole: 'SALES', isActive: true } }));
      if (o.status !== 'SALES_APPROVED') {
        if (!(noSales && AGENT_OPEN.includes(o.status))) throw new BadRequestException(o.status === 'PROFORMA_SENT' ? 'هنوز مشتری پیش‌فاکتور را تأیید نکرده است' : 'اول کارشناس فروش باید تأیید کند');
        if (o.items.some(i => i.unitPrice === null)) throw new BadRequestException('اول قیمت اقلام استعلامی را بگذارید');
      }
      await this.setStatus(byUserId, orderId, 'CONFIRMED', note);
      if (this.onConfirmed) await this.onConfirmed(byUserId, orderId).catch(e => this.log.warn(`auto invoice #${o.number}: ${(e as Error).message}`));
      await this.notifyWarehouse(orderId, by);
      return { status: 'CONFIRMED' as OrderStatus };
    }
    if (action === 'prep' || action === 'ship' || action === 'delivered') {
      if (!isAdmin && u.staffRole !== 'WAREHOUSE') throw new ForbiddenException('این کار با انبار یا مدیر است');
      const from: Record<string, OrderStatus[]> = { prep: ['CONFIRMED'], ship: ['CONFIRMED', 'PREPARING'], delivered: ['SHIPPED'] };
      const to: Record<string, OrderStatus> = { prep: 'PREPARING', ship: 'SHIPPED', delivered: 'DELIVERED' };
      if (!from[action].includes(o.status)) throw new BadRequestException(`این سفارش الان «${STATUS_FA[o.status]}» است`);
      await this.setStatus(byUserId, orderId, to[action], note);
      if (action === 'ship' && o.customer.supportId) {
        const sup = await this.prisma.user.findUnique({ where: { id: o.customer.supportId } });
        if (sup?.isActive) await this.tg.send(sup.telegramId, `🚚 سفارش #${o.number} (${o.customer.name}) ارسال شد.${note ? `\n${note}` : ''}`);
      }
      return { status: to[action] };
    }
    if (action === 'fix' || action === 'reject') {
      if (![...AGENT_OPEN, 'SALES_APPROVED'].includes(o.status)) throw new BadRequestException('این سفارش دیگر قابل تغییر نیست');
      if (u.staffRole === 'WAREHOUSE') throw new ForbiddenException('دسترسی ندارید');
      ownAgent();
      if (action === 'fix' && !note) throw new BadRequestException('بنویسید چه چیزی باید اصلاح شود');
      const status: OrderStatus = action === 'fix' ? 'NEEDS_FIX' : 'REJECTED';
      await this.setStatus(byUserId, orderId, status, note);
      return { status };
    }
    throw new BadRequestException('کار نامعتبر است');
  }

  /** Writes the agent's changes to the order lines. Returns true when anything that changes the money changed. */
  private async applyEdit(byUserId: string, o: { id: string; customerId: string; discount: bigint; shipping: bigint; payMode: PayMode; termMonths: number; termsSnapshot: unknown; items: { id: string; variantId: string; title: string; quantity: number; unitPrice: bigint | null; listPrice: bigint | null; salePct: unknown }[] }, e?: ProformaEdit) {
    let changed = o.items.some(i => i.unitPrice === null);
    if (!e) return changed;
    if (e.payMode !== undefined && e.payMode !== '' && e.payMode !== null) {
      if (e.payMode !== 'CASH' && e.payMode !== 'TERM') throw new BadRequestException('نوع فروش نامعتبر است');
      const t = (o.termsSnapshot && typeof o.termsSnapshot === 'object' && 'termMonths' in o.termsSnapshot ? o.termsSnapshot : await saleTerms(this.prisma, o.customerId)) as SaleTerms & { termMonths: number };
      const months = e.payMode === 'CASH' ? 0 : e.termMonths !== undefined && e.termMonths !== '' ? int(Number(String(e.termMonths).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))), 'مدت (ماه) نامعتبر است', 1, 36) : o.payMode === 'TERM' && o.termMonths ? o.termMonths : t.termMonths || 3;
      if (e.payMode !== o.payMode || months !== o.termMonths) {
        changed = true;
        await this.prisma.order.update({ where: { id: o.id }, data: { payMode: e.payMode, termMonths: months } });
        if (e.payMode !== o.payMode) {
          // reprice from the list price with the other percentage; personal prices and prices the agent typed stay
          const q = await quote(this.prisma, o.items.map(i => i.variantId), o.customerId, e.payMode, t);
          for (const it of o.items) {
            const x = q.get(it.variantId);
            if (!x || x.own || it.listPrice === null || it.salePct === null) continue;
            const unitPrice = netPrice(it.listPrice, x.pct);
            await this.prisma.orderItem.update({ where: { id: it.id }, data: { unitPrice, salePct: x.pct, priceStatus: 'PRICED' } });
            it.unitPrice = unitPrice;
          }
        }
      }
    }
    const byId = new Map(o.items.map(i => [i.id, i]));
    const ops: Promise<unknown>[] = [];
    const keep = new Set(o.items.map(i => i.id));
    for (const x of e.items ?? []) {
      const it = byId.get(String(x.id));
      if (!it) throw new BadRequestException('قلم نامعتبر است');
      if (x.remove) { keep.delete(it.id); changed = true; ops.push(this.prisma.orderItem.delete({ where: { id: it.id } })); continue; }
      const data: { quantity?: number; packs?: null; unitPrice?: bigint; priceStatus?: 'PRICED'; salePct?: null } = {};
      if (x.quantity !== undefined && x.quantity !== '') {
        const q = int(Number(String(x.quantity).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))), `تعداد «${it.title}» نامعتبر است`, 1, 1_000_000);
        if (q !== it.quantity) { data.quantity = q; data.packs = null; }
      }
      if (x.unitPrice !== undefined && x.unitPrice !== '' && x.unitPrice !== null) {
        const p = rialOf(x.unitPrice, `قیمت «${it.title}»`);
        if (p !== it.unitPrice) { data.unitPrice = p; data.priceStatus = 'PRICED'; data.salePct = null; }
      }
      if (Object.keys(data).length) { changed = true; ops.push(this.prisma.orderItem.update({ where: { id: it.id }, data })); }
    }
    if (!keep.size) throw new BadRequestException('همه‌ی اقلام حذف شده‌اند؛ اگر سفارش انجام نمی‌شود «رد» را بزنید');
    const discount = e.discount === undefined || e.discount === '' ? o.discount : rialOf(e.discount, 'تخفیف', true);
    const shipping = e.shipping === undefined || e.shipping === '' ? o.shipping : rialOf(e.shipping, 'کرایه', true);
    if (discount !== o.discount || shipping !== o.shipping) { changed = true; ops.push(this.prisma.order.update({ where: { id: o.id }, data: { discount, shipping } })); }
    await Promise.all(ops);
    void byUserId;
    return changed;
  }

  private async toManagers(orderId: string, head: string, note: string | undefined, exceptUserId?: string) {
    const { o, text } = await this.orderText(orderId, head);
    const kb = { inline_keyboard: [[{ text: '✅ تأیید نهایی', callback_data: `os:${o.id}:final_ok` }, { text: '❌ رد', callback_data: `os:${o.id}:reject` }]] };
    for (const a of await this.admins()) if (a.id !== exceptUserId) await this.tg.send(a.telegramId, `${text}${note ? `\nتوضیح: ${note}` : ''}`, kb);
    await this.tg.sms(`اصفهان پلاست: پیش‌فاکتور ${o.number} (${o.customer.name}) منتظر تأیید نهایی شماست.`);
  }

  /** The customer accepts the final proforma (mini app or bot button), or asks for a change. */
  async customerDecide(userId: string, orderId: string, ok: boolean, comment?: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, proformas: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!o) throw new NotFoundException();
    const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: o.customerId, userId } } });
    if (o.placedById !== userId && m?.role !== 'OWNER') throw new ForbiddenException('فقط ثبت‌کننده‌ی سفارش یا مدیر حساب می‌تواند تأیید کند');
    if (o.status === 'PROFORMA_EXPIRED') throw new BadRequestException('این پیش‌فاکتور منقضی شده است؛ از کارشناس فروش بخواهید دوباره بفرستد');
    if (o.status !== 'PROFORMA_SENT') throw new BadRequestException(`این سفارش الان «${STATUS_FA[o.status]}» است`);
    const pf = o.proformas[0];
    const note = comment?.trim().slice(0, 500) || undefined;
    const agents = await this.salesAgentsOf(o.customerId);
    if (!ok) {
      await this.setStatus(userId, orderId, 'NEEDS_FIX', note ? `مشتری تغییر می‌خواهد: ${note}` : 'مشتری تغییر می‌خواهد');
      for (const a of agents) await this.tg.send(a.telegramId, `✏️ مشتری «${o.customer.name}» پیش‌فاکتور #${o.number} را نپذیرفت و تغییر می‌خواهد.${note ? `\n${note}` : ''}\nدر پنل مدیریت اصلاح کنید و دوباره بفرستید.`);
      return { status: 'NEEDS_FIX' as OrderStatus, statusFa: STATUS_FA.NEEDS_FIX, number: o.number };
    }
    if (pf && pf.expiresAt < new Date()) { await this.expire(o.id); throw new BadRequestException('مهلت تأیید این پیش‌فاکتور تمام شده است'); }
    if (pf) await this.prisma.proforma.update({ where: { id: pf.id }, data: { acceptedAt: new Date() } });
    await this.setStatus(userId, orderId, 'SALES_APPROVED', 'مشتری پیش‌فاکتور را تأیید کرد');
    for (const a of agents) await this.tg.send(a.telegramId, `👍 مشتری «${o.customer.name}» پیش‌فاکتور #${o.number} را تأیید کرد؛ برای تأیید نهایی مدیر رفت.`);
    await this.toManagers(orderId, '✅ تأیید کارشناس و مشتری — منتظر تأیید نهایی', undefined);
    return { status: 'SALES_APPROVED' as OrderStatus, statusFa: STATUS_FA.SALES_APPROVED, number: o.number };
  }

  private async expire(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
    if (!o || o.status !== 'PROFORMA_SENT') return;
    await this.setStatus(o.placedById, orderId, 'PROFORMA_EXPIRED', 'مهلت تأیید مشتری تمام شد');
    for (const a of await this.salesAgentsOf(o.customerId)) await this.tg.send(a.telegramId, `⌛️ پیش‌فاکتور #${o.number} (${o.customer.name}) بدون تأیید مشتری منقضی شد. در صورت نیاز با قیمت روز دوباره بفرستید.`);
  }

  /** Proformas the customer did not accept in time. */
  async expireProformas() {
    const due = await this.prisma.order.findMany({ where: { status: 'PROFORMA_SENT', proformas: { some: {} } }, select: { id: true, proformas: { orderBy: { version: 'desc' }, take: 1, select: { expiresAt: true } } } });
    for (const o of due) if (o.proformas[0] && o.proformas[0].expiresAt < new Date()) await this.expire(o.id);
  }

  /** Moves an order to a new status and tells the person who placed it, through the bot. */
  async setStatus(byUserId: string, id: string, status: OrderStatus, comment?: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { placedBy: true } });
    if (!o) throw new NotFoundException();
    await this.prisma.order.update({ where: { id }, data: { status, events: { create: { status, byUserId, comment } } } });
    await this.tg.send(o.placedBy.telegramId, `وضعیت سفارش #${o.number}: ${STATUS_FA[status]}${comment ? `\nتوضیح: ${comment}` : ''}`);
    return { before: o.status, number: o.number };
  }

  /** OWNER sees every order of the company, BUYER only their own. Staff see all. */
  async listMine(userId: string) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId } });
    const owned = ms.filter(m => m.role === 'OWNER' || m.role === 'VIEWER').map(m => m.customerId);
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ placedById: userId }, { customerId: { in: owned } }] },
      orderBy: { createdAt: 'desc' }, take: 50,
      include: { items: true, customer: { select: { id: true, name: true } }, placedBy: { select: { firstName: true, lastName: true } } },
    });
    return orders.map(o => ({ ...o, total: this.orderTotal(o.items), statusFa: STATUS_FA[o.status] }));
  }

  async get(userId: string, id: string, staff = false) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } }, proformas: true, shipments: { orderBy: { shippedAt: 'asc' } }, documents: { orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, title: true, mime: true, size: true, byCustomer: true, createdAt: true, paymentId: true, shipmentId: true } }, customer: { include: { terms: true, support: { select: { firstName: true, lastName: true, phone: true } } } }, placedBy: { select: { id: true, firstName: true, lastName: true, username: true } } },
    });
    if (!o) throw new NotFoundException();
    if (!staff && o.placedById !== userId) {
      const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: o.customerId, userId } } });
      if (!m || m.role === 'BUYER') throw new NotFoundException();
    }
    const b = this.breakdown(o);
    const proformas = [...o.proformas].sort((x, y) => y.version - x.version);
    return { ...o, proformas, total: b.subtotal, payable: b.total, breakdown: bdJson(b), split: { cash: b.cash, cheque: b.cheque }, statusFa: STATUS_FA[o.status] };
  }
}
