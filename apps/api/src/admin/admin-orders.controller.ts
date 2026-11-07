import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { OrdersService, STATUS_FA } from '../orders/orders.service';
import { audit } from '../common/audit';

const STATUSES = Object.keys(STATUS_FA) as OrderStatus[];

@Controller('admin/orders')
@UseGuards(SessionGuard)
@Staff()
export class AdminOrdersController {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService, private readonly tg: TelegramService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('q') q?: string) {
    const where = {
      ...(status && STATUSES.includes(status as OrderStatus) ? { status: status as OrderStatus } : {}),
      ...(q ? { OR: [{ customer: { name: { contains: q } } }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])] } : {}),
    };
    const rows = await this.prisma.order.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: { items: true, customer: { select: { id: true, name: true } }, placedBy: { select: { firstName: true, lastName: true, username: true } } },
    });
    const counts = await this.prisma.order.groupBy({ by: ['status'], _count: true });
    return {
      rows: rows.map(o => ({ ...o, items: undefined, itemCount: o.items.length, inquiryCount: o.items.filter(i => i.unitPrice === null).length, total: this.orders.orderTotal(o.items), statusFa: STATUS_FA[o.status] })),
      counts: Object.fromEntries(counts.map(c => [c.status, c._count])),
      statuses: STATUSES.map(s => ({ id: s, fa: STATUS_FA[s] })),
    };
  }

  @Get(':id') one(@Session() s: SessionClaims, @Param('id') id: string) { return this.orders.get(s.sub, id, true); }

  /** Moves an order to a new status and tells the person who placed it, through the bot. */
  @Patch(':id/status')
  async setStatus(@Session() s: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; comment?: string }) {
    const status = body?.status as OrderStatus;
    if (!STATUSES.includes(status)) throw new BadRequestException('وضعیت نامعتبر است');
    const o = await this.prisma.order.findUnique({ where: { id }, include: { placedBy: true } });
    if (!o) throw new NotFoundException();
    const comment = body.comment?.slice(0, 1000);
    await this.prisma.order.update({ where: { id }, data: { status, events: { create: { status, byUserId: s.sub, comment } } } });
    await audit(this.prisma, s.sub, 'order.status', 'Order', id, { status: o.status }, { status, comment });
    await this.tg.send(o.placedBy.telegramId, `وضعیت سفارش #${o.number}: ${STATUS_FA[status]}${comment ? `\nتوضیح: ${comment}` : ''}`);
    return this.orders.get(s.sub, id, true);
  }
}
