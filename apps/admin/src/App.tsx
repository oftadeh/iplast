import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, Me, api, getToken, personName, setToken, setUnauthorizedHandler, toEnDigits, ROLE_FA } from './lib';
import { ApprovalsPage } from './pages/Approvals';
import { ProductsPage } from './pages/Products';
import { StaffPage } from './pages/Staff';
import { PricesPage } from './pages/Prices';
import { AccountsPage } from './pages/Accounts';
import { WarehousePage } from './pages/Warehouse';
import { MessagesPage } from './pages/Messages';
import { ProxyPage } from './pages/Proxy';
import { DashboardPage } from './pages/Dashboard';
import { ChatsPage } from './pages/Chats';
import { Icon } from './icons';

interface Ctx { me: Me; toast: (t: string) => void; open: (section: string, id?: string) => void }
const AdminCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAdmin = () => useContext(AdminCtx);

// Focused on decisions and the catalog: approve orders and customers, define products, keep prices current.
// Conversations stay in the bot chat itself (staff reply there).
type Role = NonNullable<Me['staffRole']>;
const SECTIONS: { id: string; title: string; icon: string; group: string; roles: Role[] }[] = [
  { id: 'dashboard', title: 'پیشخوان', icon: 'home', group: '', roles: ['ADMIN', 'SALES', 'WAREHOUSE'] },
  { id: 'approvals', title: 'تأییدها', icon: 'check', group: 'عملیات فروش', roles: ['ADMIN', 'SALES'] },
  { id: 'chats', title: 'گفتگوها', icon: 'chat', group: 'عملیات فروش', roles: ['ADMIN', 'SALES'] },
  { id: 'warehouse', title: 'انبار و ارسال', icon: 'truck', group: 'عملیات فروش', roles: ['ADMIN', 'WAREHOUSE'] },
  { id: 'accounts', title: 'حساب مشتریان', icon: 'wallet', group: 'مالی', roles: ['ADMIN', 'SALES'] },
  { id: 'products', title: 'کالاها', icon: 'box', group: 'کاتالوگ', roles: ['ADMIN', 'SALES'] },
  { id: 'prices', title: 'به‌روزرسانی قیمت', icon: 'tag', group: 'کاتالوگ', roles: ['ADMIN', 'SALES'] },
  { id: 'messages', title: 'پیام و اعلان', icon: 'bell', group: 'مدیریت سیستم', roles: ['ADMIN'] },
  { id: 'staff', title: 'کارکنان', icon: 'users', group: 'مدیریت سیستم', roles: ['ADMIN'] },
  { id: 'proxy', title: 'پراکسی سرور', icon: 'shield', group: 'مدیریت سیستم', roles: ['ADMIN'] },
];

interface TgApp { initData: string; colorScheme?: 'light' | 'dark'; ready(): void; expand(): void; platform?: string; isVersionAtLeast?(v: string): boolean; requestFullscreen?(): void; disableVerticalSwipes?(): void; onEvent?(e: string, cb: () => void): void; BackButton?: { show(): void; onClick(cb: () => void): void } }
/** Opened inside Telegram (from the mini app or the bot's /admin): signs in with the user's own Telegram account. */
const tgApp = (): TgApp | undefined => { const w = (window as unknown as { Telegram?: { WebApp?: TgApp } }).Telegram?.WebApp; return w?.initData ? w : undefined; };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken() || !!tgApp());
  const [denied, setDenied] = useState(false);
  const [section, setSection] = useState<string>(() => { const h = location.hash.slice(1).split('/')[0]; return SECTIONS.some(s => s.id === h) ? h : 'dashboard'; });
  const [navOpen, setNavOpen] = useState(false);
  const [focus, setFocus] = useState<string | undefined>(() => location.hash.split('/')[1]);
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

  if (checking) return <div className="login"><div className="card">در حال بررسی ورود…</div></div>;
  if (!me && tgApp()) return (
    <div className="login"><div className="card">
      <h1>{denied ? 'دسترسی ندارید' : 'ورود ناموفق بود'}</h1>
      <p className="muted small" style={{ margin: 0 }}>{denied ? 'این بخش فقط برای کارکنان اصفهان پلاست است. اگر باید دسترسی داشته باشید، از مدیر بخواهید آیدی تلگرام شما را در بخش «کارکنان» اضافه کند.' : 'دوباره از داخل ربات باز کنید.'}</p>
    </div></div>
  );
  if (!me) return <Login onDone={loadMe} />;

  const open = (s: string, id?: string) => { setSection(s); setFocus(id); setNavOpen(false); window.scrollTo(0, 0); };
  const visible = SECTIONS.filter(s => s.roles.includes(me.staffRole!));
  const current = visible.some(s => s.id === section) ? section : visible[0].id;
  return (
    <AdminCtx.Provider value={{ me, toast, open }}>
      <div className={navOpen ? 'shell nav-open' : 'shell'}>
        <aside className="side">
          <div className="brand"><span className="mark">iP</span><div>اصفهان پلاست<small>پنل مدیریت</small></div></div>
          <nav>{visible.map((s, i) => (
            <div key={s.id} style={{ display: 'contents' }}>
              {s.group && s.group !== visible[i - 1]?.group && <div className="navgroup">{s.group}</div>}
              <button type="button" aria-current={s.id === current ? 'page' : undefined} onClick={() => open(s.id)}><Icon n={s.icon} />{s.title}</button>
            </div>
          ))}</nav>
          <div className="who">
            <span className="avatar">{personName(me).slice(0, 1)}</span>
            <div><b>{personName(me)}</b><small>{ROLE_FA[me.staffRole!]}</small></div>
            {!tgApp() && <button type="button" title="خروج" aria-label="خروج" onClick={() => { setToken(null); setMe(null); }}><Icon n="logout" /></button>}
          </div>
        </aside>
        <div className="scrim" onClick={() => setNavOpen(false)} />
        <header className="top">
          <button type="button" className="burger" aria-label="منو" onClick={() => setNavOpen(o => !o)}><Icon n="menu" s={20} /></button>
          <div className="crumb"><span className="muted">پنل مدیریت</span><span className="sep">/</span><b>{visible.find(s => s.id === current)?.title}</b></div>
        </header>
        <main>
          {current === 'dashboard' && <DashboardPage />}
          {current === 'approvals' && <ApprovalsPage />}
          {current === 'chats' && <ChatsPage focus={focus} onFocus={setFocus} />}
          {current === 'warehouse' && <WarehousePage />}
          {current === 'messages' && <MessagesPage />}
          {current === 'products' && <ProductsPage focus={focus} onFocus={setFocus} />}
          {current === 'prices' && <PricesPage />}
          {current === 'accounts' && <AccountsPage focus={focus} onFocus={setFocus} />}
          {current === 'staff' && <StaffPage />}
          {current === 'proxy' && <ProxyPage />}
        </main>
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
