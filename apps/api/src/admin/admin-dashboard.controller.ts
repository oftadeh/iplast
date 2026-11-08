import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantService } from '../assistant/assistant.service';

const BADGES = ['salesReview', 'finalApproval', 'warehouse', 'newCustomers', 'joinRequests', 'reportedPayments', 'unansweredChats'] as const;
type Badge = typeof BADGES[number];

/** Overview for the admin panel home: work waiting for staff, sales and money at a glance. */
@Controller('admin/dashboard')
@UseGuards(SessionGuard)
@Staff('ADMIN', 'SALES', 'WAREHOUSE')
export class AdminDashboardController {
  constructor(private readonly prisma: PrismaService, private readonly ai: AssistantService) {}

  /** Is the AI agent actually reachable from this server, and what has it done in the last 30 days? */
  @Get('ai')
  async ai_() {
    const since = new Date(Date.now() - 30 * 864e5);
    const [check, orders, chats, handoffs, recent] = await Promise.all([
      this.ai.check(),
      this.prisma.order.count({ where: { channel: 'agent', createdAt: { gte: since } } }),
      this.prisma.conversation.count({ where: { updatedAt: { gte: since } } }),
      this.prisma.conversation.count({ where: { handoffAt: { gte: since } } }),
      this.prisma.order.findMany({ where: { channel: 'agent' }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, number: true, status: true, createdAt: true, customer: { select: { name: true } } } }),
    ]);
    return { ...check, agentOn: process.env.SALES_AGENT !== '0', stats: { orders, chats, handoffs }, recent };
  }

  /** The staff member opened a page: its menu count («جدید») starts again from now. */
  @Post('seen')
  async seen(@Session() s: SessionClaims, @Body() b: { badge?: string }) {
    if (!b?.badge || !(BADGES as readonly string[]).includes(b.badge)) throw new BadRequestException();
    const key = `seen.${s.sub}`;
    const cur = await this.prisma.setting.findUnique({ where: { key } });
    const value = { ...((cur?.value as Record<string, string> | null) ?? {}), [b.badge]: new Date().toISOString() };
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    return { ok: true };
  }

  /**
   * Work waiting for this person: `pending` is everything still to handle (it drops when handled),
   * `fresh` is what arrived or changed since they last opened that page (it drops when seen).
   * A sales agent only counts their own customers and customers without an agent.
   */
  private async counts(s: SessionClaims) {
    const p = this.prisma;
    const sales = s.staff === 'SALES';
    const cust: Prisma.CustomerWhereInput = sales ? { OR: [{ supportId: s.sub }, { supportId: null }] } : {};
    const seenRow = await p.setting.findUnique({ where: { key: `seen.${s.sub}` } });
    const seenAt = (k: Badge) => { const v = (seenRow?.value as Record<string, string> | null)?.[k]; return v ? new Date(v) : new Date(0); };
    const orders = (st: Prisma.OrderWhereInput['status'], k: Badge) => {
      const w: Prisma.OrderWhereInput = { status: st, ...(sales ? { customer: cust } : {}) };
      return Promise.all([p.order.count({ where: w }), p.order.count({ where: { ...w, updatedAt: { gt: seenAt(k) } } })]);
    };
    const chatRows = await p.$queryRaw<{ last: Date; assigneeId: string | null }[]>`SELECT c."assigneeId", (SELECT max(m."createdAt") FROM "Message" m WHERE m."conversationId" = c.id AND m."direction" = 'IN') AS last FROM "Conversation" c WHERE c."isOpen" AND c."handoffAt" IS NOT NULL AND (SELECT m."direction" FROM "Message" m WHERE m."conversationId" = c.id AND (m."text" IS NULL OR m."text" NOT LIKE '[دستیار]%') ORDER BY m."createdAt" DESC LIMIT 1) = 'IN'`;
    const chats = chatRows.filter(r => !sales || !r.assigneeId || r.assigneeId === s.sub);
    const custW: Prisma.CustomerWhereInput = { isApproved: false, ...cust };
    const joinW: Prisma.JoinRequestWhereInput = { status: 'PENDING', ...(sales ? { customer: cust } : {}) };
    const payW: Prisma.PaymentWhereInput = { status: 'REPORTED', ...(sales ? { customer: cust } : {}) };
    const [salesReview, finalApproval, warehouse, newC, newCf, join, joinf, pay, payf, awaitingCustomer, needsFix] = await Promise.all([
      orders({ in: ['SUBMITTED', 'SALES_REVIEW', 'PROFORMA_EXPIRED'] }, 'salesReview'),
      orders('SALES_APPROVED', 'finalApproval'),
      orders({ in: ['CONFIRMED', 'PREPARING'] }, 'warehouse'),
      p.customer.count({ where: custW }), p.customer.count({ where: { ...custW, createdAt: { gt: seenAt('newCustomers') } } }),
      p.joinRequest.count({ where: joinW }), p.joinRequest.count({ where: { ...joinW, createdAt: { gt: seenAt('joinRequests') } } }),
      p.payment.count({ where: payW }), p.payment.count({ where: { ...payW, createdAt: { gt: seenAt('reportedPayments') } } }),
      p.order.count({ where: { status: 'PROFORMA_SENT', ...(sales ? { customer: cust } : {}) } }),
      p.order.count({ where: { status: 'NEEDS_FIX', ...(sales ? { customer: cust } : {}) } }),
    ]);
    return {
      queue: {
        salesReview: salesReview[0], finalApproval: finalApproval[0], warehouse: warehouse[0], awaitingCustomer, needsFix,
        newCustomers: newC, joinRequests: join, reportedPayments: pay, unansweredChats: chats.length,
      },
      fresh: {
        salesReview: salesReview[1], finalApproval: finalApproval[1], warehouse: warehouse[1],
        newCustomers: newCf, joinRequests: joinf, reportedPayments: payf, unansweredChats: chats.filter(r => r.last > seenAt('unansweredChats')).length,
      },
    };
  }

  /** Just the menu counts, polled by the panel. */
  @Get('counts')
  countsOnly(@Session() s: SessionClaims) { return this.counts(s); }

  @Get()
  async get(@Session() s: SessionClaims) {
    const p = this.prisma;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const days30 = new Date(Date.now() - 30 * 864e5);
    const week = new Date(Date.now() + 7 * 864e5);
    const days60 = new Date(Date.now() - 60 * 864e5);
    const [sales30, salesPrev, top] = await Promise.all([
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: days30 } }, _sum: { total: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: days60, lt: days30 } }, _sum: { total: true } }),
      p.invoice.groupBy({ by: ['customerId'], where: { status: 'ISSUED', issuedAt: { gte: days30 } }, _sum: { total: true }, orderBy: { _sum: { total: 'desc' } }, take: 5 }),
    ]);
    const topNames = await p.customer.findMany({ where: { id: { in: top.map(t => t.customerId) } }, select: { id: true, name: true } });
    const [byStatus, today, month, customers, chequesDue, invoiced, paid, list, variants, recent, daily] = await Promise.all([
      p.order.groupBy({ by: ['status'], _count: true }),
      p.order.count({ where: { createdAt: { gte: startOfDay } } }),
      p.order.count({ where: { createdAt: { gte: days30 } } }),
      p.customer.count({ where: { isApproved: true } }),
      p.payment.aggregate({ where: { status: 'PENDING', dueDate: { lte: week } }, _sum: { amount: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED' }, _sum: { total: true } }),
      p.payment.aggregate({ where: { status: 'CLEARED' }, _sum: { amount: true } }),
      p.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' }, select: { id: true, title: true, publishedAt: true, _count: { select: { prices: { where: { status: 'INQUIRY' } } } } } }),
      p.variant.count(),
      p.order.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, number: true, status: true, createdAt: true, payMode: true, discount: true, shipping: true, customer: { select: { name: true } }, items: { select: { unitPrice: true, quantity: true } }, _count: { select: { items: true } } } }),
      p.$queryRaw<{ d: Date; n: bigint }[]>`SELECT date_trunc('day', "createdAt") AS d, count(*)::bigint AS n FROM "Order" WHERE "createdAt" >= ${new Date(Date.now() - 14 * 864e5)} GROUP BY 1 ORDER BY 1`,
    ]);
    const c = Object.fromEntries(byStatus.map(x => [x.status, x._count])) as Record<string, number>;
    const n = (...k: string[]) => k.reduce((a, x) => a + (c[x] ?? 0), 0);
    const inv = invoiced._sum.total ?? 0n, pd = paid._sum.amount ?? 0n;
    // per sales agent: last 30 days of invoices and orders of their customers, customers and invitees
    const mine = s.staff === 'SALES';
    const [agents, inv30, ord30, lastOrders, cheques, balInv, balPaid, limits] = await Promise.all([
      p.user.findMany({ where: { staffRole: { in: ['SALES', 'ADMIN'] }, isActive: true, ...(mine ? { id: s.sub } : {}) }, select: { id: true, firstName: true, lastName: true, staffRole: true, _count: { select: { supportOf: true, referrals: true } } } }),
      p.invoice.findMany({ where: { status: 'ISSUED', issuedAt: { gte: days30 } }, select: { total: true, customer: { select: { supportId: true } } } }),
      p.order.findMany({ where: { createdAt: { gte: days30 } }, select: { customerId: true, channel: true, customer: { select: { supportId: true } } } }),
      p.order.groupBy({ by: ['customerId'], _max: { createdAt: true }, _count: true }),
      p.payment.findMany({ where: { method: 'CHEQUE', status: 'PENDING', dueDate: { lte: week } }, orderBy: { dueDate: 'asc' }, take: 6, select: { id: true, amount: true, dueDate: true, chequeNumber: true, customer: { select: { id: true, name: true, supportId: true } } } }),
      p.invoice.groupBy({ by: ['customerId'], where: { status: 'ISSUED' }, _sum: { total: true } }),
      p.payment.groupBy({ by: ['customerId'], where: { status: 'CLEARED' }, _sum: { amount: true } }),
      p.customer.findMany({ where: { creditLimit: { not: null }, ...(mine ? { supportId: s.sub } : {}) }, select: { id: true, name: true, creditLimit: true } }),
    ]);
    const perf = agents.filter(a => a.staffRole === 'SALES' || a._count.supportOf > 0).map(a => {
      const sales = inv30.filter(i => i.customer.supportId === a.id).reduce((x, i) => x + i.total, 0n);
      const os = ord30.filter(o => o.customer.supportId === a.id);
      return { id: a.id, name: [a.firstName, a.lastName].filter(Boolean).join(' ') || 'بی‌نام', sales, orders: os.length, fromApp: os.filter(o => o.channel !== 'admin').length, active: new Set(os.map(o => o.customerId)).size, customers: a._count.supportOf, invited: a._count.referrals };
    }).sort((x, y) => (y.sales > x.sales ? 1 : y.sales < x.sales ? -1 : y.orders - x.orders));
    const last = new Map(lastOrders.map(o => [o.customerId, { at: o._max.createdAt, n: o._count }]));
    const custs = await p.customer.findMany({ where: { isApproved: true, ...(mine ? { supportId: s.sub } : {}) }, select: { id: true, name: true, city: true, createdAt: true, support: { select: { firstName: true, lastName: true } } } });
    const quiet = custs.map(c => ({ ...c, last: last.get(c.id)?.at ?? null, orders: last.get(c.id)?.n ?? 0 }))
      .filter(c => (c.last ?? c.createdAt) < days30)
      .sort((a, b) => +(a.last ?? 0) - +(b.last ?? 0)).slice(0, 8)
      .map(c => ({ id: c.id, name: c.name, city: c.city, last: c.last, orders: c.orders, agent: c.support ? [c.support.firstName, c.support.lastName].filter(Boolean).join(' ') : null }));
    const quietCount = custs.filter(c => ((last.get(c.id)?.at) ?? c.createdAt) < days30).length;
    const paidBy = new Map(balPaid.map(x => [x.customerId, x._sum.amount ?? 0n]));
    const balance = new Map(balInv.map(x => [x.customerId, (x._sum.total ?? 0n) - (paidBy.get(x.customerId) ?? 0n)]));
    const overLimit = limits.map(c => ({ id: c.id, name: c.name, limit: c.creditLimit!, balance: balance.get(c.id) ?? 0n })).filter(c => c.balance > c.limit).sort((a, b) => (b.balance - b.limit > a.balance - a.limit ? 1 : -1));
    const fromApp = ord30.filter(o => o.channel !== 'admin').length;
    return {
      perf, quiet, quietCount, overLimit,
      cheques: cheques.filter(c => !mine || c.customer.supportId === s.sub),
      appShare: ord30.length ? Math.round((fromApp / ord30.length) * 100) : null,
      role: s.staff,
      ...(await this.counts(s)),
      orders: { today, last30: month, open: n('SUBMITTED', 'SALES_REVIEW', 'SALES_APPROVED', 'NEEDS_FIX', 'PROFORMA_SENT', 'CONFIRMED', 'PREPARING', 'SHIPPED'), delivered: n('DELIVERED'), byStatus: c },
      money: { receivable: inv - pd, invoiced: inv, chequesDue7: chequesDue._sum.amount ?? 0n, chequesDue7Count: chequesDue._count },
      catalog: { variants, inquiry: list?._count.prices ?? 0, activeList: list ? { id: list.id, title: list.title, publishedAt: list.publishedAt } : null },
      customers,
      daily: daily.map(r => ({ d: r.d, n: Number(r.n) })),
      sales: { last30: sales30._sum.total ?? 0n, count30: sales30._count, prev30: salesPrev._sum.total ?? 0n },
      top: top.map(t => ({ id: t.customerId, name: topNames.find(c => c.id === t.customerId)?.name ?? '—', total: t._sum.total ?? 0n })),
      recent: recent.map(({ items, discount, shipping, ...o }) => ({
        ...o,
        value: items.some(i => i.unitPrice === null) ? null : items.reduce((a, i) => a + (i.unitPrice ?? 0n) * BigInt(i.quantity), 0n) - discount + shipping,
      })),
    };
  }
}
