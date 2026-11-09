import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { categoryTree } from '../catalog/tree';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/data/uploads';
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const rid = (n = 6) => randomBytes(n).toString('hex');
const FA = '۰۱۲۳۴۵۶۷۸۹';
const toEn = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Rial amount from the panel («۱۲,۵۰۰,۰۰۰» or 12500000); null = استعلامی. */
function amountOf(v: unknown): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  const s = toEn(String(v)).replace(/[,،\s]/g, '');
  if (!/^\d{1,15}$/.test(s)) throw new BadRequestException('قیمت باید عدد (ریال) باشد');
  const n = BigInt(s);
  if (n < 1000n) throw new BadRequestException('قیمت به ریال وارد شود');
  return n;
}
function perPackOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(toEn(String(v)));
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw new BadRequestException('تعداد در بسته نامعتبر است');
  return n;
}

/** موجودی in units; empty = not tracked, 0 = ناموجود. */
function stockOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(toEn(String(v)).replace(/[,،\s٬]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new BadRequestException('موجودی نامعتبر است');
  return n;
}

/** Product images uploaded from the panel, served publicly as /api/media/<file>. */
@Controller('media')
export class MediaController {
  @Get(':name')
  file(@Param('name') name: string, @Res() res: Response) {
    if (!/^[a-z0-9-]+\.(jpg|png|webp)$/.test(name)) throw new NotFoundException();
    const path = join(UPLOAD_DIR, name);
    if (!existsSync(path)) throw new NotFoundException();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(name.split('.').pop()!);
    createReadStream(path).pipe(res);
  }
}

/**
 * Products for the admin panel: define a product, its sizes (with code, pack count and price), photo and search words.
 * Any staff member can look; changes are for ADMIN.
 */
@Controller('admin/products')
@UseGuards(SessionGuard)
@Staff()
export class AdminProductsController {
  constructor(private readonly prisma: PrismaService) {}

  private activeList() {
    return this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
  }

  /** Categories in tree order with their path («اتصالات پیچی › زانو») and depth, for the pickers. */
  @Get('meta')
  async meta() {
    const [tree, brands] = await Promise.all([
      categoryTree(this.prisma),
      this.prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return { categories: tree.ordered().map(c => ({ id: c.id, name: c.name, path: tree.path(c.id), depth: c.depth, parentId: c.parentId })), brands };
  }

  @Get()
  async list(@Query('q') q?: string, @Query('category') category?: string) {
    const list = await this.activeList();
    const words = (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    // a branch lists the products of its sub-branches too
    const tree = await categoryTree(this.prisma);
    const cats = category ? tree.descendants(category) : null;
    const rows = await this.prisma.productFamily.findMany({
      where: {
        ...(cats ? { categoryId: { in: cats } } : {}),
        ...(words.length ? { AND: words.map(w => ({ OR: [{ name: { contains: w } }, { synonyms: { some: { term: { contains: w } } } }, { variants: { some: { accountingCode: { contains: toEn(w) } } } }] })) } : {}),
      },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      take: 300,
      select: {
        id: true, name: true, isActive: true, model: true, packOnly: true, packName: true, categoryId: true,
        category: { select: { name: true } },
        media: { where: { isPrimary: true }, take: 1, select: { key: true } },
        variants: { select: { isActive: true, stock: true, prices: { where: { priceListId: list?.id ?? '-' }, select: { status: true } } } },
        _count: { select: { specials: { where: { isActive: true } } } },
      },
    });
    return rows.map(({ variants, _count, ...f }) => ({
      ...f,
      category: { name: tree.byId.has(f.categoryId) ? tree.path(f.categoryId) : f.category.name },
      specials: _count.specials,
      soldOut: variants.filter(v => v.isActive && v.stock === 0).length,
      sizes: variants.length,
      priced: variants.filter(v => v.prices[0]?.status === 'PRICED').length,
      inactiveSizes: variants.filter(v => !v.isActive).length,
    }));
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const list = await this.activeList();
    const f = await this.prisma.productFamily.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } },
        axes: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }] },
        synonyms: { select: { term: true } },
        variants: {
          orderBy: { sku: 'asc' },
          include: { options: true, prices: { where: { priceListId: list?.id ?? '-' } } },
        },
      },
    });
    if (!f) throw new NotFoundException();
    const tree = await categoryTree(this.prisma);
    return {
      ...f,
      category: { ...f.category, path: tree.path(f.category.id) },
      synonyms: f.synonyms.map(s => s.term),
      priceList: list ? { id: list.id, title: list.title } : null,
      variants: f.variants.map(v => ({
        id: v.id, sku: v.sku, title: v.title, accountingCode: v.accountingCode, perPack: v.perPack, stock: v.stock, isActive: v.isActive,
        options: Object.fromEntries(v.options.map(o => [o.axisId, o.value])),
        price: v.prices[0]?.amount?.toString() ?? null, priceStatus: v.prices[0]?.status ?? null,
      })),
    };
  }

  /** New product. Axes are what a size is made of, e.g. «سایز لوله» or «سایز لوله» + «سایز رزوه». */
  @Post()
  @Staff('ADMIN')
  async create(@Session() s: SessionClaims, @Body() b: { name?: string; categoryId?: string; newCategory?: string; unitName?: string; packName?: string; model?: string; axes?: string[] }) {
    const name = text(b?.name, 120);
    if (!name) throw new BadRequestException('نام کالا لازم است');
    let categoryId = b.categoryId;
    const newCat = text(b.newCategory, 60);
    if (newCat) {
      const c = await this.prisma.category.create({ data: { name: newCat, slug: `c-${rid(4)}`, sortOrder: 100 } });
      categoryId = c.id;
    }
    if (!categoryId || !(await this.prisma.category.findUnique({ where: { id: categoryId } }))) throw new BadRequestException('دسته‌بندی را انتخاب کنید');
    const axes = (Array.isArray(b.axes) ? b.axes : []).map(a => text(a, 40)).filter((a): a is string => !!a).slice(0, 3);
    const f = await this.prisma.productFamily.create({
      data: {
        name, slug: `p-${rid(5)}`, categoryId, unitName: text(b.unitName, 20) ?? 'عدد', packName: text(b.packName, 20), packOnly: !!text(b.packName, 20), model: text(b.model, 60), sortOrder: 500,
        axes: { create: (axes.length ? axes : ['سایز']).map((a, i) => ({ name: a, sortOrder: i })) },
      },
    });
    await audit(this.prisma, s.sub, 'product.create', 'ProductFamily', f.id, null, { name });
    return this.one(f.id);
  }

  @Patch(':id')
  @Staff('ADMIN')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: {
    name?: string; categoryId?: string; unitName?: string; packName?: string | null; model?: string | null; description?: string | null;
    badge?: string | null; isActive?: boolean; synonyms?: string[]; packOnly?: boolean;
  }) {
    const before = await this.prisma.productFamily.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const data: Record<string, unknown> = {};
    if (b.name !== undefined) { const n = text(b.name, 120); if (!n) throw new BadRequestException('نام کالا لازم است'); data.name = n; }
    if (b.categoryId !== undefined) {
      if (!(await this.prisma.category.findUnique({ where: { id: String(b.categoryId) } }))) throw new BadRequestException('دسته‌بندی پیدا نشد');
      data.categoryId = b.categoryId;
    }
    if (b.packOnly !== undefined) data.packOnly = !!b.packOnly;
    if (b.unitName !== undefined) data.unitName = text(b.unitName, 20) ?? 'عدد';
    for (const k of ['packName', 'model', 'badge'] as const) if (b[k] !== undefined) data[k] = text(b[k], 60);
    if (b.description !== undefined) data.description = text(b.description, 2000);
    if (b.isActive !== undefined) data.isActive = !!b.isActive;
    await this.prisma.$transaction(async tx => {
      await tx.productFamily.update({ where: { id }, data });
      if (Array.isArray(b.synonyms)) {
        const terms = [...new Set(b.synonyms.map(t => text(t, 40)).filter((t): t is string => !!t))].slice(0, 30);
        await tx.synonym.deleteMany({ where: { familyId: id } });
        if (terms.length) await tx.synonym.createMany({ data: terms.map(term => ({ term, familyId: id })) });
      }
    });
    await audit(this.prisma, s.sub, 'product.update', 'ProductFamily', id, before, b);
    return this.one(id);
  }

  /** New size. `options` maps axis id → value («۶۳», «۲″»). */
  @Post(':id/variants')
  @Staff('ADMIN')
  async addVariant(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { options?: Record<string, string>; accountingCode?: string; perPack?: unknown; stock?: unknown; price?: unknown }) {
    const f = await this.prisma.productFamily.findUnique({ where: { id }, include: { axes: { orderBy: { sortOrder: 'asc' } } } });
    if (!f) throw new NotFoundException();
    const values = f.axes.map(a => ({ axisId: a.id, value: text(b?.options?.[a.id], 30) }));
    if (values.some(v => !v.value)) throw new BadRequestException(`مقدار ${f.axes.map(a => a.name).join(' و ')} را وارد کنید`);
    const v = await this.prisma.variant.create({
      data: {
        familyId: id, sku: `${f.slug}-${rid(3)}`, title: `${f.name} ${values.map(x => x.value).join(' × ')}`,
        accountingCode: text(b.accountingCode && toEn(b.accountingCode), 30), perPack: perPackOf(b.perPack), stock: stockOf(b.stock),
        options: { create: values.map(x => ({ axisId: x.axisId, value: x.value! })) },
      },
    });
    if (b.price !== undefined && b.price !== '') await this.writePrice(v.id, amountOf(b.price));
    await audit(this.prisma, s.sub, 'variant.create', 'Variant', v.id, null, { title: v.title });
    return this.one(id);
  }

  @Patch('variants/:vid')
  @Staff('ADMIN')
  async updateVariant(@Session() s: SessionClaims, @Param('vid') vid: string, @Body() b: { options?: Record<string, string>; accountingCode?: string | null; perPack?: unknown; stock?: unknown; isActive?: boolean }) {
    const v = await this.prisma.variant.findUnique({ where: { id: vid }, include: { family: { include: { axes: { orderBy: { sortOrder: 'asc' } } } }, options: true } });
    if (!v) throw new NotFoundException();
    const data: Record<string, unknown> = {};
    if (b.accountingCode !== undefined) data.accountingCode = text(b.accountingCode && toEn(b.accountingCode), 30);
    if (b.perPack !== undefined) data.perPack = perPackOf(b.perPack);
    if (b.stock !== undefined) data.stock = stockOf(b.stock);
    if (b.isActive !== undefined) data.isActive = !!b.isActive;
    await this.prisma.$transaction(async tx => {
      if (b.options) {
        const values = v.family.axes.map(a => ({ axisId: a.id, value: text(b.options![a.id], 30) ?? v.options.find(o => o.axisId === a.id)?.value ?? '' }));
        for (const x of values) await tx.variantOption.upsert({ where: { variantId_axisId: { variantId: vid, axisId: x.axisId } }, create: { variantId: vid, ...x }, update: { value: x.value } });
        data.title = `${v.family.name} ${values.map(x => x.value).join(' × ')}`;
      }
      await tx.variant.update({ where: { id: vid }, data });
    });
    await audit(this.prisma, s.sub, 'variant.update', 'Variant', vid, { accountingCode: v.accountingCode, perPack: v.perPack, stock: v.stock, isActive: v.isActive }, b);
    return this.one(v.familyId);
  }

  /** Changes one size's price in the active list right away (empty = استعلامی). */
  @Put('variants/:vid/price')
  @Staff('ADMIN')
  async setPrice(@Session() s: SessionClaims, @Param('vid') vid: string, @Body() b: { amount?: unknown }) {
    const v = await this.prisma.variant.findUnique({ where: { id: vid } });
    if (!v) throw new NotFoundException();
    const amount = amountOf(b?.amount);
    const before = await this.writePrice(vid, amount);
    await audit(this.prisma, s.sub, 'price.set', 'Variant', vid, before ? { amount: before.amount?.toString() ?? null } : null, { amount: amount?.toString() ?? null });
    return this.one(v.familyId);
  }

  private async writePrice(variantId: string, amount: bigint | null) {
    let list = await this.activeList();
    if (!list) list = await this.prisma.priceList.create({ data: { title: 'قیمت‌های پنل مدیریت', status: 'ACTIVE', publishedAt: new Date(), validFrom: new Date() } });
    const before = await this.prisma.price.findUnique({ where: { priceListId_variantId: { priceListId: list.id, variantId } } });
    const data = { amount, status: amount === null ? 'INQUIRY' as const : 'PRICED' as const, note: amount === null ? 'استعلامی' : null };
    await this.prisma.price.upsert({ where: { priceListId_variantId: { priceListId: list.id, variantId } }, create: { priceListId: list.id, variantId, ...data }, update: data });
    return before;
  }

  /** Product photo (JPG/PNG/WebP up to 10 MB; the panel resizes bigger ones first); becomes the main photo. */
  @Post(':id/photo')
  @Staff('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async photo(@Session() s: SessionClaims, @Param('id') id: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!(await this.prisma.productFamily.findUnique({ where: { id } }))) throw new NotFoundException();
    const ext = file && IMAGE_TYPES[file.mimetype];
    if (!file?.buffer?.length || !ext) throw new BadRequestException(`این فایل عکس قابل قبول نیست (${file?.mimetype || 'نامشخص'})؛ فقط JPG، PNG یا WebP`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${rid(10)}.${ext}`;
    writeFileSync(join(UPLOAD_DIR, name), file.buffer);
    await this.prisma.$transaction([
      this.prisma.media.updateMany({ where: { familyId: id }, data: { isPrimary: false } }),
      this.prisma.media.create({ data: { familyId: id, key: `api/media/${name}`, mime: file.mimetype, isPrimary: true, source: 'upload' } }),
    ]);
    await audit(this.prisma, s.sub, 'product.photo', 'ProductFamily', id, null, { name });
    return this.one(id);
  }
}
