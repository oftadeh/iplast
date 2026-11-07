import { execFile } from 'node:child_process';

export interface ParsedRow {
  page: number;
  familyTitle: string | null;
  rawText: string;
  accountingCode: string | null;
  perPack: number | null;
  amount: bigint | null; // Rial; null = inquiry
  note: string | null; // original text when there is no number, e.g. «بزودی»
  column?: number; // 0, 1… when the row has several price columns
}

const FA = '۰۱۲۳۴۵۶۷۸۹', AR = '٠١٢٣٤٥٦٧٨٩';
const en = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d))).replace(/[٠-٩]/g, d => String(AR.indexOf(d)));
// bidi embedding marks that pdftotext leaves around RTL runs
const clean = (s: string) => s.replace(/[‎‏‪-‮⁦-⁩]/g, '');

/** Text of a PDF with its column layout kept (poppler's pdftotext). */
export function pdfToText(pdf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, out) =>
      err ? reject(new Error('خواندن PDF ممکن نشد: ' + err.message)) : resolve(out));
    p.stdin?.end(pdf);
  });
}

const PRICE = /^\d{1,3}(,\d{3})+$|^\d{5,}$/;
/** Rial amounts in these lists are at least 10,000; smaller numbers are pack counts. */
const isRial = (x: string) => PRICE.test(x) && Number(x.replace(/,/g, '')) >= 10_000;
const CODE = /^\d{8,}$/;
const INQUIRY_WORDS = /بزودی|به\s*زودی|استعالم|استعلام|^\*$|تماس/;
const HEADER = /قیمت|کد\s*کا|شرح\s*کا|^تعداد$|^سایز$|^مرتاژ$|لیست قیمت|iplast|www\.|صفحه/i;

/**
 * Turns the price-list text into rows. A row is: price (or a word such as «بزودی») on the left,
 * the accounting code on the right, and between them the pack count and the description.
 * Short lines without numbers are taken as the family heading for the rows under them.
 */
export function parsePriceText(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  text.split('\f').forEach((pageText, pi) => {
    let family: string | null = null;
    for (const rawLine of pageText.split('\n')) {
      const line = clean(rawLine).replace(/\s+$/, '');
      if (!line.trim()) continue;
      let cells = line.trim().split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
      // a model column such as «IPT» may come before the price
      if (cells.length >= 4 && /^[A-Za-z][A-Za-z0-9-]{0,9}$/.test(cells[0])) cells = cells.slice(1);
      const last = en(cells[cells.length - 1]);
      const codeLike = CODE.test(last) || last === '*';
      // leading price cells (a few families have two price columns, e.g. plastic / metal body)
      const prices: string[] = [];
      for (const c of cells.slice(0, -1)) {
        const x = en(c);
        if (isRial(x) || (!prices.length && INQUIRY_WORDS.test(x))) prices.push(c); else break;
      }
      if (cells.length >= 2 && prices.length && codeLike && cells.length > prices.length) {
        const middle = cells.slice(prices.length, -1).map(en);
        let perPack: number | null = null;
        if (middle.length >= 2 && /^[\d,]+$/.test(middle[0]) && Number(middle[0].replace(/,/g, '')) < 100_000) perPack = Number(middle.shift()!.replace(/,/g, ''));
        const rawText = middle.join(' ').replace(/\s+/g, ' ').slice(0, 300);
        // reading order is right to left: the price next to the description comes first
        for (const pc of [...prices].reverse()) {
          const x = en(pc);
          const amount = isRial(x) ? BigInt(x.replace(/,/g, '')) : null;
          rows.push({
            page: pi + 1, familyTitle: family, rawText, accountingCode: CODE.test(last) ? last : null, perPack, amount,
            note: amount === null ? pc.slice(0, 60) : null, column: prices.length > 1 ? prices.length - 1 - prices.indexOf(pc) : undefined,
          });
        }
        continue;
      }
      const t = cells.join(' ');
      if (cells.length <= 2 && t.length < 70 && !/\d{3}/.test(en(t)) && !HEADER.test(t)) family = t;
    }
  });
  return rows;
}
