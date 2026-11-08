import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, ROLE_FA, Staff, api, fa, personName, toEnDigits, useApi } from '../lib';

const ROLE_HELP: Record<string, string> = {
  SALES: 'پیش‌فاکتورهای مشتریان خودش را بررسی و تأیید می‌کند و با آن‌ها در ربات گفتگو می‌کند.',
  WAREHOUSE: 'سفارش‌های تأیید نهایی‌شده را می‌گیرد، آماده و ارسال می‌کند.',
  ADMIN: 'تأیید نهایی، تعریف کالا و قیمت، کارکنان، پیام همگانی.',
};

/** Staff, each defined by their numeric Telegram ID: managers, sales agents (each with their own customers) and warehouse. */
export function StaffPage() {
  const { me, toast } = useAdmin();
  const list = useApi<Staff[]>('/admin/staff');
  const [tg, setTg] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState('SALES');
  const run = async (f: () => Promise<unknown>, ok: string) => { try { await f(); list.reload(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : 'انجام نشد'); } };
  const [deact, setDeact] = useState<string | null>(null); const [moveTo, setMoveTo] = useState('');
  const [oTg, setOTg] = useState(''); const [oName, setOName] = useState(''); const [oPhone, setOPhone] = useState(''); const [keepOld, setKeepOld] = useState(true);
  const iAmOwner = !!list.data?.find(x => x.id === me.id)?.owner;
  const activeAgents = (list.data ?? []).filter(x => x.isActive && x.staffRole !== 'WAREHOUSE');
  const setActive = (s: Staff, on: boolean, move?: string) => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { isActive: on, ...(move !== undefined ? { moveCustomersTo: move || null } : {}) } }).then(() => setDeact(null)), on ? 'فعال شد' : 'غیرفعال شد');
  const transfer = () => {
    const id = toEnDigits(oTg.trim());
    if (!window.confirm(`مدیریت ارشد به آیدی ${id} منتقل شود؟${keepOld ? '' : '\nدسترسی شما به پنل مدیریت برداشته می‌شود.'}\nاین کار را فقط مدیر ارشد جدید می‌تواند برگرداند.`)) return;
    run(() => api('/admin/staff/owner', { method: 'POST', body: { telegramId: id, firstName: oName.trim() || undefined, phone: oPhone.trim() || undefined, keepOld } }).then(() => { setOTg(''); setOName(''); setOPhone(''); if (!keepOld) window.setTimeout(() => location.reload(), 1500); }), 'مدیریت ارشد منتقل شد');
  };
  const groups = (['ADMIN', 'SALES', 'WAREHOUSE'] as const).map(r => ({ r, rows: (list.data ?? []).filter(s => s.staffRole === r) }));

  return (
    <>
      <div className="head"><h1>کارکنان</h1></div>
      <section className="card pad stack">
        <h2 style={{ margin: 0 }}>افزودن با آیدی تلگرام</h2>
        <div className="row2">
          <label className="f"><span>آیدی عددی تلگرام</span><input className="in num" dir="ltr" inputMode="numeric" value={tg} onChange={e => setTg(e.target.value)} /></label>
          <label className="f"><span>نام</span><input className="in" value={name} onChange={e => setName(e.target.value)} /></label>
        </div>
        <label className="f"><span>نقش</span>
          <select className="in" value={role} onChange={e => setRole(e.target.value)}><option value="SALES">{ROLE_FA.SALES}</option><option value="WAREHOUSE">{ROLE_FA.WAREHOUSE}</option><option value="ADMIN">{ROLE_FA.ADMIN}</option></select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>{ROLE_HELP[role]} آیدی عددی را هر کس با فرستادن /id به ربات می‌بیند. بعد از افزودن، از دکمه‌ی «پنل مدیریت» در ربات وارد می‌شود.</p>
        <button type="button" className="btn primary" disabled={!/^\d{4,}$/.test(toEnDigits(tg.trim()))}
          onClick={() => run(() => api('/admin/staff', { method: 'POST', body: { telegramId: toEnDigits(tg.trim()), firstName: name.trim() || undefined, role } }).then(() => { setTg(''); setName(''); }), 'اضافه شد')}>افزودن</button>
      </section>
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : groups.map(g => (
        <section key={g.r} className="stack">
          <h2>{g.r === 'SALES' ? 'کارشناسان فروش' : g.r === 'ADMIN' ? 'مدیران ارشد' : 'انبار'} <span className="muted small num">({fa(g.rows.length)})</span></h2>
          {!g.rows.length ? <div className="empty small">{g.r === 'WAREHOUSE' ? 'کسی تعریف نشده؛ سفارش‌های تأییدشده برای مدیران می‌رود.' : 'کسی تعریف نشده است.'}</div> : (
            <div className="card plist">
              {g.rows.map(s => (
                <div key={s.id} className="prow static staffrow">
                  <span className="pinfo">
                    <b>{personName(s)}{s.owner && <span className="st ok" style={{ marginInlineStart: 6 }}>👑 مدیر ارشد اصلی</span>}{s.id === me.id && <span className="st gray" style={{ marginInlineStart: 6 }}>شما</span>}{!s.isActive && <span className="st no" style={{ marginInlineStart: 6 }}>غیرفعال</span>}</b>
                    <span className="muted small num" dir="ltr" style={{ textAlign: 'right' }}>{s.telegramId}{s.username ? ` · @${s.username}` : ''}{s.phone ? ` · ${s.phone}` : ''}</span>
                    {g.r === 'SALES' && <span className="small num">{fa(s._count.supportOf)} مشتری</span>}
                  </span>
                  {s.id !== me.id && !s.owner && (
                    <span className="row" style={{ gap: 6 }}>
                      <select className="in sm" aria-label="نقش" value={s.staffRole} onChange={e => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'نقش تغییر کرد')}>
                        <option value="SALES">{ROLE_FA.SALES}</option><option value="WAREHOUSE">{ROLE_FA.WAREHOUSE}</option><option value="ADMIN">{ROLE_FA.ADMIN}</option>
                      </select>
                      <label className="switch" title={s.isActive ? 'فعال' : 'غیرفعال'}>
                        <input type="checkbox" checked={s.isActive} onChange={() => { if (!s.isActive) setActive(s, true); else if (s._count.supportOf > 0) { setDeact(s.id); setMoveTo(''); } else setActive(s, false); }} />
                        <span>{s.isActive ? 'فعال' : 'غیرفعال'}</span>
                      </label>
                    </span>
                  )}
                  {deact === s.id && (
                    <div className="deact">
                      <span className="small">{fa(s._count.supportOf)} مشتریِ {personName(s)} به چه کسی سپرده شود؟</span>
                      <select className="in sm" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                        <option value="">بدون کارشناس (همه‌ی کارشناسان می‌بینند)</option>
                        {activeAgents.filter(a => a.id !== s.id).map(a => <option key={a.id} value={a.id}>{personName(a)} · {ROLE_FA[a.staffRole]}</option>)}
                      </select>
                      <span className="row" style={{ gap: 6 }}>
                        <button type="button" className="btn sm primary" onClick={() => setActive(s, false, moveTo)}>غیرفعال کن</button>
                        <button type="button" className="btn sm ghost" onClick={() => setDeact(null)}>انصراف</button>
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      {iAmOwner && (
        <section className="card pad stack">
          <h2 style={{ margin: 0 }}>👑 انتقال مدیریت ارشد</h2>
          <p className="muted small" style={{ margin: 0 }}>اگر مدیر ارشد عوض شد، مدیریت را به آیدی تلگرام (و شماره‌ی) شخص جدید بدهید. از آن به بعد او مدیر ارشد اصلی است: تأیید نهایی، کارکنان، تنظیمات و گزارش پشتیبان روزانه برای او می‌رود. قبلش از او بخواهید یک بار ربات را استارت کند و /id بفرستد.</p>
          <div className="row2">
            <label className="f"><span>آیدی عددی تلگرام مدیر جدید</span><input className="in num" dir="ltr" inputMode="numeric" value={oTg} onChange={e => setOTg(e.target.value)} /></label>
            <label className="f"><span>شماره موبایل</span><input className="in num" dir="ltr" inputMode="tel" placeholder="09…" value={oPhone} onChange={e => setOPhone(e.target.value)} /></label>
          </div>
          <label className="f"><span>نام</span><input className="in" value={oName} onChange={e => setOName(e.target.value)} /></label>
          <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={keepOld} onChange={e => setKeepOld(e.target.checked)} /> من به‌عنوان مدیر (غیر اصلی) بمانم</label>
          <button type="button" className="btn primary" disabled={!/^\d{4,}$/.test(toEnDigits(oTg.trim()))} onClick={transfer}>انتقال مدیریت</button>
        </section>
      )}
      {iAmOwner && (
        <section className="card pad stack">
          <h2 style={{ margin: 0 }}>پاک کردن همه‌ی گفتگوها</h2>
          <p className="muted small" style={{ margin: 0 }}>همه‌ی چت‌های ربات و پنل از پنل مدیریت پاک می‌شود (پیام‌های داخل تلگرام مشتری‌ها می‌ماند). یک گفتگو را هم می‌توانید از خود صفحه‌ی گفتگوها پاک کنید.</p>
          <button type="button" className="btn ghost" style={{ color: '#b42318' }} onClick={() => {
            const c = window.prompt('همه‌ی گفتگوها برای همیشه پاک می‌شود. برای تأیید بنویسید: پاک کن');
            if (c === null) return;
            run(() => api('/admin/staff/reset', { method: 'POST', body: { scope: 'chats', confirm: c } }), 'همه‌ی گفتگوها پاک شد');
          }}>پاک کردن همه‌ی گفتگوها</button>
        </section>
      )}
      <p className="muted small">مشتریِ هر کارشناس را در «حساب مشتریان» ← کارت «شرایط پرداخت و کارشناس» تعیین کنید. پیام‌های مشتری در ربات به کارشناس خودش می‌رسد.</p>
    </>
  );
}
