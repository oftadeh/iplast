import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, ROLE_FA, STATUS_CLASS, Staff, TYPE_FA, api, dateFa, fa, personName, toEnDigits, useApi } from '../lib';

interface Terms { cashPercent: number; chequeDueDays: number[]; cashDiscountPct: string; chequeMarkupPct: string }
interface Row { id: string; name: string; type: string; city: string | null; isApproved: boolean; createdAt: string; terms: Terms | null; support: { id: string; firstName: string | null; lastName: string | null } | null; _count: { members: number; orders: number } }
interface Detail extends Omit<Row, '_count' | 'support'> {
  address: string | null; supportId: string | null;
  members: { role: string; user: { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null } }[];
  orders: { id: string; number: number; status: string; createdAt: string }[];
}

export function CustomersPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  const { toast } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useApi<Row[]>(`/admin/customers?q=${encodeURIComponent(query)}`);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const create = async () => {
    try { const c = await api<{ id: string }>('/admin/customers', { method: 'POST', body: { name } }); setName(''); setAdding(false); list.reload(); onFocus(c.id); toast('مشتری ساخته شد'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'ساخته نشد'); }
  };

  return (
    <>
      <div className="head"><h1>مشتریان</h1>
        <div className="row"><input className="in search" placeholder="جست‌وجوی نام" value={q} onChange={e => setQ(e.target.value)} />
          {adding ? <><input className="in" placeholder="نام فروشگاه یا شرکت" value={name} onChange={e => setName(e.target.value)} autoFocus /><button type="button" className="btn primary" disabled={!name.trim()} onClick={create}>ساخت</button><button type="button" className="btn" onClick={() => setAdding(false)}>انصراف</button></>
            : <button type="button" className="btn primary" onClick={() => setAdding(true)}>مشتری جدید</button>}
        </div>
      </div>
      <div className="grid2">
        <div className="card tablewrap">
          {list.error ? <div className="pad err">{list.error}</div> : !list.data ? <div className="pad muted">در حال بارگذاری…</div> : !list.data.length ? <div className="empty" style={{ border: 0 }}>مشتری‌ای پیدا نشد.</div> : (
            <table>
              <thead><tr><th>نام</th><th>نوع</th><th>شهر</th><th>نقد / چک</th><th>پشتیبان</th><th>کاربران</th><th>سفارش</th></tr></thead>
              <tbody>{list.data.map(c => (
                <tr key={c.id} className="click" aria-selected={c.id === focus} onClick={() => onFocus(c.id)}>
                  <td><b>{c.name}</b>{!c.isApproved && <span className="st ask" style={{ marginInlineStart: 6 }}>در انتظار تأیید</span>}</td>
                  <td className="small">{TYPE_FA[c.type]}</td>
                  <td className="small">{c.city ?? '—'}</td>
                  <td className="num small">{c.terms ? `${fa(c.terms.cashPercent)}٪ / ${fa(100 - c.terms.cashPercent)}٪` : <span className="muted">پیش‌فرض: نقد</span>}</td>
                  <td className="small">{c.support ? personName(c.support) : <span className="muted">—</span>}</td>
                  <td className="num small">{fa(c._count.members)}</td>
                  <td className="num small">{fa(c._count.orders)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {focus ? <CustomerDetail key={focus} id={focus} onChanged={list.reload} /> : <div className="empty">یک مشتری را انتخاب کنید.</div>}
      </div>
    </>
  );
}

function CustomerDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { me, toast, open } = useAdmin();
  const c = useApi<Detail>(`/admin/customers/${id}`);
  const staff = useApi<Staff[]>(me.staffRole === 'ADMIN' ? '/admin/staff' : null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try { await f(); c.reload(); onChanged(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : 'انجام نشد'); }
  };
  if (c.error) return <div className="card pad err">{c.error}</div>;
  if (!c.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const d = c.data;
  const patch = (body: object, ok = 'ذخیره شد') => run(() => api(`/admin/customers/${id}`, { method: 'PATCH', body }), ok);

  return (
    <div className="stack">
      <div className="card pad stack">
        <div className="between"><h2>{d.name}</h2>
          {d.isApproved ? <span className="st ok">تأییدشده</span> : <button type="button" className="btn primary sm" onClick={() => patch({ isApproved: true }, 'مشتری تأیید شد')}>تأیید مشتری</button>}
        </div>
        <div className="row">
          <label className="f"><span>نوع</span><select className="in" value={d.type} onChange={e => patch({ type: e.target.value })}>{Object.entries(TYPE_FA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>شهر</span><input className="in" defaultValue={d.city ?? ''} onBlur={e => e.target.value !== (d.city ?? '') && patch({ city: e.target.value })} /></label>
          {staff.data && (
            <label className="f"><span>پشتیبان ثابت</span>
              <select className="in" value={d.supportId ?? ''} onChange={e => patch({ supportId: e.target.value || null }, 'پشتیبان تعیین شد')}>
                <option value="">بدون پشتیبان ثابت (نوبتی)</option>
                {staff.data.filter(s => s.isActive).map(s => <option key={s.id} value={s.id}>{personName(s)} · {ROLE_FA[s.staffRole]}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <TermsCard id={id} terms={d.terms} canEdit={me.staffRole === 'ADMIN'} onSaved={() => { c.reload(); onChanged(); }} />

      <div className="card pad stack">
        <h2>کاربران این مشتری</h2>
        <p className="muted small" style={{ margin: 0 }}>هر کاربر با آیدی عددی تلگرام شناخته می‌شود. «کارشناس خرید» فقط سفارش‌های خودش را می‌بیند؛ «مدیر حساب» همه‌ی سفارش‌های این مشتری را.</p>
        <table><tbody>{d.members.map(m => (
          <tr key={m.user.id}>
            <td>{personName(m.user)}<div className="muted small num" dir="ltr" style={{ textAlign: 'right' }}>{m.user.telegramId}{m.user.username ? ` · @${m.user.username}` : ''}</div></td>
            <td><select className="in" value={m.role} onChange={e => run(() => api(`/admin/customers/${id}/members`, { method: 'POST', body: { telegramId: m.user.telegramId, role: e.target.value } }), 'نقش تغییر کرد')}>
              {['OWNER', 'BUYER', 'VIEWER'].map(r => <option key={r} value={r}>{ROLE_FA[r]}</option>)}</select></td>
            <td><button type="button" className="btn sm danger" onClick={() => confirm(`${personName(m.user)} از این مشتری حذف شود؟`) && run(() => api(`/admin/customers/${id}/members/${m.user.id}`, { method: 'DELETE' }), 'حذف شد')}>حذف</button></td>
          </tr>
        ))}</tbody></table>
        <AddMember onAdd={(telegramId, firstName, role) => run(() => api(`/admin/customers/${id}/members`, { method: 'POST', body: { telegramId, firstName, role } }), 'کاربر اضافه شد')} />
      </div>

      {d.orders.length > 0 && (
        <div className="card pad stack"><h2>آخرین سفارش‌ها</h2>
          <div className="chips">{d.orders.map(o => <button key={o.id} type="button" className="chip num" onClick={() => open('orders', o.id)}>#{fa(o.number)} <span className={`st ${STATUS_CLASS(o.status)}`} style={{ fontSize: 11 }}>{dateFa(o.createdAt).split('،')[0]}</span></button>)}</div>
        </div>
      )}
    </div>
  );
}

function AddMember({ onAdd }: { onAdd: (tg: string, name: string, role: string) => void }) {
  const [tg, setTg] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState('BUYER');
  return (
    <div className="row">
      <input className="in num" dir="ltr" placeholder="آیدی عددی تلگرام" style={{ width: 160 }} value={tg} onChange={e => setTg(e.target.value)} />
      <input className="in" placeholder="نام (اختیاری)" style={{ width: 140 }} value={name} onChange={e => setName(e.target.value)} />
      <select className="in" value={role} onChange={e => setRole(e.target.value)}>{['BUYER', 'OWNER', 'VIEWER'].map(r => <option key={r} value={r}>{ROLE_FA[r]}</option>)}</select>
      <button type="button" className="btn primary" disabled={!/^\d{3,}$/.test(toEnDigits(tg.trim()))} onClick={() => { onAdd(toEnDigits(tg.trim()), name.trim(), role); setTg(''); setName(''); }}>افزودن</button>
    </div>
  );
}

function TermsCard({ id, terms, canEdit, onSaved }: { id: string; terms: Terms | null; canEdit: boolean; onSaved: () => void }) {
  const { toast } = useAdmin();
  const [cash, setCash] = useState(terms?.cashPercent ?? 100);
  const [days, setDays] = useState((terms?.chequeDueDays ?? []).join('، '));
  const [disc, setDisc] = useState(terms?.cashDiscountPct ?? '0');
  const [markup, setMarkup] = useState(terms?.chequeMarkupPct ?? '0');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const dueDays = toEnDigits(days).split(/[^\d]+/).filter(Boolean).map(Number);
      await api(`/admin/customers/${id}/terms`, { method: 'PUT', body: { cashPercent: cash, chequeDueDays: dueDays, cashDiscountPct: Number(toEnDigits(String(disc))) || 0, chequeMarkupPct: Number(toEnDigits(String(markup))) || 0 } });
      toast('شرایط تسویه ذخیره شد'); onSaved();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ذخیره نشد'); } finally { setBusy(false); }
  };
  return (
    <div className="card pad stack">
      <div className="between"><h2>شرایط تسویه (نقد / چک)</h2>{!terms && <span className="st gray">هنوز تعیین نشده</span>}</div>
      <div className="sbar"><i style={{ width: `${cash}%` }} /></div>
      <div className="between num"><b>نقد {fa(cash)}٪</b><b>چک {fa(100 - cash)}٪</b></div>
      <input type="range" min={0} max={100} step={5} value={cash} disabled={!canEdit} onChange={e => setCash(+e.target.value)} aria-label="درصد نقد" />
      <div className="row">
        <label className="f"><span>سررسید چک‌ها (روز)</span><input className="in num" placeholder="مثلاً ۶۰، ۹۰" value={days} disabled={!canEdit} onChange={e => setDays(e.target.value)} /></label>
        <label className="f"><span>تخفیف نقدی ٪</span><input className="in num" style={{ width: 90 }} value={disc} disabled={!canEdit} onChange={e => setDisc(e.target.value)} /></label>
        <label className="f"><span>افزایش چکی ٪</span><input className="in num" style={{ width: 90 }} value={markup} disabled={!canEdit} onChange={e => setMarkup(e.target.value)} /></label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>این درصدها در سبد خرید مشتری پیش‌فرض نمایش داده می‌شوند و همراه هر سفارش ذخیره می‌شوند.</p>
      {canEdit ? <button type="button" className="btn primary" disabled={busy} onClick={save}>ذخیره شرایط</button> : <div className="note">فقط مدیر می‌تواند شرایط تسویه را تغییر دهد.</div>}
    </div>
  );
}
