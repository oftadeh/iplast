import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { OrdersService, ProformaEdit, STATUS_FA } from '../orders/orders.service';
import { audit } from '../common/audit';

const STATUSES = Object.keys(STATUS_FA) as OrderStatus[];

@Controller('admin/orders')
@UseGuards(SessionGuard)
@Staff('ADMIN', 'SALES', 'WAREHOUSE')
export class AdminOrdersController {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService, private readonly tg: TelegramService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('q') q?: string) {
    const wanted = (status ?? '').split(',').filter(x => STATUSES.includes(x as OrderStatus)) as OrderStatus[];
    const where = {
      ...(wanted.length ? { status: { in: wanted } } : {}),
      ...(q ? { OR: [{ customer: { name: { contains: q } } }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])] } : {}),
    };
    const rows = await this.prisma.order.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: { items: true, customer: { select: { id: true, name: true, support: { select: { firstName: true, lastName: true } } } }, placedBy: { select: { firstName: true, lastName: true, username: true } } },
    });
    const counts = await this.prisma.order.groupBy({ by: ['status'], _count: true });
    return {
      rows: rows.map(o => ({ ...o, items: undefined, itemCount: o.items.length, inquiryCount: o.items.filter(i => i.unitPrice === null).length, total: this.orders.orderTotal(o.items), payable: this.orders.breakdown(o).total, statusFa: STATUS_FA[o.status] })),
      counts: Object.fromEntries(counts.map(c => [c.status, c._count])),
      statuses: STATUSES.map(s => ({ id: s, fa: STATUS_FA[s] })),
    };
  }

  @Get(':id') one(@Session() s: SessionClaims, @Param('id') id: string) { return this.orders.get(s.sub, id, true); }

  /** Approval steps: sales_ok (sales agent), final_ok (manager), fix (with a note), reject. */
  @Post(':id/decide')
  async decide(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { action?: string; comment?: string; edit?: ProformaEdit }) {
    const before = await this.prisma.order.findUnique({ where: { id }, select: { status: true, discount: true, shipping: true, items: { select: { id: true, quantity: true, unitPrice: true } } } });
    const r = await this.orders.decide(s.sub, id, String(b?.action), b?.comment, b?.edit);
    await audit(this.prisma, s.sub, 'order.decide', 'Order', id, before ? JSON.parse(JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) : null, { action: b?.action, status: r.status, comment: b?.comment, edit: b?.edit ?? null } as object);
    return this.orders.get(s.sub, id, true);
  }

  /** After the final approval: preparing, shipped, delivered, or cancelled. Managers only. */
  @Patch(':id/status')
  @Staff('ADMIN')
  async setStatus(@Session() s: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; comment?: string }) {
    const status = body?.status as OrderStatus;
    if (!(['PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as OrderStatus[]).includes(status)) throw new BadRequestException('وضعیت نامعتبر است');
    const comment = body.comment?.slice(0, 1000);
    const r = await this.orders.setStatus(s.sub, id, status, comment);
    await audit(this.prisma, s.sub, 'order.status', 'Order', id, { status: r.before }, { status, comment });
    return this.orders.get(s.sub, id, true);
  }
}
