import { useEffect, useState } from 'react';

const nf = new Intl.NumberFormat('fa-IR');
export const fa = (n: number | bigint | string) => nf.format(typeof n === 'string' ? BigInt(n) : n);
export const rial = (s: string | null | undefined) => (s === null || s === undefined ? 'استعلامی' : `${fa(s)} ریال`);
export const dateFa = (d: string) => new Date(d).toLocaleString('fa-IR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
export const personName = (p?: { firstName?: string | null; lastName?: string | null; username?: string | null } | null) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(' ') || (p.username ? '@' + p.username : 'بی‌نام') : '—';

export const STATUS_CLASS = (s: string) =>
  s === 'SUBMITTED' ? 'new' : s === 'REJECTED' || s === 'CANCELLED' ? 'no' : s === 'NEEDS_FIX' || s === 'PROFORMA_EXPIRED' ? 'ask' : s === 'DELIVERED' || s === 'SALES_APPROVED' ? 'ok' : '';
export const ROLE_FA: Record<string, string> = { OWNER: 'مدیر حساب', BUYER: 'کارشناس خرید', VIEWER: 'فقط مشاهده', ADMIN: 'مدیر ارشد', SALES: 'کارشناس فروش', WAREHOUSE: 'انبار' };
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

export interface Me { id: string; firstName: string | null; lastName: string | null; staffRole: 'ADMIN' | 'SALES' | 'WAREHOUSE' | null }
export interface Staff { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null; staffRole: 'ADMIN' | 'SALES' | 'WAREHOUSE'; isActive: boolean; _count: { supportOf: number } }

/** Jalali (شمسی) date → ISO date string (YYYY-MM-DD), for cheque due dates. */
export function jalaliToIso(jy: number, jm: number, jd: number) {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const ml = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  for (; gm <= 12 && gd > ml[gm]; gm++) gd -= ml[gm];
  return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}
/** Today's Jalali year/month/day. */
export function jalaliToday(): [number, number, number] {
  const p = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  const g = (t: string) => Number(p.find(x => x.type === t)?.value);
  return [g('year'), g('month'), g('day')];
}
export const dayFa = (d: string) => new Date(d).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });

/** Loads a private file (a receipt photo) with the login header and gives back a local URL for <img>. */
export function useBlobUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true, made: string | null = null;
    fetch('/api' + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return url;
}

/** POST a multipart form (file uploads) with the login header. */
export async function apiForm<T>(path: string, fd: FormData): Promise<T> {
  const r = await fetch('/api' + path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
  if (r.status === 401 && token) { setToken(null); onUnauthorized(); }
  if (!r.ok) {
    let msg = r.status === 413 ? 'حجم فایل زیاد است' : 'ثبت نشد';
    try { const j = await r.json(); if (typeof j?.message === 'string') msg = j.message; } catch { /* */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

/** Opens a private file (receipt, waybill, PDF) in a new tab. */
export async function openPrivate(path: string) {
  const w = window.open('', '_blank');
  const r = await fetch('/api' + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) { w?.close(); throw new ApiError(r.status, 'فایل باز نشد'); }
  const url = URL.createObjectURL(await r.blob());
  if (w) w.location.href = url; else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
