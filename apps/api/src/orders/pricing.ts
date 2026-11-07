import { PrismaService } from '../prisma/prisma.service';

export interface Quote { variantId: string; title: string; unitPrice: bigint | null; perPack: number | null }

/** Price per unit for a customer: personal price, else active list price minus group discount. Null = inquiry. */
export async function quote(prisma: PrismaService, variantIds: string[], customerId: string | null): Promise<Map<string, Quote>> {
  const list = await prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds }, isActive: true },
    include: {
      prices: list ? { where: { priceListId: list.id } } : { where: { id: '-' } },
      customerPrices: customerId ? { where: { customerId, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } } : { where: { id: '-' } },
    },
  });
  const customer = customerId ? await prisma.customer.findUnique({ where: { id: customerId }, include: { priceGroup: true } }) : null;
  const discount = customer?.priceGroup ? Number(customer.priceGroup.discountPct) : 0;
  const out = new Map<string, Quote>();
  for (const v of variants) {
    const own = v.customerPrices[0]?.amount;
    const p = v.prices[0];
    let unit: bigint | null = null;
    if (own !== undefined) unit = own;
    else if (p && p.status === 'PRICED' && p.amount !== null) unit = discount ? (p.amount * BigInt(Math.round((100 - discount) * 100))) / 10000n : p.amount;
    out.set(v.id, { variantId: v.id, title: v.title, unitPrice: unit, perPack: v.perPack });
  }
  return out;
}
