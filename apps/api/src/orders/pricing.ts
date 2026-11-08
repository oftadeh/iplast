import { PayMode, SaleTerms, allowedModes, netPrice, salePct } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface Quote {
  variantId: string; title: string; categoryId: string; perPack: number | null;
  /** Price per unit for the sale mode (list − the customer's %), null = inquiry. */
  unitPrice: bigint | null; listPrice: bigint | null; pct: number;
  /** Personal price agreed for this customer (wins over the percentages). */
  own: boolean;
}

/** The customer's sale terms: cash % and term % with the term length, and per-category overrides. */
export async function saleTerms(prisma: PrismaService, customerId: string | null): Promise<SaleTerms & { termMonths: number }> {
  if (!customerId) return { cashPct: 0, termPct: 0, termMonths: 3, allowCash: true, allowTerm: true, categories: {} };
  const [t, cats] = await Promise.all([
    prisma.paymentTerms.findUnique({ where: { customerId } }),
    prisma.customerCategoryDiscount.findMany({ where: { customerId } }),
  ]);
  return {
    cashPct: Number(t?.cashDiscountPct ?? 0), termPct: Number(t?.termDiscountPct ?? 0), termMonths: t?.termMonths ?? 3,
    allowCash: t?.allowCash ?? true, allowTerm: t?.allowTerm ?? true,
    categories: Object.fromEntries(cats.map(c => [c.categoryId, { cash: c.cashPct === null ? null : Number(c.cashPct), term: c.termPct === null ? null : Number(c.termPct) }])),
  };
}

/** A mode the customer may use: the asked one if allowed, else their first allowed one. */
export function modeFor(t: SaleTerms, asked?: unknown): PayMode {
  const ok = allowedModes(t);
  return ok.includes(asked as PayMode) ? (asked as PayMode) : ok[0];
}

/**
 * Price per unit for a customer and sale mode: a personal price if agreed, else the active list price minus the
 * customer's cash or term percentage for that product category. Null = inquiry.
 */
export async function quote(prisma: PrismaService, variantIds: string[], customerId: string | null, mode: PayMode = 'CASH', terms?: SaleTerms): Promise<Map<string, Quote>> {
  const list = await prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds }, isActive: true },
    include: {
      family: { select: { categoryId: true } },
      prices: list ? { where: { priceListId: list.id } } : { where: { id: '-' } },
      customerPrices: customerId ? { where: { customerId, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } } : { where: { id: '-' } },
    },
  });
  const t = terms ?? (await saleTerms(prisma, customerId));
  const out = new Map<string, Quote>();
  for (const v of variants) {
    const own = v.customerPrices[0]?.amount;
    const p = v.prices[0];
    const listPrice = p && p.status === 'PRICED' && p.amount !== null ? p.amount : null;
    const pct = salePct(t, mode, v.family.categoryId);
    const unitPrice = own !== undefined ? own : listPrice === null ? null : netPrice(listPrice, pct);
    out.set(v.id, { variantId: v.id, title: v.title, categoryId: v.family.categoryId, perPack: v.perPack, unitPrice, listPrice, pct: own !== undefined ? 0 : pct, own: own !== undefined });
  }
  return out;
}
