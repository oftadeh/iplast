import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '@iplast/db';
import { formatRial, splitCashCheque } from '@iplast/shared';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { audit } from '../common/audit';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const toEn = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
function rialOf(v: unknown, what: string, allowZero = false): bigint {
  const s = toEn(String(v ?? '')).replace(/[,،٬\s]/g, '');
  if (!/^\d{1,15}$/.test(s)) throw new BadRequestException(`${what} باید عدد (ریال) باشد`);
  const n = BigInt(s);
  if (!allowZero && n <= 0n) throw new BadRequestException(`${what} باید بیشتر از صفر باشد`);
  return n;
}
const METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'CHEQUE'];
const STATUSES: PaymentStatus[] = ['PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'];
export const METHOD_FA: Record<PaymentMethod, string> = { CASH: 'نقد', TRANSFER: 'واریز / کارت‌به‌کارت', CHEQUE: 'چک' };
export const PAY_STATUS_FA: Record<PaymentStatus, string> = { PENDING: 'در جریان (هنوز وصول نشده)', CLEARED: 'وصول شد', BOUNCED: 'برگشتی', CANCELLED: 'باطل' };

@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  /**
   * The customer's account: invoices (debit), money received (credit), cheques still pending, and a statement
   * with a running balance. Balance > 0 means the customer owes that amount.
   */
  async account(customerId: string) {
    const [customer, invoices, payments] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, city: true, terms: true } }),
      this.prisma.invoice.findMany({ where: { customerId }, orderBy: { issuedAt: 'desc' }, include: { _count: { select: { items: true } }, order: { select: { number: true } } } }),
      this.prisma.payment.findMany({ where: { customerId }, orderBy: { receivedAt: 'desc' }, include: { invoice: { select: { number: true } } } }),
    ]);
    if (!customer) throw new NotFoundException();
    const issued = invoices.filter(i => i.status === 'ISSUED');
    const cleared = payments.filter(p => p.status === 'CLEARED');
    const pending = payments.filter(p => p.status === 'PENDING');
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
      summary: { invoiced, paid, pendingCheques, balance: invoiced - paid, balanceAfterCheques: invoiced - paid - pendingCheques },
      invoices: invoices.map(({ _count, ...i }) => ({ ...i, itemCount: _count.items })),
      payments: payments.map(p => ({ ...p, methodFa: METHOD_FA[p.method], statusFa: PAY_STATUS_FA[p.status] })),
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
    return { ...inv, split: splitCashCheque(inv.total, inv.cashPercent), paidAgainst: paid, payments: inv.payments.map(p => ({ ...p, methodFa: METHOD_FA[p.method], statusFa: PAY_STATUS_FA[p.status] })) };
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
      return { variantId: i.variantId, title: i.title, quantity: i.quantity, packs: i.packs, unitPrice, total: unitPrice * BigInt(i.quantity) };
    });
    if (!items.length) throw new BadRequestException('فاکتور بدون قلم صادر نمی‌شود');
    const subtotal = items.reduce((s, i) => s + i.total, 0n);
    const discount = b.discount ? rialOf(b.discount, 'تخفیف', true) : 0n;
    const shipping = b.shipping ? rialOf(b.shipping, 'هزینه‌ی حمل', true) : 0n;
    if (discount > subtotal) throw new BadRequestException('تخفیف از جمع فاکتور بیشتر است');
    const terms = (o.termsSnapshot ?? {}) as { cashPercent?: number; chequeDueDays?: number[] };
    const inv = await this.prisma.invoice.create({
      data: {
        customerId: o.customerId, orderId: o.id, issuedById: byUserId, subtotal, discount, shipping, total: subtotal - discount + shipping,
        cashPercent: terms.cashPercent ?? 100, chequeDueDays: terms.chequeDueDays ?? [], note: b.note?.trim().slice(0, 1000) || null,
        items: { create: items },
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

  @Get('invoices/:id')
  async invoice(@Session() s: SessionClaims, @Param('id') id: string) {
    const inv = await this.acc.invoice(id);
    await this.customerOf(s.sub, inv.customer.id);
    return inv;
  }
}
