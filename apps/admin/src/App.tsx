import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, Me, api, getToken, personName, setToken, setUnauthorizedHandler, toEnDigits, ROLE_FA } from './lib';
import { OrdersPage } from './pages/Orders';
import { CustomersPage } from './pages/Customers';
import { StaffPage } from './pages/Staff';
import { PricesPage } from './pages/Prices';

interface Ctx { me: Me; toast: (t: string) => void; open: (section: string, id?: string) => void }
const AdminCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAdmin = () => useContext(AdminCtx);

const SECTIONS = [
  { id: 'orders', title: 'سفارش‌ها' },
  { id: 'customers', title: 'مشتریان' },
  { id: 'prices', title: 'لیست قیمت' },
  { id: 'staff', title: 'پشتیبان‌ها و مدیران', admin: true },
] as const;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [section, setSection] = useState<string>(() => location.hash.slice(1).split('/')[0] || 'orders');
  const [focus, setFocus] = useState<string | undefined>(() => location.hash.split('/')[1]);
  const [toastText, setToastText] = useState('');
  const t = useRef<number>();
  const toast = useCallback((s: string) => { setToastText(s); clearTimeout(t.current); t.current = window.setTimeout(() => setToastText(''), 2500); }, []);

  const loadMe = useCallback(() => {
    api<Me>('/me').then(m => { if (!m.staffRole) { setToken(null); setMe(null); } else setMe(m); }, () => setMe(null)).finally(() => setChecking(false));
  }, []);
  useEffect(() => { setUnauthorizedHandler(() => setMe(null)); if (getToken()) loadMe(); }, [loadMe]);
  useEffect(() => { history.replaceState(null, '', `#${section}${focus ? '/' + focus : ''}`); }, [section, focus]);

  if (checking) return <div className="login"><div className="card">در حال بررسی ورود…</div></div>;
  if (!me) return <Login onDone={loadMe} />;

  const open = (s: string, id?: string) => { setSection(s); setFocus(id); };
  const visible = SECTIONS.filter(s => !('admin' in s) || me.staffRole === 'ADMIN');
  return (
    <AdminCtx.Provider value={{ me, toast, open }}>
      <div className="shell">
        <aside className="side">
          <div className="logo">اصفهان پلاست <small>پنل مدیریت iPlast</small></div>
          <nav>{visible.map(s => <button key={s.id} type="button" aria-current={s.id === section ? 'page' : undefined} onClick={() => open(s.id)}>{s.title}</button>)}</nav>
          <div className="who"><span>{personName(me)} · {ROLE_FA[me.staffRole!]}</span><button type="button" onClick={() => { setToken(null); setMe(null); }}>خروج</button></div>
        </aside>
        <main>
          {section === 'orders' && <OrdersPage focus={focus} onFocus={setFocus} />}
          {section === 'customers' && <CustomersPage focus={focus} onFocus={setFocus} />}
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
