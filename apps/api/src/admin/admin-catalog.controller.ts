import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { toEnDigits } from '../common/validate';
import { categoryTree } from '../catalog/tree';

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const MAX_DEPTH = 3; // شاخه › زیرشاخه › زیرِ زیرشاخه

/**
 * The category tree: branches and sub-branches of the catalog. Managers add, rename, move and order categories and
 * move products between them. Any staff member can look.
 */
@Controller('admin/categories')
@UseGuards(SessionGuard)
@Staff()
export class AdminCategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const [tree, counts] = await Promise.all([
      categoryTree(this.prisma),
      this.prisma.productFamily.groupBy({ by: ['categoryId'], _count: { _all: true } }),
    ]);
    const own = new Map(counts.map(c => [c.categoryId, c._count._all]));
    return tree.ordered().map(c => ({
      id: c.id, slug: c.slug, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder, depth: c.depth, path: tree.path(c.id),
      families: own.get(c.id) ?? 0, total: tree.descendants(c.id).reduce((n, id) => n + (own.get(id) ?? 0), 0),
      children: (tree.kids.get(c.id) ?? []).length,
    }));
  }

  private async checkParent(parentId: string | null, selfId?: string) {
    if (!parentId) return 0;
    const tree = await categoryTree(this.prisma);
    if (!tree.byId.has(parentId)) throw new BadRequestException('شاخه‌ی بالایی پیدا نشد');
    if (selfId && tree.chain(parentId).includes(selfId)) throw new BadRequestException('یک دسته را نمی‌شود زیر خودش یا زیرشاخه‌هایش برد');
    const depth = tree.chain(parentId).length; // the new category sits one level below
    const below = selfId ? Math.max(...tree.descendants(selfId).map(id => tree.chain(id).length - tree.chain(selfId).length)) : 0;
    if (depth + below >= MAX_DEPTH) throw new BadRequestException(`درخت دسته‌ها حداکثر ${MAX_DEPTH} سطح دارد`);
    return depth;
  }

  @Post()
  @Staff('ADMIN')
  async create(@Session() s: SessionClaims, @Body() b: { name?: string; parentId?: string | null }) {
    const name = text(b?.name, 60);
    if (!name) throw new BadRequestException('نام دسته لازم است');
    const parentId = b.parentId || null;
    await this.checkParent(parentId);
    const last = await this.prisma.category.findFirst({ where: { parentId }, orderBy: { sortOrder: 'desc' } });
    const c = await this.prisma.category.create({ data: { name, parentId, slug: `c-${randomBytes(4).toString('hex')}`, sortOrder: (last?.sortOrder ?? -1) + 1 } });
    await audit(this.prisma, s.sub, 'category.create', 'Category', c.id, null, { name, parentId });
    return this.list();
  }

  /** Rename, or move under another branch (null = a main branch). */
  @Patch(':id')
  @Staff('ADMIN')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { name?: string; parentId?: string | null }) {
    const c = await this.prisma.category.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    const data: { name?: string; parentId?: string | null; sortOrder?: number } = {};
    if (b.name !== undefined) { const n = text(b.name, 60); if (!n) throw new BadRequestException('نام دسته لازم است'); data.name = n; }
    if (b.parentId !== undefined && (b.parentId || null) !== c.parentId) {
      data.parentId = b.parentId || null;
      await this.checkParent(data.parentId, id);
      const last = await this.prisma.category.findFirst({ where: { parentId: data.parentId }, orderBy: { sortOrder: 'desc' } });
      data.sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    await this.prisma.category.update({ where: { id }, data });
    await audit(this.prisma, s.sub, 'category.update', 'Category', id, { name: c.name, parentId: c.parentId }, data);
    return this.list();
  }

  /** One step up or down among its siblings. */
  @Post(':id/move')
  @Staff('ADMIN')
  async move(@Param('id') id: string, @Body() b: { dir?: 'up' | 'down' }) {
    const c = await this.prisma.category.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    const tree = await categoryTree(this.prisma);
    const sibs = [...(tree.kids.get(c.parentId && tree.byId.has(c.parentId) ? c.parentId : null) ?? [])];
    const i = sibs.findIndex(x => x.id === id);
    const j = b?.dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= sibs.length) return this.list();
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    await this.prisma.$transaction(sibs.map((x, k) => this.prisma.category.update({ where: { id: x.id }, data: { sortOrder: k } })));
    return this.list();
  }

  /**
   * Delete a category. Its products and sub-branches move to `moveTo` (or to its own parent branch); a main branch
   * with products needs `moveTo`. Customers' percents set on it are dropped.
   */
  @Delete(':id')
  @Staff('ADMIN')
  async remove(@Session() s: SessionClaims, @Param('id') id: string, @Query('moveTo') moveTo?: string) {
    const c = await this.prisma.category.findUnique({ where: { id }, include: { _count: { select: { families: true, children: true } } } });
    if (!c) throw new NotFoundException();
    const target = moveTo || c.parentId;
    if (target === id) throw new BadRequestException('مقصد نامعتبر است');
    if (target) {
      const tree = await categoryTree(this.prisma);
      if (!tree.byId.has(target) || tree.chain(target).includes(id)) throw new BadRequestException('مقصد نامعتبر است');
    }
    if (c._count.families && !target) throw new BadRequestException('این شاخه کالا دارد؛ بگویید کالاهایش به کدام دسته بروند');
    await this.prisma.$transaction([
      ...(target ? [this.prisma.productFamily.updateMany({ where: { categoryId: id }, data: { categoryId: target } })] : []),
      this.prisma.category.updateMany({ where: { parentId: id }, data: { parentId: c.parentId } }),
      this.prisma.category.delete({ where: { id } }),
    ]);
    await audit(this.prisma, s.sub, 'category.delete', 'Category', id, { name: c.name, parentId: c.parentId }, { moveTo: target });
    return this.list();
  }

  /** Move products to this category (from the category page: tick products, «انتقال به …»). */
  @Post(':id/families')
  @Staff('ADMIN')
  async assign(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { familyIds?: string[] }) {
    if (!(await this.prisma.category.findUnique({ where: { id } }))) throw new NotFoundException();
    const ids = (Array.isArray(b?.familyIds) ? b.familyIds : []).filter(x => typeof x === 'string').slice(0, 500);
    if (!ids.length) throw new BadRequestException('کالایی انتخاب نشده است');
    const r = await this.prisma.productFamily.updateMany({ where: { id: { in: ids } }, data: { categoryId: id } });
    await audit(this.prisma, s.sub, 'category.assign', 'Category', id, null, { familyIds: ids });
    return { moved: r.count };
  }
}

const KIND = ['EXTRA', 'FIXED'] as const;
function pctOf(v: unknown) {
  const n = Number(toEnDigits(String(v ?? '')).replace(/[٪%\s]/g, '').replace('٫', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new BadRequestException('درصد باید بین ۰ و ۱۰۰ باشد');
  return Math.round(n * 100) / 100;
}
function dateOf(v: unknown, what: string) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`تاریخ ${what} نامعتبر است`);
  return d;
}

/**
 * «تخفیف ویژه»: a senior manager's discount on one product, on top of (or instead of) the customer's own percent,
 * for every customer or one, for نقدی / مدت‌دار or both, from a minimum number of cartons, within dates.
 * Staff can look; only ADMIN (مدیر ارشد) can change them.
 */
@Controller('admin/specials')
@UseGuards(SessionGuard)
@Staff()
export class AdminSpecialsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query('family') familyId?: string, @Query('customer') customerId?: string) {
    const rows = await this.prisma.specialDiscount.findMany({
      where: { ...(familyId ? { familyId } : {}), ...(customerId ? { customerId } : {}) },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], take: 500,
      include: { family: { select: { id: true, name: true, packName: true, unitName: true, media: { where: { isPrimary: true }, take: 1, select: { key: true } } } }, customer: { select: { id: true, name: true, code: true } } },
    });
    const now = new Date();
    return rows.map(r => ({
      ...r, pct: Number(r.pct),
      state: !r.isActive ? 'off' : r.endsAt && r.endsAt < now ? 'ended' : r.startsAt && r.startsAt > now ? 'later' : 'on',
    }));
  }

  private async data(b: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || b.familyId !== undefined) {
      const f = typeof b.familyId === 'string' ? await this.prisma.productFamily.findUnique({ where: { id: b.familyId } }) : null;
      if (!f) throw new BadRequestException('کالا را انتخاب کنید');
      out.familyId = f.id;
    }
    if (!partial || b.customerId !== undefined) {
      if (b.customerId) {
        const c = await this.prisma.customer.findUnique({ where: { id: String(b.customerId) } });
        if (!c) throw new BadRequestException('مشتری پیدا نشد');
        out.customerId = c.id;
      } else out.customerId = null;
    }
    if (!partial || b.payMode !== undefined) out.payMode = b.payMode === 'CASH' || b.payMode === 'TERM' ? b.payMode : null;
    if (!partial || b.kind !== undefined) out.kind = KIND.includes(b.kind as never) ? b.kind : 'EXTRA';
    if (!partial || b.pct !== undefined) out.pct = pctOf(b.pct);
    if (!partial || b.minPacks !== undefined) {
      const raw = toEnDigits(String(b.minPacks ?? '')).trim();
      const n = raw ? Number(raw) : null;
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 1_000_000)) throw new BadRequestException('حداقل تعداد کارتن نامعتبر است');
      out.minPacks = n;
    }
    if (!partial || b.startsAt !== undefined) out.startsAt = dateOf(b.startsAt, 'شروع');
    if (!partial || b.endsAt !== undefined) out.endsAt = dateOf(b.endsAt, 'پایان');
    if (out.startsAt && out.endsAt && (out.startsAt as Date) > (out.endsAt as Date)) throw new BadRequestException('تاریخ پایان قبل از شروع است');
    if (!partial || b.note !== undefined) out.note = text(b.note, 120);
    if (b.isActive !== undefined) out.isActive = !!b.isActive;
    return out;
  }

  @Post()
  @Staff('ADMIN')
  async create(@Session() s: SessionClaims, @Body() b: Record<string, unknown>) {
    const d = await this.data(b ?? {}, false);
    const r = await this.prisma.specialDiscount.create({ data: { ...(d as { familyId: string; pct: number }), createdBy: s.sub } });
    await audit(this.prisma, s.sub, 'special.create', 'SpecialDiscount', r.id, null, d);
    return r;
  }

  @Patch(':id')
  @Staff('ADMIN')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: Record<string, unknown>) {
    const before = await this.prisma.specialDiscount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const d = await this.data(b ?? {}, true);
    const r = await this.prisma.specialDiscount.update({ where: { id }, data: d });
    await audit(this.prisma, s.sub, 'special.update', 'SpecialDiscount', id, before, d);
    return r;
  }

  @Delete(':id')
  @Staff('ADMIN')
  async remove(@Session() s: SessionClaims, @Param('id') id: string) {
    const before = await this.prisma.specialDiscount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.prisma.specialDiscount.delete({ where: { id } });
    await audit(this.prisma, s.sub, 'special.delete', 'SpecialDiscount', id, before, null);
    return { ok: true };
  }
}
