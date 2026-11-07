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
