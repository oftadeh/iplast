import { useEffect, useState } from 'react';

const nf = new Intl.NumberFormat('fa-IR');
export const fa = (n: number | bigint | string) => nf.format(typeof n === 'string' ? BigInt(n) : n);
export const rial = (s: string | null | undefined) => (s === null || s === undefined ? 'استعلامی' : `${fa(s)} ریال`);
export const dateFa = (d: string) => new Date(d).toLocaleString('fa-IR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
export const personName = (p?: { firstName?: string | null; lastName?: string | null; username?: string | null } | null) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(' ') || (p.username ? '@' + p.username : 'بی‌نام') : '—';

export const STATUS_CLASS = (s: string) =>
  s === 'SUBMITTED' ? 'new' : s === 'REJECTED' || s === 'CANCELLED' ? 'no' : s === 'NEEDS_FIX' || s === 'PROFORMA_EXPIRED' ? 'ask' : s === 'DELIVERED' ? 'ok' : '';
export const ROLE_FA: Record<string, string> = { OWNER: 'مدیر حساب', BUYER: 'کارشناس خرید', VIEWER: 'فقط مشاهده', ADMIN: 'مدیر', SALES: 'کارشناس فروش' };
export const TYPE_FA: Record<string, string> = { RETAIL: 'خرده‌فروش', DEALER: 'نماینده', CONTRACTOR: 'پیمانکار' };

const KEY = 'iplast.admin.token';
let token: string | null = null;
try { token = localStorage.getItem(KEY); } catch { /* blocked */ }
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* */ }
}

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch('/api' + path, { method: init?.method ?? 'GET', headers, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
  if (r.status === 401 && token) { setToken(null); onUnauthorized(); }
  if (!r.ok) {
    let msg = r.status === 403 ? 'دسترسی این کار را ندارید' : 'خطا در ارتباط با سرور';
    try { const j = await r.json(); if (typeof j?.message === 'string') msg = j.message; } catch { /* */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

export function useApi<T>(path: string | null) {
  const [s, set] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) { set({ data: null, error: null }); return; }
    let live = true;
    api<T>(path).then(d => live && set({ data: d, error: null }), (e: Error) => live && set({ data: null, error: e.message }));
    return () => { live = false; };
  }, [path, n]);
  return { ...s, reload: () => setN(x => x + 1), setData: (d: T) => set({ data: d, error: null }) };
}

export interface Me { id: string; firstName: string | null; lastName: string | null; staffRole: 'ADMIN' | 'SALES' | null }
export interface Staff { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null; staffRole: 'ADMIN' | 'SALES'; isActive: boolean; _count: { supportOf: number } }
