import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, ROLE_FA, Staff, api, fa, personName, toEnDigits, useApi } from '../lib';

export function StaffPage() {
  const { me, toast } = useAdmin();
  const list = useApi<Staff[]>('/admin/staff');
  const [tg, setTg] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState('SALES');
  const run = async (f: () => Promise<unknown>, ok: string) => { try { await f(); list.reload(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : 'انجام نشد'); } };

  return (
    <>
      <div className="head"><h1>پشتیبان‌ها و مدیران</h1></div>
      <div className="note">پیام‌هایی که مشتری در ربات می‌فرستد (متن، ویس، عکس، PDF) به پشتیبان ثابت همان مشتری می‌رسد؛ اگر پشتیبان ثابت نداشته باشد، بین کارشناسان فعال به نوبت پخش می‌شود. هر کارشناس با آیدی عددی تلگرام تعریف می‌شود و برای ورود به همین پنل، کد را از ربات می‌گیرد.</div>
      <div className="card pad row">
        <input className="in num" dir="ltr" placeholder="آیدی عددی تلگرام" style={{ width: 180 }} value={tg} onChange={e => setTg(e.target.value)} />
        <input className="in" placeholder="نام" style={{ width: 160 }} value={name} onChange={e => setName(e.target.value)} />
        <select className="in" value={role} onChange={e => setRole(e.target.value)}><option value="SALES">کارشناس فروش</option><option value="ADMIN">مدیر</option></select>
        <button type="button" className="btn primary" disabled={!/^\d{3,}$/.test(toEnDigits(tg.trim()))}
          onClick={() => run(() => api('/admin/staff', { method: 'POST', body: { telegramId: toEnDigits(tg.trim()), firstName: name.trim() || undefined, role } }).then(() => { setTg(''); setName(''); }), 'اضافه شد')}>افزودن</button>
      </div>
      <div className="card tablewrap">
        {list.error ? <div className="pad err">{list.error}</div> : !list.data ? <div className="pad muted">در حال بارگذاری…</div> : (
          <table>
            <thead><tr><th>نام</th><th>آیدی تلگرام</th><th>نقش</th><th>مشتریان ثابت</th><th>وضعیت</th></tr></thead>
            <tbody>{list.data.map(s => (
              <tr key={s.id}>
                <td><b>{personName(s)}</b>{s.id === me.id && <span className="st gray" style={{ marginInlineStart: 6 }}>شما</span>}</td>
                <td className="num small" dir="ltr" style={{ textAlign: 'right' }}>{s.telegramId}</td>
                <td><select className="in" value={s.staffRole} disabled={s.id === me.id} onChange={e => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'نقش تغییر کرد')}>
                  <option value="SALES">{ROLE_FA.SALES}</option><option value="ADMIN">{ROLE_FA.ADMIN}</option></select></td>
                <td className="num small">{fa(s._count.supportOf)}</td>
                <td>{s.id === me.id ? <span className="st ok">فعال</span> : (
                  <button type="button" className={`btn sm ${s.isActive ? 'danger' : ''}`} onClick={() => run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }), s.isActive ? 'غیرفعال شد' : 'فعال شد')}>{s.isActive ? 'غیرفعال کردن' : 'فعال کردن'}</button>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
