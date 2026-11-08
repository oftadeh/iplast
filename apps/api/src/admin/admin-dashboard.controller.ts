import { Controller, Get, UseGuards } from '@nestjs/common';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantService } from '../assistant/assistant.service';

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

  @Get()
  async get(@Session() s: SessionClaims) {
    const p = this.prisma;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const days30 = new Date(Date.now() - 30 * 864e5);
    const week = new Date(Date.now() + 7 * 864e5);
    const unanswered = await p.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Conversation" c WHERE c."isOpen" AND c."handoffAt" IS NOT NULL AND (SELECT m."direction" FROM "Message" m WHERE m."conversationId" = c.id AND (m."text" IS NULL OR m."text" NOT LIKE '[دستیار]%') ORDER BY m."createdAt" DESC LIMIT 1) = 'IN'`;
    const days60 = new Date(Date.now() - 60 * 864e5);
    const [sales30, salesPrev, top] = await Promise.all([
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: days30 } }, _sum: { total: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: days60, lt: days30 } }, _sum: { total: true } }),
      p.invoice.groupBy({ by: ['customerId'], where: { status: 'ISSUED', issuedAt: { gte: days30 } }, _sum: { total: true }, orderBy: { _sum: { total: 'desc' } }, take: 5 }),
    ]);
    const topNames = await p.customer.findMany({ where: { id: { in: top.map(t => t.customerId) } }, select: { id: true, name: true } });
    const [byStatus, today, month, newCustomers, joinRequests, customers, reported, chequesDue, invoiced, paid, list, variants, recent, daily] = await Promise.all([
      p.order.groupBy({ by: ['status'], _count: true }),
      p.order.count({ where: { createdAt: { gte: startOfDay } } }),
      p.order.count({ where: { createdAt: { gte: days30 } } }),
      p.customer.count({ where: { isApproved: false } }),
      p.joinRequest.count({ where: { status: 'PENDING' } }),
      p.customer.count({ where: { isApproved: true } }),
      p.payment.count({ where: { status: 'REPORTED' } }),
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
      queue: {
        salesReview: n('SUBMITTED', 'SALES_REVIEW', 'PROFORMA_EXPIRED'),
        awaitingCustomer: n('PROFORMA_SENT'),
        finalApproval: n('SALES_APPROVED'),
        needsFix: n('NEEDS_FIX'),
        warehouse: n('CONFIRMED', 'PREPARING'),
        newCustomers, joinRequests, reportedPayments: reported, unansweredChats: Number(unanswered[0]?.n ?? 0),
      },
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
