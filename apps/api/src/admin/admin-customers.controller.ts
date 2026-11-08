import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CustomerType, MemberRole } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
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

  /** Search by name, city or «کد مشتری»; `support` filters by sales agent («none» = unassigned). */
  @Get()
  list(@Query('q') q?: string, @Query('support') support?: string) {
    const t = (q ?? '').trim(), code = Number(fa(t));
    return this.prisma.customer.findMany({
      where: {
        ...(t ? { OR: [{ name: { contains: t } }, { city: { contains: t } }, ...(Number.isInteger(code) && code > 0 && code < 2e9 ? [{ code }] : [])] } : {}),
        ...(support === 'none' ? { supportId: null } : support ? { supportId: support } : {}),
      },
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

  /** Assign many customers to one sales agent at once (or clear it with supportId null). Managers only. */
  @Post('assign')
  @Staff('ADMIN')
  async assign(@Session() s: SessionClaims, @Body() b: { ids?: string[]; supportId?: string | null }) {
    const ids = Array.isArray(b?.ids) ? [...new Set(b.ids.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new BadRequestException('مشتری‌ای انتخاب نشده است');
    if (b.supportId) {
      const sup = await this.prisma.user.findUnique({ where: { id: b.supportId } });
      if (!sup?.staffRole || !sup.isActive) throw new BadRequestException('کارشناس نامعتبر است');
    }
    const r = await this.prisma.customer.updateMany({ where: { id: { in: ids } }, data: { supportId: b.supportId || null } });
    await audit(this.prisma, s.sub, 'customer.assign', 'Customer', ids.join(',').slice(0, 190), null, { supportId: b.supportId || null, count: r.count });
    return { count: r.count };
  }

  /** Deletes a customer that has no orders, invoices or payments yet (a duplicate or a mistake). */
  @Delete(':id')
  @Staff('ADMIN')
  async remove(@Session() s: SessionClaims, @Param('id') id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id }, include: { _count: { select: { orders: true, invoices: true, payments: true } } } });
    if (!c) throw new NotFoundException();
    if (c._count.orders || c._count.invoices || c._count.payments) throw new BadRequestException('این مشتری سفارش یا حساب مالی دارد و حذف نمی‌شود؛ می‌توانید کاربرانش را حذف یا او را به مشتری دیگری منتقل کنید.');
    await this.prisma.customer.delete({ where: { id } });
    await audit(this.prisma, s.sub, 'customer.delete', 'Customer', id, c, null);
    return { ok: true };
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

  @Patch(':id/members/:userId')
  async setMember(@Session() s: SessionClaims, @Param('id') id: string, @Param('userId') userId: string, @Body() b: { role?: string; firstName?: string; lastName?: string }) {
    const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: id, userId } } });
    if (!m) throw new NotFoundException();
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role as MemberRole)) throw new BadRequestException('نقش نامعتبر است');
      await this.prisma.customerMember.update({ where: { customerId_userId: { customerId: id, userId } }, data: { role: b.role as MemberRole } });
    }
    if (b.firstName !== undefined || b.lastName !== undefined)
      await this.prisma.user.update({ where: { id: userId }, data: { ...(b.firstName !== undefined ? { firstName: b.firstName.trim().slice(0, 60) || null } : {}), ...(b.lastName !== undefined ? { lastName: b.lastName.trim().slice(0, 60) || null } : {}) } });
    await audit(this.prisma, s.sub, 'member.update', 'Customer', id, m, { userId, ...b });
    return { ok: true };
  }

  @Delete(':id/members/:userId')
  async removeMember(@Session() s: SessionClaims, @Param('id') id: string, @Param('userId') userId: string) {
    await this.prisma.customerMember.delete({ where: { customerId_userId: { customerId: id, userId } } }).catch(() => { throw new NotFoundException(); });
    await audit(this.prisma, s.sub, 'member.remove', 'Customer', id, { userId }, null);
    return { ok: true };
  }
}

/** «درخواست عضویت»: users who asked to join a customer account with its code. Managers approve or reject. */
@Controller('admin/joins')
@UseGuards(SessionGuard)
@Staff()
export class AdminJoinsController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.prisma.joinRequest.findMany({
      where: { status: status === 'all' ? undefined : 'PENDING' },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: {
        user: { select: { id: true, telegramId: true, firstName: true, lastName: true, username: true, memberships: { select: { customer: { select: { name: true } } } } } },
        customer: { select: { id: true, name: true, city: true, code: true, _count: { select: { members: true } } } },
      },
    });
  }

  @Post(':id')
  @Staff('ADMIN')
  async decide(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { ok?: boolean; role?: string }) {
    const r = await this.prisma.joinRequest.findUnique({ where: { id }, include: { user: true, customer: true } });
    if (!r) throw new NotFoundException();
    if (r.status !== 'PENDING') throw new BadRequestException('این درخواست قبلاً بررسی شده است');
    const ok = b?.ok !== false;
    const role = ROLES.includes(b?.role as MemberRole) ? (b.role as MemberRole) : r.role;
    await this.prisma.$transaction([
      this.prisma.joinRequest.update({ where: { id }, data: { status: ok ? 'APPROVED' : 'REJECTED', role, decidedById: s.sub, decidedAt: new Date() } }),
      ...(ok ? [this.prisma.customerMember.upsert({ where: { customerId_userId: { customerId: r.customerId, userId: r.userId } }, create: { customerId: r.customerId, userId: r.userId, role }, update: { role } })] : []),
    ]);
    await audit(this.prisma, s.sub, ok ? 'join.approve' : 'join.reject', 'Customer', r.customerId, null, { userId: r.userId, role });
    const kb = ok && process.env.MINIAPP_URL ? { inline_keyboard: [[{ text: '📱 ورود به پنل کاربری', web_app: { url: process.env.MINIAPP_URL } }]] } : undefined;
    await this.tg.send(r.user.telegramId, ok
      ? `✅ عضویت شما در «${r.customer.name}» تأیید شد (${ROLE_TEXT[role]}).\nاز این به بعد می‌توانید برای این مجموعه سفارش ثبت کنید.`
      : `درخواست عضویت شما در «${r.customer.name}» تأیید نشد. برای پیگیری به کارشناس فروش پیام بدهید.`, kb);
    return { ok: true };
  }
}

const ROLE_TEXT: Record<MemberRole, string> = { OWNER: 'مدیر حساب', BUYER: 'کارشناس خرید', VIEWER: 'فقط مشاهده' };
