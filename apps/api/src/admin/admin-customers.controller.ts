import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CustomerType, MemberRole } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { int, req, telegramId } from '../common/validate';

const TYPES: CustomerType[] = ['RETAIL', 'DEALER', 'CONTRACTOR'];
const ROLES: MemberRole[] = ['OWNER', 'BUYER', 'VIEWER'];
const pct = (v: unknown, msg: string) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(msg);
  return Math.round(n * 100) / 100;
};

@Controller('admin/customers')
@UseGuards(SessionGuard)
@Staff()
export class AdminCustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.prisma.customer.findMany({
      where: q ? { name: { contains: q } } : {},
      orderBy: { createdAt: 'desc' }, take: 200,
      include: { terms: true, support: { select: { id: true, firstName: true, lastName: true } }, _count: { select: { members: true, orders: true } } },
    });
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: { terms: true, support: true, priceGroup: true, members: { include: { user: true } }, orders: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!c) throw new NotFoundException();
    return c;
  }

  @Post()
  async create(@Session() s: SessionClaims, @Body() b: { name?: string; city?: string; type?: string }) {
    const c = await this.prisma.customer.create({
      data: { name: req(b?.name, 'نام مشتری لازم است').trim().slice(0, 120), city: b.city?.slice(0, 60), type: TYPES.includes(b.type as CustomerType) ? (b.type as CustomerType) : 'RETAIL', isApproved: true },
    });
    await audit(this.prisma, s.sub, 'customer.create', 'Customer', c.id, null, c);
    return c;
  }

  @Patch(':id')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { name?: string; city?: string; address?: string; type?: string; isApproved?: boolean; supportId?: string | null }) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (b.supportId) {
      const sup = await this.prisma.user.findUnique({ where: { id: b.supportId } });
      if (!sup?.staffRole) throw new BadRequestException('پشتیبان نامعتبر است');
    }
    const c = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: req(b.name, 'نام مشتری لازم است').slice(0, 120) } : {}),
        ...(b.city !== undefined ? { city: b.city } : {}),
        ...(b.address !== undefined ? { address: b.address } : {}),
        ...(b.type !== undefined && TYPES.includes(b.type as CustomerType) ? { type: b.type as CustomerType } : {}),
        ...(b.isApproved !== undefined ? { isApproved: !!b.isApproved } : {}),
        ...(b.supportId !== undefined ? { supportId: b.supportId || null } : {}),
      },
    });
    await audit(this.prisma, s.sub, 'customer.update', 'Customer', id, before, c);
    return c;
  }

  /** Cash/cheque terms for this customer. These become the default in the customer's cart. Admin only. */
  @Put(':id/terms')
  @Staff('ADMIN')
  async terms(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { cashPercent?: number; chequeDueDays?: number[]; cashDiscountPct?: number; chequeMarkupPct?: number }) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException();
    const data = {
      cashPercent: int(b?.cashPercent, 'درصد نقد باید بین ۰ تا ۱۰۰ باشد', 0, 100),
      chequeDueDays: (Array.isArray(b.chequeDueDays) ? b.chequeDueDays : []).slice(0, 12).map(d => int(d, 'سررسید چک نامعتبر است', 0, 720)),
      cashDiscountPct: pct(b.cashDiscountPct, 'درصد تخفیف نقدی نامعتبر است'),
      chequeMarkupPct: pct(b.chequeMarkupPct, 'درصد افزایش چکی نامعتبر است'),
      updatedBy: s.sub,
    };
    const before = await this.prisma.paymentTerms.findUnique({ where: { customerId: id } });
    const t = await this.prisma.paymentTerms.upsert({ where: { customerId: id }, create: { customerId: id, ...data }, update: data });
    await audit(this.prisma, s.sub, 'terms.update', 'Customer', id, before, t);
    return t;
  }

  /** Adds a Telegram user to the customer (another purchasing agent, for example). */
  @Post(':id/members')
  async addMember(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { telegramId?: string; role?: string; firstName?: string }) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException();
    const tg = telegramId(b?.telegramId);
    const role = ROLES.includes(b.role as MemberRole) ? (b.role as MemberRole) : 'BUYER';
    const user = await this.prisma.user.upsert({ where: { telegramId: tg }, create: { telegramId: tg, firstName: b.firstName?.slice(0, 60) }, update: {} });
    const m = await this.prisma.customerMember.upsert({
      where: { customerId_userId: { customerId: id, userId: user.id } },
      create: { customerId: id, userId: user.id, role }, update: { role },
    });
    await audit(this.prisma, s.sub, 'member.add', 'Customer', id, null, { userId: user.id, role });
    return m;
  }

  @Delete(':id/members/:userId')
  async removeMember(@Session() s: SessionClaims, @Param('id') id: string, @Param('userId') userId: string) {
    await this.prisma.customerMember.delete({ where: { customerId_userId: { customerId: id, userId } } }).catch(() => { throw new NotFoundException(); });
    await audit(this.prisma, s.sub, 'member.remove', 'Customer', id, { userId }, null);
    return { ok: true };
  }
}
