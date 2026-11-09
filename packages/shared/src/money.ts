const FA = '۰۱۲۳۴۵۶۷۸۹';
export const toFaDigits = (s: string | number | bigint) => String(s).replace(/\d/g, d => FA[+d]);

/** Formats Rial with Persian digits; null means the price is not available. */
export function formatRial(amount: bigint | number | null | undefined): string {
  if (amount === null || amount === undefined) return 'استعلامی';
  return toFaDigits(BigInt(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')) + ' ریال';
}

/** Splits a total into cash and cheque parts by the customer's cash percentage. */
export function splitCashCheque(total: bigint, cashPercent: number): { cash: bigint; cheque: bigint } {
  const pct = Math.min(100, Math.max(0, Math.round(cashPercent)));
  const cash = (total * BigInt(pct)) / 100n;
  return { cash, cheque: total - cash };
}

/**
 * Two ways to sell. «نقدی»: the list price minus the customer's cash discount (e.g. 40%). «مدت‌دار» (روال): the list
 * price minus a smaller discount (e.g. 30%), paid by cheque after the agreed number of months (e.g. 3).
 * Each customer has their own two percentages and term, and may have different ones per product category.
 */
export type PayMode = 'CASH' | 'TERM';
export interface SaleTerms {
  cashPct?: number | string; termPct?: number | string; termMonths?: number;
  allowCash?: boolean; allowTerm?: boolean;
  /** Per product category: overrides of the two percentages; null = the customer's default. */
  categories?: Record<string, { cash?: number | string | null; term?: number | string | null }>;
}
export const payModeFa = (mode: PayMode, months?: number | null) => (mode === 'CASH' ? 'نقدی' : `مدت‌دار${months ? ` ${toFaDigits(months)} ماهه` : ''}`);

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; };
/**
 * Discount percent off the list price for a sale mode and product category. `category` may be the category's chain
 * (its id, then its parent's, …): the nearest category with its own percent wins, so a branch's percent covers its
 * sub-branches.
 */
export function salePct(t: SaleTerms | null | undefined, mode: PayMode, category?: string | string[] | null): number {
  for (const id of Array.isArray(category) ? category : category ? [category] : []) {
    const c = t?.categories?.[id];
    const own = mode === 'CASH' ? c?.cash : c?.term;
    if (own !== null && own !== undefined && own !== '') return num(own);
  }
  return num(mode === 'CASH' ? t?.cashPct : t?.termPct);
}

/**
 * «تخفیف ویژه»: a manager's discount on one product. EXTRA adds its points to the customer's own percent (30% + 5%);
 * FIXED sets the product's percent (40%) when that is better for the customer. Optional: one customer only, one sale
 * mode only, a minimum number of packs (cartons / bags) of that product in the order, and dates.
 */
export interface Special {
  id: string; familyId: string; customerId?: string | null; payMode?: PayMode | null; kind: 'EXTRA' | 'FIXED';
  pct: number | string; minPacks?: number | null; startsAt?: Date | string | null; endsAt?: Date | string | null; isActive?: boolean; note?: string | null;
}
/** Whether a special is for this customer and sale mode today (the pack minimum is checked by bestSpecial). */
export function specialFits(s: Special, customerId: string | null | undefined, mode: PayMode, now = new Date()) {
  if (s.isActive === false) return false;
  if (s.customerId && s.customerId !== customerId) return false;
  if (s.payMode && s.payMode !== mode) return false;
  if (s.startsAt && new Date(s.startsAt) > now) return false;
  if (s.endsAt && new Date(s.endsAt) < now) return false;
  return true;
}
/** The percent a special gives on top of a base percent (never less than the base). */
export const specialTotal = (s: Special, base: number) => Math.min(100, Math.max(base, s.kind === 'FIXED' ? num(s.pct) : base + num(s.pct)));
/**
 * The best special for a product: `packs` is how many packs of it the order has (null = unknown, e.g. the catalog
 * before a quantity is chosen: specials with a minimum are then left out). Returns the total percent and the special,
 * and the best one still out of reach because of its minimum (to tell the customer «از ۱۰۰ کارتن، ۵٪ بیشتر»).
 */
export function bestSpecial(list: Special[], o: { familyId: string; customerId?: string | null; mode: PayMode; base: number; packs: number | null; now?: Date }) {
  let best: { special: Special; pct: number } | null = null;
  let next: { special: Special; pct: number } | null = null;
  for (const s of list) {
    if (s.familyId !== o.familyId || !specialFits(s, o.customerId, o.mode, o.now)) continue;
    const pct = specialTotal(s, o.base);
    if (pct <= o.base) continue;
    const reached = !s.minPacks || (o.packs !== null && o.packs >= s.minPacks);
    if (reached) { if (!best || pct > best.pct) best = { special: s, pct }; }
    else if (!next || pct > next.pct) next = { special: s, pct };
  }
  if (next && best && next.pct <= best.pct) next = null;
  return { best, next };
}
/** Modes a customer may buy with; at least one. */
export function allowedModes(t: SaleTerms | null | undefined): PayMode[] {
  const m: PayMode[] = [];
  if (t?.allowCash !== false) m.push('CASH');
  if (t?.allowTerm !== false) m.push('TERM');
  return m.length ? m : ['CASH'];
}

/** Percent (up to 2 decimals) of an amount, rounded down to whole Rials. */
export const pctOf = (amount: bigint, pct: number) => (amount * BigInt(Math.round(pct * 100))) / 10000n;
/** The price after a percent discount. */
export const netPrice = (list: bigint, pct: number) => list - pctOf(list, pct);

export interface Breakdown {
  mode: PayMode; termMonths: number;
  /** Lines at list price, the sale discount (cash or term %), the lines after it. */
  listTotal: bigint; saleDiscount: bigint; subtotal: bigint;
  /** Extra discount and freight added by the sales agent. */
  discount: bigint; shipping: bigint;
  total: bigint; cash: bigint; cheque: bigint;
  cheques: { days: number | null; amount: bigint }[];
}

/**
 * The money of an order. Unit prices already carry the sale discount; the list prices show how much it was.
 * Cash sale: everything in cash. Term sale: the goods are paid by a cheque due after termMonths, freight in cash.
 */
export function orderBreakdown(
  items: { quantity: number; unitPrice: bigint | null; listPrice?: bigint | null }[],
  mode: PayMode = 'CASH', termMonths = 0, discount = 0n, shipping = 0n,
): Breakdown {
  let listTotal = 0n, subtotal = 0n;
  for (const i of items) {
    if (i.unitPrice === null) continue;
    const q = BigInt(i.quantity);
    subtotal += i.unitPrice * q;
    listTotal += (i.listPrice !== null && i.listPrice !== undefined && i.listPrice > i.unitPrice ? i.listPrice : i.unitPrice) * q;
  }
  const d = discount > subtotal ? subtotal : discount;
  const goods = subtotal - d;
  const months = mode === 'TERM' ? Math.max(0, Math.round(termMonths)) : 0;
  const cheque = mode === 'TERM' ? goods : 0n;
  const cash = goods - cheque + shipping;
  return {
    mode, termMonths: months, listTotal, saleDiscount: listTotal - subtotal, subtotal, discount: d, shipping,
    total: goods + shipping, cash, cheque, cheques: cheque > 0n ? [{ days: months ? months * 30 : null, amount: cheque }] : [],
  };
}
