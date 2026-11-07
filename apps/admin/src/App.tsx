import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, Me, api, getToken, personName, setToken, setUnauthorizedHandler, toEnDigits, ROLE_FA } from './lib';
import { ApprovalsPage } from './pages/Approvals';
import { ProductsPage } from './pages/Products';
import { StaffPage } from './pages/Staff';
import { PricesPage } from './pages/Prices';

interface Ctx { me: Me; toast: (t: string) => void; open: (section: string, id?: string) => void }
const AdminCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAdmin = () => useContext(AdminCtx);

// Focused on decisions and the catalog: approve orders and customers, define products, keep prices current.
// Conversations stay in the bot chat itself (staff reply there).
const SECTIONS = [
  { id: 'approvals', title: 'تأییدها' },
  { id: 'products', title: 'کالاها' },
  { id: 'prices', title: 'لیست قیمت (PDF)' },
  { id: 'staff', title: 'کارشناسان', admin: true },
] as const;

interface TgApp { initData: string; colorScheme?: 'light' | 'dark'; ready(): void; expand(): void; onEvent?(e: string, cb: () => void): void; BackButton?: { show(): void; onClick(cb: () => void): void } }
/** Opened inside Telegram (from the mini app or the bot's /admin): signs in with the user's own Telegram account. */
const tgApp = (): TgApp | undefined => { const w = (window as unknown as { Telegram?: { WebApp?: TgApp } }).Telegram?.WebApp; return w?.initData ? w : undefined; };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken() || !!tgApp());
  const [denied, setDenied] = useState(false);
  const [section, setSection] = useState<string>(() => { const h = location.hash.slice(1).split('/')[0]; return ['approvals', 'products', 'prices', 'staff'].includes(h) ? h : 'approvals'; });
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
      const theme = () => { if (app.colorScheme) document.documentElement.dataset.theme = app.colorScheme; };
      theme(); app.onEvent?.('themeChanged', theme);
      app.BackButton?.show(); app.BackButton?.onClick(() => { location.href = '/'; });
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
      <p className="muted small" style={{ margin: 0 }}>{denied ? 'این بخش فقط برای مدیران و کارشناسان فروش است. اگر باید دسترسی داشته باشید، از مدیر بخواهید آیدی تلگرام شما را در بخش «پشتیبان‌ها و مدیران» اضافه کند.' : 'دوباره از داخل ربات باز کنید.'}</p>
      <a className="btn" href="/">بازگشت به فروشگاه</a>
    </div></div>
  );
  if (!me) return <Login onDone={loadMe} />;

  const open = (s: string, id?: string) => { setSection(s); setFocus(id); };
  const visible = SECTIONS.filter(s => !('admin' in s) || me.staffRole === 'ADMIN');
  return (
    <AdminCtx.Provider value={{ me, toast, open }}>
      <div className="shell">
        <aside className="side">
          <div className="logo">اصفهان پلاست <small>پنل مدیریت iPlast</small></div>
          <nav>{visible.map(s => <button key={s.id} type="button" aria-current={s.id === section ? 'page' : undefined} onClick={() => open(s.id)}>{s.title}</button>)}</nav>
          <div className="who"><span>{personName(me)} · {ROLE_FA[me.staffRole!]}</span>{tgApp() ? <a href="/" style={{ color: 'inherit' }}>بازگشت به فروشگاه</a> : <button type="button" onClick={() => { setToken(null); setMe(null); }}>خروج</button>}</div>
        </aside>
        <main>
          {section === 'approvals' && <ApprovalsPage />}
          {section === 'products' && <ProductsPage focus={focus} onFocus={setFocus} />}
          {section === 'prices' && <PricesPage />}
          {section === 'staff' && me.staffRole === 'ADMIN' && <StaffPage />}
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
