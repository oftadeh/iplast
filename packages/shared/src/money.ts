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
/** Discount percent off the list price for a sale mode and product category. */
export function salePct(t: SaleTerms | null | undefined, mode: PayMode, categoryId?: string | null): number {
  const c = categoryId ? t?.categories?.[categoryId] : undefined;
  const own = mode === 'CASH' ? c?.cash : c?.term;
  if (own !== null && own !== undefined && own !== '') return num(own);
  return num(mode === 'CASH' ? t?.cashPct : t?.termPct);
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
