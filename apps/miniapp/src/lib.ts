import { useEffect, useState } from 'react';
import { tg } from './telegram';

// ───────── formatting ─────────
const nf = new Intl.NumberFormat('fa-IR');
export const fa = (n: number | bigint | string) => nf.format(typeof n === 'string' ? BigInt(n) : n);
export const toBig = (s: string | null | undefined) => (s === null || s === undefined ? null : BigInt(s));
export function short(n: bigint) {
  const x = Number(n);
  if (x >= 1e9) return nf.format(+(x / 1e9).toFixed(2)) + ' میلیارد';
  if (x >= 1e6) return nf.format(+(x / 1e6).toFixed(2)) + ' میلیون';
  return nf.format(n);
}
export const photoUrl = (key?: string | null) => (key ? '/' + key.replace(/^\/+/, '') : null);

// ───────── API ─────────
export interface Category { id: string; slug: string; name: string; sortOrder: number; _count: { families: number } }
export interface FamilyCard {
  id: string; slug: string; name: string; model: string | null; badge: string | null; unitName: string; packName: string | null;
  category: { slug: string; name: string }; brand: { name: string } | null; media: { key: string }[]; sizeCount: number; minPrice: string | null;
}
export interface Axis { id: string; name: string; unit: string | null }
export interface Variant { id: string; sku: string; accountingCode: string | null; title: string; perPack: number | null; options: { axisId: string; value: string }[]; price: string | null }
export interface Family extends Omit<FamilyCard, 'sizeCount' | 'minPrice'> {
  description: string | null; specs: [string, string][] | null; axes: Axis[]; variants: Variant[]; priceList: { id: string; title: string } | null;
}
export interface Account {
  customerId: string; role: 'OWNER' | 'BUYER' | 'VIEWER'; name: string; isApproved: boolean;
  terms: { cashPercent: number; chequeDueDays: number[] };
  support: { firstName: string | null; lastName: string | null; username: string | null } | null;
  members: { id: string; firstName: string | null; lastName: string | null; username: string | null; role: string }[];
}
export interface Me { id: string; firstName: string | null; lastName: string | null; staffRole?: 'ADMIN' | 'SALES' | null; accounts: Account[] }
export interface OrderItem { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null; priceStatus: 'PRICED' | 'INQUIRY' }
export interface Order {
  id: string; number: number; status: string; statusFa: string; createdAt: string; note: string | null; total: string;
  items: OrderItem[]; customer: { id: string; name: string }; placedBy: { firstName: string | null; lastName: string | null } | null;
  split?: { cash: string; cheque: string }; events?: { id: string; status: string; comment: string | null; createdAt: string }[];
  termsSnapshot?: { cashPercent?: number; chequeDueDays?: number[] } | null;
}

let token: string | null = null;
try { token = sessionStorage.getItem('token'); } catch { /* storage blocked */ }
let loginPromise: Promise<boolean> | null = null;

/** Exchanges Telegram initData for a session. Without Telegram (plain browser) the catalog still works read-only. */
export function login(): Promise<boolean> {
  if (token) return Promise.resolve(true);
  if (!loginPromise) {
    loginPromise = (async () => {
      const initData = tg()?.initData;
      if (!initData) return false;
      const r = await fetch('/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) });
      if (!r.ok) return false;
      token = (await r.json()).token as string;
      try { sessionStorage.setItem('token', token); } catch { /* ignore */ }
      return true;
    })().catch(() => false);
  }
  return loginPromise;
}
export const isLoggedIn = () => !!token;

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch('/api' + path, { method: init?.method ?? 'GET', headers, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
  if (r.status === 401 && token) { token = null; loginPromise = null; try { sessionStorage.removeItem('token'); } catch { /* */ } }
  if (!r.ok) {
    let msg = 'خطا در ارتباط با سرور';
    try { const j = await r.json(); if (typeof j?.message === 'string') msg = j.message; } catch { /* not json */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

export async function apiForm<T>(path: string, body: FormData): Promise<T> {
  const r = await fetch('/api' + path, { method: 'POST', body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) {
    let msg = 'خطا در ارتباط با سرور';
    try { const j = await r.json(); if (typeof j?.message === 'string') msg = j.message; } catch { /* */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

/** Tiny fetch hook: data, error, reload. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [state, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) { set({ data: null, error: null, loading: false }); return; }
    let live = true;
    set(s => ({ ...s, loading: true, error: null }));
    api<T>(path).then(d => live && set({ data: d, error: null, loading: false }), (e: Error) => live && set({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { ...state, reload: () => setN(x => x + 1) };
}

// ───────── cart (kept on this device) ─────────
export interface CartLine {
  variantId: string; slug: string; name: string; label: string; photo: string | null;
  perPack: number | null; packName: string | null; unitName: string; price: string | null;
  n: number; mode: 'unit' | 'pack';
}
export const lineUnits = (l: Pick<CartLine, 'n' | 'mode' | 'perPack'>) => (l.mode === 'pack' && l.perPack ? l.n * l.perPack : l.n);
export const lineTotal = (l: CartLine) => (l.price === null ? null : BigInt(l.price) * BigInt(lineUnits(l)));

const CART_KEY = 'iplast.cart.v1';
export function loadCart(): CartLine[] {
  try { const v = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveCart(c: CartLine[]) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* */ } }

export const ROLE_FA: Record<string, string> = { OWNER: 'مدیر حساب', BUYER: 'کارشناس خرید', VIEWER: 'فقط مشاهده' };
export const personName = (p?: { firstName: string | null; lastName?: string | null; username?: string | null } | null) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(' ') || (p.username ? '@' + p.username : 'بی‌نام') : '—';

export const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/** Jalali (شمسی) date → ISO date (YYYY-MM-DD), for cheque due dates. */
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
export function jalaliToday(): [number, number, number] {
  const p = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  const g = (t: string) => Number(p.find(x => x.type === t)?.value);
  return [g('year'), g('month'), g('day')];
}

/** Phone photos can be large (or HEIC): redraw as a JPEG of at most 1600px so the upload is small and readable. */
export async function shrinkPhoto(f: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('x'))), 'image/jpeg', 0.85));
  } catch { return f; }
}
