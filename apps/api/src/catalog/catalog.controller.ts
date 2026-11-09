import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { categoryTree } from './tree';

/** Words of a search like «نری ۶۳» or «فیلتر 2 اینچ»; numbers alone don't pick a family. */
function searchTerms(q: string) {
  const words = q.trim().slice(0, 80).split(/\s+/).filter(w => w.length >= 2 && !/^[\d۰-۹/.×x*]+$/.test(w));
  return words.length ? words : [q.trim().slice(0, 80)];
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Categories in tree order (a branch, then its sub-branches). `_count.families` counts the active products of the
   * category and all its sub-branches, so a branch tile shows everything under it.
   */
  @Get('categories')
  async categories() {
    const [tree, counts] = await Promise.all([
      categoryTree(this.prisma),
      this.prisma.productFamily.groupBy({ by: ['categoryId'], where: { isActive: true }, _count: { _all: true } }),
    ]);
    const own = new Map(counts.map(c => [c.categoryId, c._count._all]));
    return tree.ordered().map(c => ({
      id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder, parentId: c.parentId, depth: c.depth,
      _count: { families: tree.descendants(c.id).reduce((n, id) => n + (own.get(id) ?? 0), 0) },
    }));
  }

  @Get('families')
  async families(@Query('category') category?: string, @Query('q') q?: string) {
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    // a branch shows the products of its sub-branches too
    let cats: string[] | null = null;
    if (category) {
      const tree = await categoryTree(this.prisma);
      const c = tree.all.find(x => x.slug === category);
      cats = c ? tree.descendants(c.id) : ['-'];
    }
    const fams = await this.prisma.productFamily.findMany({
      where: {
        isActive: true,
        ...(cats ? { categoryId: { in: cats } } : {}),
        ...(q ? { OR: searchTerms(q).flatMap(t => [{ name: { contains: t } }, { synonyms: { some: { term: { contains: t } } } }]) } : {}),
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, slug: true, name: true, model: true, badge: true, packName: true, packOnly: true, unitName: true,
        category: { select: { slug: true, name: true } },
        brand: { select: { name: true } },
        media: { where: { isPrimary: true }, take: 1, select: { key: true, source: true } },
        variants: { where: { isActive: true }, select: { prices: list ? { where: { priceListId: list.id, status: 'PRICED' }, select: { amount: true } } : { where: { id: '-' }, select: { amount: true } } } },
      },
    });
    return fams.map(({ variants, ...f }) => {
      const prices = variants.flatMap(v => v.prices.map(p => p.amount)).filter((a): a is bigint => a !== null);
      return { ...f, sizeCount: variants.length, minPrice: prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : null };
    });
  }

  /** Family with its sizes and prices from the active price list. Missing prices stay null. */
  @Get('families/:slug')
  async family(@Param('slug') slug: string) {
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    const f = await this.prisma.productFamily.findUnique({
      where: { slug },
      include: {
        axes: { orderBy: { sortOrder: 'asc' } },
        category: { select: { slug: true, name: true } },
        brand: { select: { name: true } },
        media: true,
        variants: {
          where: { isActive: true },
          include: { options: true, prices: list ? { where: { priceListId: list.id } } : false },
        },
      },
    });
    if (!f) throw new NotFoundException();
    return {
      ...f,
      priceList: list ? { id: list.id, title: list.title } : null,
      variants: f.variants.map(v => {
        const p = 'prices' in v && Array.isArray(v.prices) ? v.prices[0] : undefined;
        // the stock count stays in the panel; customers only see «ناموجود»
        return { ...v, prices: undefined, stock: undefined, soldOut: v.stock === 0, price: p && p.status === 'PRICED' ? p.amount : null };
      }),
    };
  }
}
