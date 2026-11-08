import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CustomerType, MemberRole } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { int, req, rialOf, telegramId } from '../common/validate';

const TYPES: CustomerType[] = ['RETAIL', 'DEALER', 'CONTRACTOR'];
const ROLES: MemberRole[] = ['OWNER', 'BUYER', 'VIEWER'];
/** Persian digits and decimal sign to plain ones. */
const fa = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٫/]/, '.') : v);
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
      include: { terms: true, support: { select: { id: true, firstName: true, lastName: true, username: true, staffRole: true } }, priceGroup: true, members: { include: { user: true } }, orders: { orderBy: { createdAt: 'desc' }, take: 20 } },
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
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { name?: string; city?: string; address?: string; type?: string; isApproved?: boolean; supportId?: string | null; creditLimit?: string | number | null }) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (b.supportId !== undefined && b.supportId !== before.supportId && s.staff !== 'ADMIN') throw new ForbiddenException('تعیین کارشناس فقط با مدیر است');
    if (b.creditLimit !== undefined && s.staff !== 'ADMIN') throw new ForbiddenException('تعیین سقف اعتبار فقط با مدیر است');
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
        ...(b.creditLimit !== undefined ? { creditLimit: b.creditLimit === null || String(b.creditLimit).trim() === '' ? null : rialOf(b.creditLimit, 'سقف اعتبار', true) } : {}),
      },
    });
    await audit(this.prisma, s.sub, 'customer.update', 'Customer', id, before, c);
    return c;
  }

  /**
   * The customer's sale terms: «نقدی» % off the list price, «مدت‌دار» % off with the number of months, which of the
   * two they may use, and per product category the two percentages when they differ from the default.
   */
  @Get(':id/sale')
  async sale(@Param('id') id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id }, include: { terms: true, categoryDiscounts: true } });
    if (!c) throw new NotFoundException();
    const cats = await this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { families: true } } } });
    const t = c.terms;
    const n = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()));
    return {
      cashPct: n(t?.cashDiscountPct) ?? 0, termPct: n(t?.termDiscountPct) ?? 0, termMonths: t?.termMonths ?? 3,
      allowCash: t?.allowCash ?? true, allowTerm: t?.allowTerm ?? true, updatedAt: t?.updatedAt ?? null,
      categories: cats.map(k => { const d = c.categoryDiscounts.find(x => x.categoryId === k.id); return { id: k.id, slug: k.slug, name: k.name, families: k._count.families, cash: n(d?.cashPct), term: n(d?.termPct) }; }),
    };
  }

  /** Managers set the sale terms. A category with both percentages empty follows the customer's default. */
  @Put(':id/sale')
  @Staff('ADMIN')
  async setSale(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { cashPct?: unknown; termPct?: unknown; termMonths?: unknown; allowCash?: boolean; allowTerm?: boolean; categories?: { id?: string; cash?: unknown; term?: unknown }[] }) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException();
    const opt = (v: unknown, msg: string) => (v === null || v === undefined || String(v).trim() === '' ? null : pct(fa(v), msg));
    const allowCash = b?.allowCash !== false, allowTerm = b?.allowTerm !== false;
    if (!allowCash && !allowTerm) throw new BadRequestException('دست‌کم یکی از «نقدی» یا «مدت‌دار» باید فعال باشد');
    const data = {
      cashDiscountPct: pct(fa(b.cashPct), 'درصد نقدی باید بین ۰ تا ۱۰۰ باشد'),
      termDiscountPct: pct(fa(b.termPct), 'درصد مدت‌دار باید بین ۰ تا ۱۰۰ باشد'),
      termMonths: int(Number(fa(b.termMonths ?? 3)), 'مدت باید بین ۱ تا ۳۶ ماه باشد', 1, 36),
      allowCash, allowTerm, updatedBy: s.sub,
    };
    const items = Array.isArray(b.categories) ? b.categories.slice(0, 200) : [];
    const cats = new Map((await this.prisma.category.findMany({ select: { id: true, name: true } })).map(c => [c.id, c.name]));
    const rows = items.map(it => {
      const name = cats.get(String(it.id));
      if (!name) throw new BadRequestException('دسته‌ی کالا نامعتبر است');
      return { categoryId: String(it.id), cashPct: opt(it.cash, `درصد نقدی «${name}» نامعتبر است`), termPct: opt(it.term, `درصد مدت‌دار «${name}» نامعتبر است`) };
    });
    const before = await this.sale(id);
    await this.prisma.$transaction([
      this.prisma.paymentTerms.upsert({ where: { customerId: id }, create: { customerId: id, ...data }, update: data }),
      ...rows.map(r => r.cashPct === null && r.termPct === null
        ? this.prisma.customerCategoryDiscount.deleteMany({ where: { customerId: id, categoryId: r.categoryId } })
        : this.prisma.customerCategoryDiscount.upsert({ where: { customerId_categoryId: { customerId: id, categoryId: r.categoryId } }, create: { customerId: id, ...r, updatedBy: s.sub }, update: { cashPct: r.cashPct, termPct: r.termPct, updatedBy: s.sub } })),
    ]);
    const after = await this.sale(id);
    await audit(this.prisma, s.sub, 'customer.sale', 'Customer', id, before, after);
    return after;
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
