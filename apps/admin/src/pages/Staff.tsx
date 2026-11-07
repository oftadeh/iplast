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
                    <b>{personName(s)}{s.id === me.id && <span className="st gray" style={{ marginInlineStart: 6 }}>شما</span>}{!s.isActive && <span className="st no" style={{ marginInlineStart: 6 }}>غیرفعال</span>}</b>
                    <span className="muted small num" dir="ltr" style={{ textAlign: 'right' }}>{s.telegramId}{s.username ? ` · @${s.username}` : ''}</span>
                    {g.r === 'SALES' && <span className="small num">{fa(s._count.supportOf)} مشتری</span>}
                  </span>
                  {s.id !== me.id && (
                    <span className="row" style={{ gap: 6 }}>
                      <select className="in sm" aria-label="نقش" value={s.staffRole} onChange={e => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'نقش تغییر کرد')}>
                        <option value="SALES">{ROLE_FA.SALES}</option><option value="WAREHOUSE">{ROLE_FA.WAREHOUSE}</option><option value="ADMIN">{ROLE_FA.ADMIN}</option>
                      </select>
                      <button type="button" className={`btn sm ${s.isActive ? 'ghost' : ''}`} onClick={() => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }), s.isActive ? 'غیرفعال شد' : 'فعال شد')}>{s.isActive ? 'غیرفعال' : 'فعال کردن'}</button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      <p className="muted small">مشتریِ هر کارشناس را در «حساب مشتریان» ← کارت «شرایط پرداخت و کارشناس» تعیین کنید. پیام‌های مشتری در ربات به کارشناس خودش می‌رسد.</p>
    </>
  );
}
