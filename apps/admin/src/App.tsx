import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, Me, api, getToken, personName, setToken, setUnauthorizedHandler, toEnDigits, ROLE_FA } from './lib';
import { ApprovalsPage } from './pages/Approvals';
import { ProductsPage } from './pages/Products';
import { StaffPage } from './pages/Staff';
import { PricesPage } from './pages/Prices';
import { AccountsPage } from './pages/Accounts';
import { CustomersPage, JoinsPage } from './pages/Customers';
import { WarehousePage } from './pages/Warehouse';
import { MessagesPage } from './pages/Messages';
import { ProxyPage } from './pages/Proxy';
import { DashboardPage } from './pages/Dashboard';
import { ChatsPage } from './pages/Chats';
import { AiPage } from './pages/Ai';
import { GrowthPage } from './pages/Growth';
import { NewOrderPage } from './pages/NewOrder';
import { Icon } from './icons';

interface Ctx { me: Me; toast: (t: string) => void; open: (section: string, id?: string) => void }
const AdminCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAdmin = () => useContext(AdminCtx);

// Work areas (branches) and their pages (sub-branches). A page id is "<area>/<page>"; the hash is "#<page id>[/<item id>]".
type Role = NonNullable<Me['staffRole']>;
interface Leaf { id: string; title: string; roles: Role[]; badge?: keyof Queue }
interface Area { id: string; title: string; icon: string; roles: Role[]; pages: Leaf[] }
export interface Queue { salesReview: number; finalApproval: number; needsFix: number; warehouse: number; newCustomers: number; joinRequests: number; reportedPayments: number; unansweredChats: number }
const A: Role[] = ['ADMIN'], AS: Role[] = ['ADMIN', 'SALES'], ALL: Role[] = ['ADMIN', 'SALES', 'WAREHOUSE'];
const AREAS: Area[] = [
  { id: 'home', title: 'پیشخوان', icon: 'home', roles: ALL, pages: [{ id: 'home/dashboard', title: 'پیشخوان', roles: ALL }] },
  { id: 'orders', title: 'سفارش‌ها', icon: 'check', roles: AS, pages: [
    { id: 'orders/agent', title: 'منتظر کارشناس', roles: AS, badge: 'salesReview' },
    { id: 'orders/final', title: 'منتظر تأیید نهایی', roles: A, badge: 'finalApproval' },
    { id: 'orders/history', title: 'همه‌ی سفارش‌ها', roles: AS },
    { id: 'orders/new', title: 'ثبت سفارش تلفنی', roles: AS },
  ] },
  { id: 'chats', title: 'گفتگوها', icon: 'chat', roles: AS, pages: [
    { id: 'chats/human', title: 'نیاز به کارشناس', roles: AS, badge: 'unansweredChats' },
    { id: 'chats/ai', title: 'در دست ایجنت', roles: AS },
    { id: 'chats/all', title: 'همه', roles: AS },
  ] },
  { id: 'customers', title: 'مشتریان', icon: 'users', roles: AS, pages: [
    { id: 'customers/settings', title: 'همه‌ی مشتریان', roles: AS },
    { id: 'customers/new', title: 'منتظر تأیید', roles: AS, badge: 'newCustomers' },
    { id: 'customers/joins', title: 'درخواست عضویت', roles: AS, badge: 'joinRequests' },
  ] },
  { id: 'money', title: 'مالی', icon: 'wallet', roles: AS, pages: [
    { id: 'customers/accounts', title: 'مانده‌ی حساب‌ها', roles: AS },
    { id: 'customers/receipts', title: 'رسیدهای پرداخت', roles: AS, badge: 'reportedPayments' },
  ] },
  { id: 'growth', title: 'جذب مشتری', icon: 'spark', roles: AS, pages: [{ id: 'growth/invite', title: 'جذب مشتری', roles: AS }] },
  { id: 'warehouse', title: 'انبار و ارسال', icon: 'truck', roles: ['ADMIN', 'WAREHOUSE'], pages: [{ id: 'warehouse/queue', title: 'انبار و ارسال', roles: ['ADMIN', 'WAREHOUSE'], badge: 'warehouse' }] },
  { id: 'catalog', title: 'کاتالوگ', icon: 'box', roles: AS, pages: [
    { id: 'catalog/products', title: 'کالاها', roles: AS },
    { id: 'catalog/prices', title: 'به‌روزرسانی قیمت', roles: AS },
  ] },
  { id: 'system', title: 'تنظیمات', icon: 'shield', roles: A, pages: [
    { id: 'system/ai', title: 'ایجنت هوش مصنوعی', roles: A },
    { id: 'system/staff', title: 'کارکنان', roles: A },
    { id: 'system/messages', title: 'پیام و اعلان', roles: A },
    { id: 'system/proxy', title: 'پراکسی سرور', roles: A },
  ] },
];
const LEAVES = AREAS.flatMap(a => a.pages.map(p => ({ ...p, area: a })));
// older names that pages and links still use
const ALIAS: Record<string, string> = { dashboard: 'home/dashboard', approvals: 'orders/agent', chats: 'chats/human', warehouse: 'warehouse/queue', accounts: 'customers/accounts', customers: 'customers/settings', products: 'catalog/products', prices: 'catalog/prices', staff: 'system/staff', messages: 'system/messages', proxy: 'system/proxy' };
function parseHash(): [string, string | undefined] {
  const h = location.hash.slice(1);
  const leaf = LEAVES.find(l => h === l.id || h.startsWith(l.id + '/'));
  if (leaf) return [leaf.id, h.slice(leaf.id.length + 1) || undefined];
  const [first, ...rest] = h.split('/');
  return [ALIAS[first] ?? 'home/dashboard', rest.join('/') || undefined];
}

interface TgApp { initData: string; colorScheme?: 'light' | 'dark'; ready(): void; expand(): void; platform?: string; isVersionAtLeast?(v: string): boolean; requestFullscreen?(): void; disableVerticalSwipes?(): void; onEvent?(e: string, cb: () => void): void; BackButton?: { show(): void; onClick(cb: () => void): void } }
/** Opened inside Telegram (from the mini app or the bot's /admin): signs in with the user's own Telegram account. */
const tgApp = (): TgApp | undefined => { const w = (window as unknown as { Telegram?: { WebApp?: TgApp } }).Telegram?.WebApp; return w?.initData ? w : undefined; };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken() || !!tgApp());
  const [denied, setDenied] = useState(false);
  const [section, setSection] = useState<string>(() => parseHash()[0]);
  const [navOpen, setNavOpen] = useState(false);
  const [focus, setFocus] = useState<string | undefined>(() => parseHash()[1]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [toastText, setToastText] = useState('');
  const t = useRef<number>();
  const toast = useCallback((s: string) => { setToastText(s); clearTimeout(t.current); t.current = window.setTimeout(() => setToastText(''), 2500); }, []);

  const loadMe = useCallback(() => {
    api<Me>('/me').then(m => { if (!m.staffRole) { setToken(null); setMe(null); setDenied(true); } else setMe(m); }, () => setMe(null)).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    const app = tgApp();
    if (app) {
      app.ready(); app.expand();
      const at = (v: string) => { try { return !!app.isVersionAtLeast?.(v); } catch { return false; } };
      try { if (at('7.7')) app.disableVerticalSwipes?.(); } catch { /* old client */ }
      try { if (at('8.0') && ['ios', 'android', 'android_x'].includes(app.platform ?? '')) app.requestFullscreen?.(); } catch { /* old client */ }
      const theme = () => { if (app.colorScheme) document.documentElement.dataset.theme = app.colorScheme; };
      theme(); app.onEvent?.('themeChanged', theme);
      // roles always come fresh from the database, so sign in again on every open
      api<{ token: string }>('/auth/telegram', { method: 'POST', body: { initData: app.initData } })
        .then(r => { setToken(r.token); loadMe(); }, () => { setChecking(false); setDenied(true); });
    } else if (getToken()) loadMe();
  }, [loadMe]);
  useEffect(() => { history.replaceState(null, '', `#${section}${focus ? '/' + focus : ''}`); }, [section, focus]);
  // counts on the menu: what is waiting in each page
  useEffect(() => {
    if (!me) return;
    const load = () => api<{ queue: Queue }>('/admin/dashboard').then(d => setQueue(d.queue), () => {});
    load(); const t = window.setInterval(load, 30000); return () => window.clearInterval(t);
  }, [me, section]);

  if (checking) return <div className="login"><div className="card">در حال بررسی ورود…</div></div>;
  if (!me && tgApp()) return (
    <div className="login"><div className="card">
      <h1>{denied ? 'دسترسی ندارید' : 'ورود ناموفق بود'}</h1>
      <p className="muted small" style={{ margin: 0 }}>{denied ? 'این بخش فقط برای کارکنان اصفهان پلاست است. اگر باید دسترسی داشته باشید، از مدیر بخواهید آیدی تلگرام شما را در بخش «کارکنان» اضافه کند.' : 'دوباره از داخل ربات باز کنید.'}</p>
    </div></div>
  );
  if (!me) return <Login onDone={loadMe} />;

  const role = me.staffRole!;
  const areas = AREAS.map(a => ({ ...a, pages: a.pages.filter(p => p.roles.includes(role)) })).filter(a => a.roles.includes(role) && a.pages.length);
  const leaves = areas.flatMap(a => a.pages.map(p => ({ ...p, area: a })));
  const open = (s: string, id?: string) => {
    const target = leaves.find(l => l.id === s) ?? leaves.find(l => l.id === ALIAS[s]) ?? leaves.find(l => l.area.id === s);
    setSection(target?.id ?? leaves[0].id); setFocus(id); setNavOpen(false); window.scrollTo(0, 0);
  };
  const cur = leaves.find(l => l.id === section) ?? leaves[0];
  const n = (b?: keyof Queue) => (b && queue ? queue[b] : 0);
  const areaCount = (a: Area) => a.pages.reduce((x, p) => x + n(p.badge), 0);
  const Badge = ({ v }: { v: number }) => (v ? <span className="cnt num">{v.toLocaleString('fa-IR')}</span> : null);
  // phone: the four busiest areas sit in a bottom bar within thumb reach; the rest are under «بیشتر»
  const bottom = areas.filter(a => ['home', 'orders', 'chats', 'warehouse', 'catalog'].includes(a.id)).slice(0, 4);
  const id = cur.id;
  return (
    <AdminCtx.Provider value={{ me, toast, open }}>
      <div className={navOpen ? 'shell nav-open' : 'shell'}>
        <aside className="side">
          <div className="brand"><span className="mark">iP</span><div>اصفهان پلاست<small>پنل مدیریت</small></div></div>
          <nav className="tree">{areas.map(a => {
            const here = a.id === cur.area.id;
            if (a.pages.length === 1) return (
              <button key={a.id} type="button" className="area" aria-current={here ? 'page' : undefined} onClick={() => open(a.pages[0].id)}><Icon n={a.icon} /><span>{a.title}</span><Badge v={areaCount(a)} /></button>
            );
            return (
              <div key={a.id} className={here ? 'branch open' : 'branch'}>
                <button type="button" className="area" aria-expanded={here} onClick={() => open(a.pages[0].id)}><Icon n={a.icon} /><span>{a.title}</span>{!here && <Badge v={areaCount(a)} />}<i className="chev" /></button>
                {here && <div className="leaves">{a.pages.map(p => (
                  <button key={p.id} type="button" aria-current={p.id === id ? 'page' : undefined} onClick={() => open(p.id)}><span>{p.title}</span><Badge v={n(p.badge)} /></button>
                ))}</div>}
              </div>
            );
          })}</nav>
          <div className="who">
            <span className="avatar">{personName(me).slice(0, 1)}</span>
            <div><b>{personName(me)}</b><small>{ROLE_FA[role]}</small></div>
            {!tgApp() && <button type="button" title="خروج" aria-label="خروج" onClick={() => { setToken(null); setMe(null); }}><Icon n="logout" /></button>}
          </div>
        </aside>
        <div className="scrim" onClick={() => setNavOpen(false)} />
        <header className="top">
          <div className="crumb"><span className="muted">{cur.area.title}</span>{cur.area.pages.length > 1 && <><span className="sep">/</span><b>{cur.title}</b></>}</div>
          {cur.area.pages.length > 1 && (
            <div className="subtabs" role="tablist">{cur.area.pages.map(p => (
              <button key={p.id} type="button" role="tab" aria-selected={p.id === id} onClick={() => open(p.id)}>{p.title}<Badge v={n(p.badge)} /></button>
            ))}</div>
          )}
        </header>
        <main>
          {id === 'home/dashboard' && <DashboardPage />}
          {id === 'orders/agent' && <ApprovalsPage view="agent" />}
          {id === 'orders/final' && <ApprovalsPage view="final" />}
          {id === 'orders/history' && <ApprovalsPage view="hist" />}
          {id === 'orders/new' && <NewOrderPage />}
          {id === 'growth/invite' && <GrowthPage />}
          {id.startsWith('chats/') && <ChatsPage key={id} mode={id.slice(6) as 'human' | 'ai' | 'all'} focus={focus} onFocus={setFocus} />}
          {id === 'customers/new' && <ApprovalsPage view="customers" />}
          {id === 'customers/joins' && <JoinsPage />}
          {id === 'customers/settings' && <CustomersPage focus={focus} onFocus={setFocus} />}
          {id === 'customers/accounts' && <AccountsPage focus={focus} onFocus={setFocus} />}
          {id === 'customers/receipts' && <ApprovalsPage view="pay" />}
          {id === 'warehouse/queue' && <WarehousePage />}
          {id === 'catalog/products' && <ProductsPage focus={focus} onFocus={setFocus} />}
          {id === 'catalog/prices' && <PricesPage />}
          {id === 'system/ai' && <AiPage />}
          {id === 'system/staff' && <StaffPage />}
          {id === 'system/messages' && <MessagesPage />}
          {id === 'system/proxy' && <ProxyPage />}
        </main>
        <nav className="bottombar" aria-label="بخش‌ها">
          {bottom.map(a => <button key={a.id} type="button" aria-current={a.id === cur.area.id ? 'page' : undefined} onClick={() => open(a.pages[0].id)}><Icon n={a.icon} s={20} /><span>{a.title}</span><Badge v={areaCount(a)} /></button>)}
          <button type="button" aria-current={!bottom.some(a => a.id === cur.area.id) ? 'page' : undefined} onClick={() => setNavOpen(o => !o)}><Icon n="menu" s={20} /><span>بیشتر</span></button>
        </nav>
      </div>
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </AdminCtx.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [tgId, setTgId] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'id' | 'code'>('id');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<void>) => { setErr(''); setBusy(true); try { await f(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'خطا در ارتباط'); } finally { setBusy(false); } };
  const request = () => run(async () => { await api('/auth/code/request', { method: 'POST', body: { telegramId: toEnDigits(tgId.trim()) } }); setStep('code'); });
  const verify = () => run(async () => {
    const r = await api<{ token: string }>('/auth/code/verify', { method: 'POST', body: { telegramId: toEnDigits(tgId.trim()), code: toEnDigits(code.trim()) } });
    setToken(r.token); onDone();
  });

  return (
    <div className="login">
      <form className="card" onSubmit={e => { e.preventDefault(); if (step === 'id') request(); else verify(); }}>
        <div><h1>ورود به پنل مدیریت</h1><p className="muted small" style={{ margin: '4px 0 0' }}>اصفهان پلاست · iPlast</p></div>
        {step === 'id' ? (
          <>
            <label className="f"><span>آیدی عددی تلگرام</span><input className="in num" dir="ltr" inputMode="numeric" value={tgId} onChange={e => setTgId(e.target.value)} autoFocus /></label>
            <p className="muted small" style={{ margin: 0 }}>آیدی عددی را با فرستادن /id به ربات ببینید. اگر جزو مدیران یا کارشناسان فروش باشید، کد ورود را ربات برایتان می‌فرستد.</p>
          </>
        ) : (
          <>
            <label className="f"><span>کد ۶ رقمی که ربات فرستاد</span><input className="in num" dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} autoFocus /></label>
            <button type="button" className="btn sm" style={{ justifySelf: 'start' }} onClick={() => { setStep('id'); setCode(''); }}>تغییر آیدی</button>
          </>
        )}
        {err && <div className="err">{err}</div>}
        <button type="submit" className="btn primary" disabled={busy || (step === 'id' ? !tgId.trim() : code.trim().length < 6)}>{busy ? 'صبر کنید…' : step === 'id' ? 'دریافت کد از ربات' : 'ورود'}</button>
      </form>
    </div>
  );
}
