import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrdersService } from '../orders/orders.service';
import { PaymentMethod, PaymentStatus } from '@iplast/db';
import { formatRial, orderBreakdown, splitCashCheque } from '@iplast/shared';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { audit } from '../common/audit';
import { rialOf } from '../common/validate';

const RECEIPTS = join(process.env.UPLOAD_DIR ?? '/data/uploads', 'receipts'); // private: served only to the customer and staff
const IMAGE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'CHEQUE'];
const STATUSES: PaymentStatus[] = ['REPORTED', 'PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'];
export const METHOD_FA: Record<PaymentMethod, string> = { CASH: 'نقد', TRANSFER: 'واریز / کارت‌به‌کارت', CHEQUE: 'چک' };
export const PAY_STATUS_FA: Record<PaymentStatus, string> = { REPORTED: 'ارسال‌شده توسط مشتری، منتظر بررسی', PENDING: 'در جریان (هنوز وصول نشده)', CLEARED: 'وصول شد', BOUNCED: 'برگشتی', CANCELLED: 'باطل' };

@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly orders: OrdersService) {
    // the manager's final approval issues the invoice from the priced proforma
    orders.onConfirmed = async (byUserId, orderId) => { await this.issueFromOrder(byUserId, { orderId }); };
    orders.ticks.push(() => this.chequeReminders());
  }

  private async customerAndAgents(customerId: string) {
    const [members, agents] = await Promise.all([
      this.prisma.customerMember.findMany({ where: { customerId, role: { in: ['OWNER', 'VIEWER'] } }, include: { user: true } }),
      this.orders.salesAgentsOf(customerId),
    ]);
    return { customer: [...new Set(members.map(m => String(m.user.telegramId)))], agents: agents.map(a => String(a.telegramId)) };
  }

  /**
   * Cheques still in hand: the customer and their sales agent hear 3 days before the due date and again on the day;
   * the managers get one list a day of cheques due in the next 3 days and overdue ones.
   */
  async chequeReminders(now = new Date()) {
    const soon = new Date(now.getTime() + 3 * 86400_000);
    const due = await this.prisma.payment.findMany({ where: { method: 'CHEQUE', status: 'PENDING', dueDate: { lte: soon } }, include: { customer: true }, orderBy: { dueDate: 'asc' } });
    const day = (d: Date) => d.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });
    const today = day(now);
    const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Tehran', hour: 'numeric', hour12: false }));
    if (hour < 8 || hour >= 21) return; // no messages at night
    for (const p of due) {
      const isToday = day(p.dueDate!) === today || p.dueDate! < now;
      const sentToday = p.remindedAt && day(p.remindedAt) === today;
      const sentEarly = !!p.remindedAt;
      if (sentToday || (!isToday && sentEarly) || (isToday && p.remindedAt && p.remindedAt >= p.dueDate!)) continue;
      const head = p.dueDate! < now && day(p.dueDate!) !== today ? '⚠️ سررسید چک گذشته است' : isToday ? '📅 امروز سررسید چک است' : '🔔 یادآوری سررسید چک';
      const text = `${head}\nمشتری: ${p.customer.name}\nمبلغ: ${formatRial(p.amount)}${p.chequeNumber ? `\nشماره چک: ${p.chequeNumber}` : ''}${p.bank ? ` · ${p.bank}` : ''}\nسررسید: ${day(p.dueDate!)}`;
      const { customer, agents } = await this.customerAndAgents(p.customerId);
      for (const t of customer) await this.tg.send(t, `${text}\n\nلطفاً موجودی حساب را برای وصول چک تأمین کنید.`);
      for (const t of agents) await this.tg.send(t, text);
      await this.prisma.payment.update({ where: { id: p.id }, data: { remindedAt: now } });
    }
    const key = 'cheque.digestDay';
    const last = await this.prisma.setting.findUnique({ where: { key } });
    if (due.length && last?.value !== today) {
      const total = due.reduce((s, p) => s + p.amount, 0n);
      const lines = due.slice(0, 30).map(p => `${p.dueDate! < now ? '⚠️' : '•'} ${day(p.dueDate!)} · ${p.customer.name} · ${formatRial(p.amount)}${p.chequeNumber ? ` · ${p.chequeNumber}` : ''}`);
      for (const a of await this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } }))
        await this.tg.send(a.telegramId, `🗓 چک‌های سررسید سه روز آینده و معوق (${due.length} فقره، ${formatRial(total)})\n${lines.join('\n')}${due.length > 30 ? `\n… و ${due.length - 30} فقره‌ی دیگر` : ''}\n\nبعد از وصول یا برگشت، وضعیت را در پنل ← حساب مشتریان ثبت کنید.`);
      await this.prisma.setting.upsert({ where: { key }, update: { value: today }, create: { key, value: today } });
    }
  }

  /** Cash and cheque parts of an issued invoice. A term sale is one cheque for the goods; freight is cash. */
  private invSplit(inv: { total: bigint; subtotal: bigint; discount: bigint; shipping: bigint; payMode: string; cashPercent: number; chequeMarkup: bigint }) {
    if (inv.payMode === 'TERM') { const cheque = inv.total - inv.shipping; return { cash: inv.shipping, cheque }; }
    const chequeBase = splitCashCheque(inv.subtotal - inv.discount, inv.cashPercent).cheque;
    const cheque = chequeBase + inv.chequeMarkup;
    return { cash: inv.total - cheque, cheque };
  }

  /**
   * A customer reports a payment from the mini app with a photo of the cheque or bank receipt.
   * It goes to their sales agent and the managers (photo + approve/reject buttons in the bot) and waits for review.
   */
  async report(userId: string, customerId: string, b: { amount?: unknown; method?: string; chequeNumber?: string; bank?: string; dueDate?: string; note?: string; invoiceId?: string }, file?: { buffer: Buffer; mimetype: string }) {
    const ext = file && IMAGE[file.mimetype];
    if (!file?.buffer?.length || !ext) throw new BadRequestException('عکس یا PDF چک یا فیش واریزی را انتخاب کنید');
    const method = b.method as PaymentMethod;
    if (!METHODS.includes(method)) throw new BadRequestException('نوع پرداخت را انتخاب کنید');
    const amount = rialOf(b.amount, 'مبلغ');
    const due = b.dueDate ? new Date(b.dueDate) : null;
    if (method === 'CHEQUE' && (!due || isNaN(due.getTime()))) throw new BadRequestException('تاریخ سررسید چک را وارد کنید');
    if (b.invoiceId && !(await this.prisma.invoice.findFirst({ where: { id: b.invoiceId, customerId } }))) throw new BadRequestException('فاکتور نامعتبر است');
    mkdirSync(RECEIPTS, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.${ext}`;
    writeFileSync(join(RECEIPTS, name), file.buffer);
    const p = await this.prisma.payment.create({
      data: {
        customerId, invoiceId: b.invoiceId || null, amount, method, status: 'REPORTED', dueDate: due,
        chequeNumber: b.chequeNumber?.trim().slice(0, 40) || null, bank: b.bank?.trim().slice(0, 60) || null, note: b.note?.trim().slice(0, 500) || null,
        receiptKey: name, reportedById: userId, createdById: userId,
      },
      include: { customer: true, invoice: { select: { number: true } } },
    });
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    const who = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'مشتری';
    const caption = `💳 ${METHOD_FA[method]} ارسالی مشتری\nمشتری: ${p.customer.name} (${who})\nمبلغ: ${formatRial(amount)}${p.chequeNumber ? `\nشماره چک: ${p.chequeNumber}` : ''}${p.bank ? ` · ${p.bank}` : ''}${due ? `\nسررسید: ${due.toLocaleDateString('fa-IR')}` : ''}${p.invoice ? `\nبابت فاکتور ${p.invoice.number}` : ''}${p.note ? `\nتوضیح: ${p.note}` : ''}`;
    const kb = { inline_keyboard: [[{ text: '✅ تأیید دریافت', callback_data: `pay:${p.id}:ok` }, { text: '❌ رد', callback_data: `pay:${p.id}:no` }]] };
    const to = new Map<string, bigint>();
    for (const a of await this.orders.salesAgentsOf(customerId)) to.set(a.id, a.telegramId);
    for (const a of await this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } })) to.set(a.id, a.telegramId);
    for (const t of to.values()) await this.tg.sendFile(t, file.buffer, `receipt.${ext}`, file.mimetype, caption, kb);
    return { id: p.id, status: p.status };
  }

  /** Sales agent or manager checks a reported payment: accepted (a cheque then waits to clear) or rejected. */
  async review(byUserId: string, id: string, ok: boolean, comment?: string) {
    const [u, p] = await Promise.all([this.prisma.user.findUnique({ where: { id: byUserId } }), this.prisma.payment.findUnique({ where: { id }, include: { customer: true } })]);
    if (!p) throw new NotFoundException();
    if (!u?.staffRole || !u.isActive) throw new ForbiddenException('دسترسی ندارید');
    if (u.staffRole !== 'ADMIN' && p.customer.supportId && p.customer.supportId !== u.id) throw new ForbiddenException('این مشتری کارشناس دیگری دارد');
    if (p.status !== 'REPORTED') throw new BadRequestException(`این پرداخت قبلاً بررسی شده است (${PAY_STATUS_FA[p.status]})`);
    const status: PaymentStatus = !ok ? 'CANCELLED' : p.method === 'CHEQUE' ? 'PENDING' : 'CLEARED';
    const note = [p.note, comment?.trim() && `بررسی: ${comment.trim().slice(0, 300)}`].filter(Boolean).join('\n') || null;
    await this.prisma.payment.update({ where: { id }, data: { status, note, createdById: byUserId } });
    await audit(this.prisma, byUserId, 'payment.review', 'Payment', id, { status: p.status }, { status, comment });
    if (p.reportedById) {
      const r = await this.prisma.user.findUnique({ where: { id: p.reportedById } });
      if (r) await this.tg.send(r.telegramId, ok
        ? `✅ ${METHOD_FA[p.method]} ${formatRial(p.amount)} تأیید شد${p.method === 'CHEQUE' ? ' و پس از وصول از مانده‌ی حساب کم می‌شود' : ' و از مانده‌ی حساب کم شد'}.`
        : `❌ ${METHOD_FA[p.method]} ${formatRial(p.amount)} تأیید نشد.${comment ? `\nتوضیح: ${comment}` : ''}\nبرای هماهنگی همین‌جا پیام بدهید.`);
    }
    return { status, statusFa: PAY_STATUS_FA[status] };
  }

  receiptPath(p: { receiptKey: string | null }) {
    if (!p.receiptKey || !/^[a-f0-9]+\.(jpg|png|webp|pdf)$/.test(p.receiptKey)) throw new NotFoundException();
    const path = join(RECEIPTS, p.receiptKey);
    if (!existsSync(path)) throw new NotFoundException();
    return path;
  }

  /**
   * The customer's account: invoices (debit), money received (credit), cheques still pending, and a statement
   * with a running balance. Balance > 0 means the customer owes that amount.
   */
  async account(customerId: string) {
    const [customer, invoices, payments] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, city: true, terms: true, support: { select: { id: true, firstName: true, lastName: true, username: true } } } }),
      this.prisma.invoice.findMany({ where: { customerId }, orderBy: { issuedAt: 'desc' }, include: { _count: { select: { items: true } }, order: { select: { number: true } } } }),
      this.prisma.payment.findMany({ where: { customerId }, orderBy: { receivedAt: 'desc' }, include: { invoice: { select: { number: true } } } }),
    ]);
    if (!customer) throw new NotFoundException();
    const issued = invoices.filter(i => i.status === 'ISSUED');
    const cleared = payments.filter(p => p.status === 'CLEARED');
    const pending = payments.filter(p => p.status === 'PENDING');
    const reported = payments.filter(p => p.status === 'REPORTED').reduce((x, p) => x + p.amount, 0n);
    const invoiced = issued.reduce((s, i) => s + i.total, 0n);
    const paid = cleared.reduce((s, p) => s + p.amount, 0n);
    const pendingCheques = pending.reduce((s, p) => s + p.amount, 0n);

    const events = [
      ...issued.map(i => ({ at: i.issuedAt, kind: 'invoice' as const, id: i.id, title: `فاکتور ${i.number}`, debit: i.total, credit: 0n })),
      ...cleared.map(p => ({ at: p.receivedAt, kind: 'payment' as const, id: p.id, title: `${METHOD_FA[p.method]}${p.chequeNumber ? ` ${p.chequeNumber}` : ''}`, debit: 0n, credit: p.amount })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    let run = 0n;
    const statement = events.map(e => { run += e.debit - e.credit; return { ...e, balance: run }; }).reverse();

    return {
      customer,
      summary: { invoiced, paid, pendingCheques, reported, balance: invoiced - paid, balanceAfterCheques: invoiced - paid - pendingCheques },
      invoices: invoices.map(({ _count, ...i }) => ({ ...i, itemCount: _count.items })),
      payments: payments.map(({ receiptKey, ...p }) => ({ ...p, hasReceipt: !!receiptKey, receiptPdf: !!receiptKey?.endsWith('.pdf'), methodFa: METHOD_FA[p.method], statusFa: PAY_STATUS_FA[p.status] })),
      statement,
    };
  }

  async invoice(id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, customer: { select: { id: true, name: true, city: true, address: true, nationalId: true } }, order: { select: { id: true, number: true } }, payments: { where: { status: { in: ['CLEARED', 'PENDING'] } } } },
    });
    if (!inv) throw new NotFoundException();
    const paid = inv.payments.filter(p => p.status === 'CLEARED').reduce((s, p) => s + p.amount, 0n);
    return { ...inv, split: this.invSplit(inv), paidAgainst: paid, payments: inv.payments.map(p => ({ ...p, methodFa: METHOD_FA[p.method], statusFa: PAY_STATUS_FA[p.status] })) };
  }

  /** Issues the invoice of a confirmed order. Inquiry items need a price now; discount and shipping are optional. */
  async issueFromOrder(byUserId: string, b: { orderId?: string; prices?: Record<string, unknown>; discount?: unknown; shipping?: unknown; note?: string; drop?: string[] }) {
    const o = await this.prisma.order.findUnique({ where: { id: String(b?.orderId ?? '') }, include: { items: true, invoices: { where: { status: 'ISSUED' } }, placedBy: true, customer: { include: { members: { where: { role: 'OWNER' }, include: { user: true } } } } } });
    if (!o) throw new NotFoundException();
    if (o.invoices.length) throw new BadRequestException(`برای این سفارش فاکتور ${o.invoices[0].number} صادر شده است`);
    if (!['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'PROFORMA_SENT'].includes(o.status)) throw new BadRequestException('اول سفارش را تأیید کنید');
    const drop = new Set(b.drop ?? []);
    const items = o.items.filter(i => !drop.has(i.id)).map(i => {
      const given = b.prices?.[i.id];
      const unitPrice = given !== undefined && given !== '' ? rialOf(given, `قیمت «${i.title}»`) : i.unitPrice;
      if (unitPrice === null) throw new BadRequestException(`قیمت «${i.title}» را وارد کنید (استعلامی بوده است)`);
      return { variantId: i.variantId, title: i.title, quantity: i.quantity, packs: i.packs, unitPrice, listPrice: given !== undefined && given !== '' ? null : i.listPrice, total: unitPrice * BigInt(i.quantity) };
    });
    if (!items.length) throw new BadRequestException('فاکتور بدون قلم صادر نمی‌شود');
    const subtotal = items.reduce((s, i) => s + i.total, 0n);
    const discount = b.discount !== undefined && b.discount !== '' ? rialOf(b.discount, 'تخفیف', true) : o.discount;
    const shipping = b.shipping !== undefined && b.shipping !== '' ? rialOf(b.shipping, 'هزینه‌ی حمل', true) : o.shipping;
    if (discount > subtotal) throw new BadRequestException('تخفیف از جمع فاکتور بیشتر است');
    const bd = orderBreakdown(items, o.payMode, o.termMonths, discount, shipping);
    const inv = await this.prisma.invoice.create({
      data: {
        customerId: o.customerId, orderId: o.id, issuedById: byUserId, subtotal, discount, shipping, total: bd.total,
        payMode: o.payMode, termMonths: bd.termMonths, listTotal: bd.listTotal,
        cashPercent: o.payMode === 'TERM' ? 0 : 100, chequeDueDays: bd.cheques.map(c => c.days ?? 0), note: b.note?.trim().slice(0, 1000) || null,
        items: { create: items.map(({ listPrice: _l, ...i }) => i) },
      },
    });
    await audit(this.prisma, byUserId, 'invoice.issue', 'Invoice', inv.id, null, { orderId: o.id, total: inv.total.toString() });
    const to = new Set([String(o.placedBy.telegramId), ...o.customer.members.map(m => String(m.user.telegramId))]);
    for (const t of to) await this.tg.send(t, `🧾 فاکتور ${inv.number} برای سفارش #${o.number} صادر شد.\nمبلغ: ${formatRial(inv.total)}\nجزئیات و مانده‌ی حساب: مینی‌اپ ← حساب من`);
    return this.invoice(inv.id);
  }

  async cancelInvoice(byUserId: string, id: string, reason?: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException();
    if (inv.status === 'CANCELLED') return this.invoice(id);
    await this.prisma.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), note: [inv.note, reason && `ابطال: ${reason}`].filter(Boolean).join('\n') || null } });
    await audit(this.prisma, byUserId, 'invoice.cancel', 'Invoice', id, { status: inv.status }, { status: 'CANCELLED', reason });
    return this.invoice(id);
  }

  async addPayment(byUserId: string, b: { customerId?: string; amount?: unknown; method?: string; chequeNumber?: string; bank?: string; dueDate?: string; receivedAt?: string; note?: string; invoiceId?: string }) {
    const customer = await this.prisma.customer.findUnique({ where: { id: String(b?.customerId ?? '') }, include: { members: { where: { role: 'OWNER' }, include: { user: true } } } });
    if (!customer) throw new NotFoundException();
    const method = b.method as PaymentMethod;
    if (!METHODS.includes(method)) throw new BadRequestException('روش پرداخت را انتخاب کنید');
    const amount = rialOf(b.amount, 'مبلغ');
    const due = b.dueDate ? new Date(b.dueDate) : null;
    if (method === 'CHEQUE' && (!due || isNaN(due.getTime()))) throw new BadRequestException('تاریخ سررسید چک را وارد کنید');
    if (b.invoiceId && !(await this.prisma.invoice.findFirst({ where: { id: b.invoiceId, customerId: customer.id } }))) throw new BadRequestException('فاکتور نامعتبر است');
    const p = await this.prisma.payment.create({
      data: {
        customerId: customer.id, invoiceId: b.invoiceId || null, amount, method, status: method === 'CHEQUE' ? 'PENDING' : 'CLEARED',
        chequeNumber: b.chequeNumber?.trim().slice(0, 40) || null, bank: b.bank?.trim().slice(0, 60) || null, dueDate: due,
        receivedAt: b.receivedAt ? new Date(b.receivedAt) : new Date(), note: b.note?.trim().slice(0, 500) || null, createdById: byUserId,
      },
    });
    await audit(this.prisma, byUserId, 'payment.add', 'Payment', p.id, null, { customerId: customer.id, amount: amount.toString(), method });
    for (const m of customer.members) await this.tg.send(m.user.telegramId, `💳 ${METHOD_FA[method]} به مبلغ ${formatRial(amount)} در حساب «${customer.name}» ثبت شد${method === 'CHEQUE' ? ' (پس از وصول از مانده کم می‌شود)' : ''}.`);
    return p;
  }

  async setPaymentStatus(byUserId: string, id: string, status: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    if (!STATUSES.includes(status as PaymentStatus)) throw new BadRequestException('وضعیت نامعتبر است');
    const r = await this.prisma.payment.update({ where: { id }, data: { status: status as PaymentStatus } });
    await audit(this.prisma, byUserId, 'payment.status', 'Payment', id, { status: p.status }, { status });
    if (p.method === 'CHEQUE' && p.status !== status && (status === 'BOUNCED' || status === 'CLEARED')) {
      const c = await this.prisma.customer.findUnique({ where: { id: p.customerId } });
      const what = `چک ${formatRial(p.amount)}${p.chequeNumber ? ` (شماره ${p.chequeNumber})` : ''}${p.dueDate ? ` سررسید ${p.dueDate.toLocaleDateString('fa-IR')}` : ''}`;
      const { customer, agents } = await this.customerAndAgents(p.customerId);
      if (status === 'CLEARED') for (const t of customer) await this.tg.send(t, `✅ ${what} وصول شد و از مانده‌ی حساب کم شد.`);
      else {
        for (const t of customer) await this.tg.send(t, `❌ ${what} برگشت خورد. لطفاً برای تسویه با کارشناس فروش هماهنگ کنید.`);
        for (const t of agents) await this.tg.send(t, `❌ چک برگشتی: ${c?.name ?? ''}\n${what}`);
        for (const a of await this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } })) if (a.id !== byUserId) await this.tg.send(a.telegramId, `❌ چک برگشتی: ${c?.name ?? ''}\n${what}`);
      }
    }
    return r;
  }

  /** Customers with what they owe, for the admin list. */
  async balances(q?: string) {
    const customers = await this.prisma.customer.findMany({ where: q ? { name: { contains: q } } : {}, orderBy: { name: 'asc' }, take: 300, select: { id: true, name: true, city: true } });
    const ids = customers.map(c => c.id);
    const [inv, pay, pend] = await Promise.all([
      this.prisma.invoice.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'ISSUED' }, _sum: { total: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'CLEARED' }, _sum: { amount: true } }),
      this.prisma.payment.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'PENDING' }, _sum: { amount: true } }),
    ]);
    return customers.map(c => {
      const i = inv.find(x => x.customerId === c.id);
      const invoiced = i?._sum.total ?? 0n, paid = pay.find(x => x.customerId === c.id)?._sum.amount ?? 0n;
      return { ...c, invoices: i?._count ?? 0, invoiced, paid, pendingCheques: pend.find(x => x.customerId === c.id)?._sum.amount ?? 0n, balance: invoiced - paid };
    }).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  }
}

/** Staff: issue invoices, record money received, see every customer's account. */
@Controller('admin/accounts')
@UseGuards(SessionGuard)
@Staff()
export class AdminAccountsController {
  constructor(private readonly acc: AccountingService, private readonly prisma: PrismaService) {}

  @Get() list(@Query('q') q?: string) { return this.acc.balances(q?.trim()); }
  @Get('customers/:id') one(@Param('id') id: string) { return this.acc.account(id); }
  @Get('invoices/:id') invoice(@Param('id') id: string) { return this.acc.invoice(id); }
  /** Orders that are confirmed but have no invoice yet. */
  @Get('to-invoice')
  toInvoice() {
    return this.prisma.order.findMany({
      where: { status: { in: ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'PROFORMA_SENT'] }, invoices: { none: { status: 'ISSUED' } } },
      orderBy: { createdAt: 'asc' }, take: 100,
      include: { items: true, customer: { select: { id: true, name: true } } },
    });
  }
  @Post('invoices') @Staff('ADMIN') issue(@Session() s: SessionClaims, @Body() b: Parameters<AccountingService['issueFromOrder']>[1]) { return this.acc.issueFromOrder(s.sub, b); }
  @Post('invoices/:id/cancel') @Staff('ADMIN') cancel(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { reason?: string }) { return this.acc.cancelInvoice(s.sub, id, b?.reason?.slice(0, 300)); }
  @Post('payments') @Staff('ADMIN') pay(@Session() s: SessionClaims, @Body() b: Parameters<AccountingService['addPayment']>[1]) { return this.acc.addPayment(s.sub, b); }
  /** Payments customers sent from the mini app, waiting for review. */
  @Get('reported')
  reported() {
    return this.prisma.payment.findMany({ where: { status: 'REPORTED' }, orderBy: { createdAt: 'asc' }, include: { customer: { select: { id: true, name: true } }, invoice: { select: { number: true } } } })
      .then(ps => ps.map(({ receiptKey, ...p }) => ({ ...p, hasReceipt: !!receiptKey, receiptPdf: !!receiptKey?.endsWith('.pdf'), methodFa: METHOD_FA[p.method] })));
  }
  @Post('payments/:id/review') review(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { ok?: boolean; comment?: string }) { return this.acc.review(s.sub, id, !!b?.ok, b?.comment); }
  @Get('payments/:id/receipt')
  async receipt(@Param('id') id: string, @Res() res: Response) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(p.receiptKey!.split('.').pop()!);
    createReadStream(this.acc.receiptPath(p)).pipe(res);
  }
  @Patch('payments/:id') @Staff('ADMIN') payStatus(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { status?: string }) { return this.acc.setPaymentStatus(s.sub, id, String(b?.status)); }
}

/** Customer side («حساب من»): the company owner and viewers see the account; buyers do not. */
@Controller('me/account')
@UseGuards(SessionGuard)
export class MyAccountController {
  constructor(private readonly acc: AccountingService, private readonly prisma: PrismaService) {}

  private async customerOf(userId: string, customerId?: string) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId }, orderBy: { role: 'asc' } });
    const m = customerId ? ms.find(x => x.customerId === customerId) : ms.find(x => x.role !== 'BUYER') ?? ms[0];
    if (!m) throw new NotFoundException('هنوز حساب مشتری ندارید؛ با اولین سفارش ساخته می‌شود');
    if (m.role === 'BUYER') throw new ForbiddenException('حساب و فاکتورها را مدیر حساب شرکت می‌بیند');
    return m.customerId;
  }

  @Get()
  async mine(@Session() s: SessionClaims, @Query('customerId') customerId?: string) {
    return this.acc.account(await this.customerOf(s.sub, customerId));
  }

  /** Report a payment with a photo of the cheque or bank receipt. Buyers may send too. */
  @Post('payments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  async report(@Session() s: SessionClaims, @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined, @Body() b: Record<string, string>) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId: s.sub } });
    const m = b.customerId ? ms.find(x => x.customerId === b.customerId) : ms.find(x => x.role !== 'VIEWER') ?? ms[0];
    if (!m) throw new NotFoundException('هنوز حساب مشتری ندارید');
    return this.acc.report(s.sub, m.customerId, b, file);
  }

  @Get('payments/:id/receipt')
  async receipt(@Session() s: SessionClaims, @Param('id') id: string, @Res() res: Response) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    if (p.reportedById !== s.sub) await this.customerOf(s.sub, p.customerId);
    res.type(p.receiptKey?.split('.').pop() ?? 'jpg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(this.acc.receiptPath(p)).pipe(res);
  }

  @Get('invoices/:id')
  async invoice(@Session() s: SessionClaims, @Param('id') id: string) {
    const inv = await this.acc.invoice(id);
    await this.customerOf(s.sub, inv.customer.id);
    return inv;
  }
}
