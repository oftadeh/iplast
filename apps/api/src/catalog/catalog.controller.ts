import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('categories')
  categories() {
    return this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { families: true } } } });
  }

  @Get('families')
  families(@Query('category') category?: string, @Query('q') q?: string) {
    return this.prisma.productFamily.findMany({
      where: {
        isActive: true,
        ...(category ? { category: { slug: category } } : {}),
        ...(q ? { OR: [{ name: { contains: q } }, { synonyms: { some: { term: { contains: q } } } }] } : {}),
      },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, name: true, model: true, media: { where: { isPrimary: true }, take: 1 } },
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
