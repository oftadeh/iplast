import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Words of a search like «نری ۶۳» or «فیلتر 2 اینچ»; numbers alone don't pick a family. */
function searchTerms(q: string) {
  const words = q.trim().slice(0, 80).split(/\s+/).filter(w => w.length >= 2 && !/^[\d۰-۹/.×x*]+$/.test(w));
  return words.length ? words : [q.trim().slice(0, 80)];
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('categories')
  categories() {
    return this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { families: true } } } });
  }

  @Get('families')
  async families(@Query('category') category?: string, @Query('q') q?: string) {
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    const fams = await this.prisma.productFamily.findMany({
      where: {
        isActive: true,
        ...(category ? { category: { slug: category } } : {}),
        ...(q ? { OR: searchTerms(q).flatMap(t => [{ name: { contains: t } }, { synonyms: { some: { term: { contains: t } } } }]) } : {}),
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, slug: true, name: true, model: true, badge: true, packName: true,
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
        return { ...v, prices: undefined, price: p && p.status === 'PRICED' ? p.amount : null };
      }),
    };
  }
}
