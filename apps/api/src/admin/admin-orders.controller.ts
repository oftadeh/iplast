import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { OrdersService, OrderInput, ProformaEdit, STATUS_FA } from '../orders/orders.service';
import { quote, saleTerms, modeFor } from '../orders/pricing';
import { ForbiddenException } from '@nestjs/common';
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

  /** Sizes for the agent's «ثبت سفارش برای مشتری» form, priced for that customer and sale type. */
  @Get('variants')
  @Staff('ADMIN', 'SALES')
  async variants(@Query('q') q?: string, @Query('customerId') customerId?: string, @Query('mode') mode?: string) {
    const words = (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    if (!words.length) return [];
    const vs = await this.prisma.variant.findMany({
      where: { isActive: true, family: { isActive: true }, AND: words.map(w => ({ OR: [{ title: { contains: w } }, { family: { name: { contains: w } } }, { family: { synonyms: { some: { term: { contains: w } } } } }, { options: { some: { value: { contains: w } } } }] })) },
      take: 40, orderBy: [{ family: { sortOrder: 'asc' } }, { sku: 'asc' }],
      include: { options: true, family: { include: { axes: { orderBy: { sortOrder: 'asc' } } } } },
    });
    const terms = customerId ? await saleTerms(this.prisma, customerId) : undefined;
    const qt = await quote(this.prisma, vs.map(v => v.id), customerId ?? null, terms ? modeFor(terms, mode) : 'CASH', terms);
    return vs.map(v => {
      const f = v.family;
      const label = f.axes.length ? f.axes.map(a => v.options.find(o => o.axisId === a.id)?.value ?? '').filter(Boolean).join(' × ') : v.title;
      const x = qt.get(v.id);
      return { variantId: v.id, name: f.name, label, perPack: v.perPack, packName: f.packName, unitName: f.unitName, list: x?.listPrice?.toString() ?? null, price: x?.unitPrice?.toString() ?? null };
    });
  }

  /** A phone order the agent enters for the customer; it then follows the normal proforma steps. */
  @Post()
  @Staff('ADMIN', 'SALES')
  async place(@Session() s: SessionClaims, @Body() b: OrderInput) {
    const c = await this.prisma.customer.findUnique({ where: { id: String(b?.customerId ?? '-') } });
    if (!c) throw new BadRequestException('مشتری را انتخاب کنید');
    if (s.staff === 'SALES' && c.supportId && c.supportId !== s.sub) throw new ForbiddenException('این مشتری کارشناس دیگری دارد');
    const o = await this.orders.create(s.sub, { ...b, idempotencyKey: undefined }, 'admin');
    await audit(this.prisma, s.sub, 'order.placeForCustomer', 'Order', o.id, null, { customerId: c.id, items: b.items?.length ?? 0 });
    return o;
  }

  @Get(':id')
  async one(@Session() s: SessionClaims, @Param('id') id: string) {
    const o = await this.orders.get(s.sub, id, true);
    return { ...o, credit: await this.orders.credit(o.customerId, o.payable === undefined ? 0n : BigInt(o.payable)) };
  }

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
