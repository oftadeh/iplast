import { PayMode, SaleTerms, Special, allowedModes, bestSpecial, netPrice, salePct } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';
import { categoryTree } from '../catalog/tree';

export interface Quote {
  variantId: string; title: string; categoryId: string; familyId: string; perPack: number | null;
  /** Price per unit for the sale mode (list − the customer's %, plus a special discount), null = inquiry. */
  unitPrice: bigint | null; listPrice: bigint | null; pct: number;
  /** Personal price agreed for this customer (wins over the percentages). */
  own: boolean;
  /** «تخفیف ویژه» applied to this line: the points it added on top of the customer's own percent. */
  special: { id: string; pct: number; note: string | null } | null;
  /** A better special the order does not reach yet: from `minPacks` packs the percent would be `pct`. */
  next: { pct: number; extra: number; minPacks: number; packName: string | null; note: string | null } | null;
  packOnly: boolean; packName: string | null; stock: number | null;
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

/** Special discounts that may apply to this customer now (for everyone or for them), on the given products. */
export async function specialsFor(prisma: PrismaService, customerId: string | null, familyIds?: string[]): Promise<Special[]> {
  const now = new Date();
  const rows = await prisma.specialDiscount.findMany({
    where: {
      isActive: true, ...(familyIds ? { familyId: { in: familyIds } } : {}),
      OR: [{ customerId: null }, ...(customerId ? [{ customerId }] : [])],
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
  });
  return rows.map(r => ({ ...r, pct: Number(r.pct) }));
}

/**
 * Price per unit for a customer and sale mode: a personal price if agreed, else the active list price minus the
 * customer's cash or term percentage for that product category (or its branch), improved by a «تخفیف ویژه» when one
 * applies. `qty` (units per size) lets specials with a pack minimum count the packs of each product. Null = inquiry.
 */
export async function quote(prisma: PrismaService, variantIds: string[], customerId: string | null, mode: PayMode = 'CASH', terms?: SaleTerms, qty?: Record<string, number>): Promise<Map<string, Quote>> {
  const list = await prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds }, isActive: true },
    include: {
      family: { select: { id: true, categoryId: true, packOnly: true, packName: true } },
      prices: list ? { where: { priceListId: list.id } } : { where: { id: '-' } },
      customerPrices: customerId ? { where: { customerId, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } } : { where: { id: '-' } },
    },
  });
  const [t, tree, specials] = await Promise.all([
    terms ?? saleTerms(prisma, customerId), categoryTree(prisma), specialsFor(prisma, customerId, [...new Set(variants.map(v => v.familyId))]),
  ]);
  // packs of each product in the order (sizes of one product add up: 60 cartons of ½″ + 40 of ¾″ = 100)
  const packs = new Map<string, number>();
  if (qty) for (const v of variants) packs.set(v.familyId, (packs.get(v.familyId) ?? 0) + (qty[v.id] ?? 0) / (v.perPack || 1));
  const out = new Map<string, Quote>();
  for (const v of variants) {
    const own = v.customerPrices[0]?.amount;
    const p = v.prices[0];
    const listPrice = p && p.status === 'PRICED' && p.amount !== null ? p.amount : null;
    const base = salePct(t, mode, tree.chain(v.family.categoryId));
    const sp = own === undefined ? bestSpecial(specials, { familyId: v.familyId, customerId, mode, base, packs: qty ? Math.floor((packs.get(v.familyId) ?? 0) + 1e-9) : null }) : { best: null, next: null };
    const pct = sp.best?.pct ?? base;
    const unitPrice = own !== undefined ? own : listPrice === null ? null : netPrice(listPrice, pct);
    out.set(v.id, {
      variantId: v.id, title: v.title, categoryId: v.family.categoryId, familyId: v.familyId, perPack: v.perPack, unitPrice, listPrice, pct: own !== undefined ? 0 : pct, own: own !== undefined,
      special: sp.best ? { id: sp.best.special.id, pct: +(sp.best.pct - base).toFixed(2), note: sp.best.special.note ?? null } : null,
      next: sp.next ? { pct: sp.next.pct, extra: +(sp.next.pct - base).toFixed(2), minPacks: sp.next.special.minPacks!, packName: v.family.packName, note: sp.next.special.note ?? null } : null,
      packOnly: v.family.packOnly, packName: v.family.packName, stock: v.stock,
    });
  }
  return out;
}
