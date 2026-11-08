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
    const [byStatus, today, month, newCustomers, customers, reported, chequesDue, invoiced, paid, list, variants, recent, daily] = await Promise.all([
      p.order.groupBy({ by: ['status'], _count: true }),
      p.order.count({ where: { createdAt: { gte: startOfDay } } }),
      p.order.count({ where: { createdAt: { gte: days30 } } }),
      p.customer.count({ where: { isApproved: false } }),
      p.customer.count({ where: { isApproved: true } }),
      p.payment.count({ where: { status: 'REPORTED' } }),
      p.payment.aggregate({ where: { status: 'PENDING', dueDate: { lte: week } }, _sum: { amount: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED' }, _sum: { total: true } }),
      p.payment.aggregate({ where: { status: 'CLEARED' }, _sum: { amount: true } }),
      p.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' }, select: { id: true, title: true, publishedAt: true, _count: { select: { prices: { where: { status: 'INQUIRY' } } } } } }),
      p.variant.count(),
      p.order.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, number: true, status: true, createdAt: true, customer: { select: { name: true } }, _count: { select: { items: true } } } }),
      p.$queryRaw<{ d: Date; n: bigint }[]>`SELECT date_trunc('day', "createdAt") AS d, count(*)::bigint AS n FROM "Order" WHERE "createdAt" >= ${new Date(Date.now() - 14 * 864e5)} GROUP BY 1 ORDER BY 1`,
    ]);
    const c = Object.fromEntries(byStatus.map(x => [x.status, x._count])) as Record<string, number>;
    const n = (...k: string[]) => k.reduce((a, x) => a + (c[x] ?? 0), 0);
    const inv = invoiced._sum.total ?? 0n, pd = paid._sum.amount ?? 0n;
    return {
      role: s.staff,
      queue: {
        salesReview: n('SUBMITTED', 'SALES_REVIEW'),
        finalApproval: n('SALES_APPROVED'),
        needsFix: n('NEEDS_FIX'),
        warehouse: n('CONFIRMED', 'PREPARING'),
        newCustomers, reportedPayments: reported, unansweredChats: Number(unanswered[0]?.n ?? 0),
      },
      orders: { today, last30: month, open: n('SUBMITTED', 'SALES_REVIEW', 'SALES_APPROVED', 'NEEDS_FIX', 'PROFORMA_SENT', 'CONFIRMED', 'PREPARING', 'SHIPPED'), delivered: n('DELIVERED'), byStatus: c },
      money: { receivable: inv - pd, invoiced: inv, chequesDue7: chequesDue._sum.amount ?? 0n, chequesDue7Count: chequesDue._count },
      catalog: { variants, inquiry: list?._count.prices ?? 0, activeList: list ? { id: list.id, title: list.title, publishedAt: list.publishedAt } : null },
      customers,
      daily: daily.map(r => ({ d: r.d, n: Number(r.n) })),
      recent,
    };
  }
}
