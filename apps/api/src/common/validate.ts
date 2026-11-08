import { BadRequestException } from '@nestjs/common';

export function req<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) throw new BadRequestException(msg);
  return v;
}
export function int(v: unknown, msg: string, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new BadRequestException(msg);
  return n;
}
export function telegramId(v: unknown): bigint {
  const s = String(v ?? '').trim();
  if (!/^\d{4,15}$/.test(s)) throw new BadRequestException('آیدی عددی تلگرام نامعتبر است');
  return BigInt(s);
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
/** A Rial amount typed in Persian or English digits, with or without thousands separators. */
export function rialOf(v: unknown, what: string, allowZero = false): bigint {
  const s = toEnDigits(String(v ?? '')).replace(/[,،٬\s]/g, '');
  if (!/^\d{1,15}$/.test(s)) throw new BadRequestException(`${what} باید عدد (ریال) باشد`);
  const n = BigInt(s);
  if (!allowZero && n <= 0n) throw new BadRequestException(`${what} باید بیشتر از صفر باشد`);
  return n;
}
