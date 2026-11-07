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
