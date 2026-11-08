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

export interface Terms { cashPercent?: number; chequeDueDays?: number[]; cashDiscountPct?: string | number; chequeMarkupPct?: string | number }
export interface Breakdown {
  subtotal: bigint; discount: bigint; shipping: bigint;
  cashBase: bigint; chequeBase: bigint; cashDiscount: bigint; chequeMarkup: bigint;
  cash: bigint; cheque: bigint; total: bigint; cashPercent: number;
  cashDiscountPct: number; chequeMarkupPct: number;
  cheques: { days: number | null; amount: bigint }[];
}

/** Percent (up to 2 decimals) of an amount, rounded down to whole Rials. */
const pctOf = (amount: bigint, pct: number) => (amount * BigInt(Math.round(pct * 100))) / 10000n;

/**
 * The customer's money terms applied to an order: the cash share gets the cash discount, the cheque share gets
 * the cheque markup, and the cheque share is split into equal cheques by the agreed due days. Freight is paid in cash.
 */
export function applyTerms(subtotal: bigint, terms: Terms | null | undefined, discount = 0n, shipping = 0n): Breakdown {
  const cashPercent = Math.min(100, Math.max(0, Math.round(terms?.cashPercent ?? 100)));
  const cashDiscountPct = Math.max(0, Number(terms?.cashDiscountPct ?? 0) || 0);
  const chequeMarkupPct = Math.max(0, Number(terms?.chequeMarkupPct ?? 0) || 0);
  const base = subtotal - (discount > subtotal ? subtotal : discount);
  const { cash: cashBase, cheque: chequeBase } = splitCashCheque(base, cashPercent);
  const cashDiscount = pctOf(cashBase, cashDiscountPct);
  const chequeMarkup = pctOf(chequeBase, chequeMarkupPct);
  const cash = cashBase - cashDiscount + shipping;
  const cheque = chequeBase + chequeMarkup;
  const days = (terms?.chequeDueDays ?? []).filter(d => Number.isFinite(d) && d >= 0);
  const cheques: Breakdown['cheques'] = [];
  if (cheque > 0n) {
    const n = BigInt(Math.max(1, days.length));
    const each = cheque / n;
    (days.length ? days : [null]).forEach((d, i) => cheques.push({ days: d, amount: i === days.length - 1 || !days.length ? cheque - each * (n - 1n) : each }));
  }
  return { subtotal, discount: subtotal - base, shipping, cashBase, chequeBase, cashDiscount, chequeMarkup, cash, cheque, total: cash + cheque, cashPercent, cashDiscountPct, chequeMarkupPct, cheques };
}
