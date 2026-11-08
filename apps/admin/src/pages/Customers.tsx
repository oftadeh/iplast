import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, ROLE_FA, TYPE_FA, api, dayFa, fa, personName, toEnDigits, useApi } from '../lib';
import { TermsCard } from './Accounts';

interface Row { id: string; name: string; city: string | null; type: string; isApproved: boolean; createdAt: string; terms: { cashPercent: number } | null; support: { firstName: string | null; lastName: string | null } | null; _count: { members: number; orders: number } }
interface Member { role: string; addedAt: string; user: { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null; phone: string | null; lastSeenAt: string | null } }
interface Detail {
  id: string; name: string; city: string | null; address: string | null; type: string; isApproved: boolean; createdAt: string;
  terms: { cashPercent: number; chequeDueDays: number[]; cashDiscountPct: string; chequeMarkupPct: string } | null;
  support: { id: string; firstName: string | null; lastName: string | null; username: string | null } | null;
  members: Member[];
}
interface Discounts { defaultDiscount: number; categories: { id: string; slug: string; name: string; families: number; pct: number }[] }

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'ثبت نشد');
const ROLE_HELP: Record<string, string> = { OWNER: 'همه‌ی سفارش‌ها و حساب مالی را می‌بیند', BUYER: 'سفارش ثبت می‌کند، فقط سفارش‌های خودش را می‌بیند', VIEWER: 'فقط مشاهده‌ی سفارش‌ها و حساب' };

/** Customer settings: profile, the customer's users, payment terms and the discount per product category. */
export function CustomersPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  return focus ? <CustomerSettings id={focus} onBack={() => onFocus(undefined)} /> : <CustomerList onOpen={id => onFocus(id)} />;
}

function CustomerList({ onOpen }: { onOpen: (id: string) => void }) {
  const { me, toast } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useApi<Row[]>(`/admin/customers?q=${encodeURIComponent(query)}`);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', city: '', type: 'RETAIL' });
  const create = async () => {
    try { const c = await api<{ id: string }>('/admin/customers', { method: 'POST', body: f }); toast('مشتری ساخته شد'); onOpen(c.id); } catch (e) { toast(err(e)); }
  };
  return (
    <>
      <div className="head"><h1>تنظیمات مشتریان</h1>{me.staffRole === 'ADMIN' && <button type="button" className="btn ok-fill sm" onClick={() => setAdding(a => !a)}>+ مشتری جدید</button>}</div>
      <p className="muted small" style={{ margin: 0 }}>برای هر مشتری: کاربران تلگرامی و نقششان، کارشناس فروش، شرایط نقد و چک و درصد تخفیف هر دسته کالا. مشتری قیمت‌ها و درصدهای خودش را در مینی‌اپ می‌بیند.</p>
      {adding && (
        <div className="card pad stack">
          <div className="row2">
            <label className="stack small">نام فروشگاه یا شرکت<input className="in" autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={120} /></label>
            <label className="stack small">شهر<input className="in" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} maxLength={60} /></label>
          </div>
          <label className="stack small">نوع<select className="in" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>{Object.entries(TYPE_FA).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
          <div className="decide" style={{ padding: 0 }}><button type="button" className="btn ok-fill" disabled={!f.name.trim()} onClick={create}>ساخت مشتری</button><button type="button" className="btn" onClick={() => setAdding(false)}>انصراف</button></div>
        </div>
      )}
      <input className="in search" placeholder="جست‌وجوی نام مشتری" value={q} onChange={e => setQ(e.target.value)} />
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : !list.data.length ? <div className="empty">مشتری‌ای پیدا نشد.</div> : (
        <div className="card plist">
          {list.data.map(c => (
            <button key={c.id} type="button" className="prow" onClick={() => onOpen(c.id)}>
              <span className="pinfo"><b>{c.name}{!c.isApproved && <span className="st new" style={{ marginInlineStart: 6 }}>تأییدنشده</span>}</b>
                <span className="muted small num">{TYPE_FA[c.type] ?? ''}{c.city ? ` · ${c.city}` : ''} · {fa(c._count.members)} کاربر · {fa(c._count.orders)} سفارش · کارشناس: {c.support ? personName({ ...c.support, username: null }) : '—'}</span></span>
              <span className="num small">نقد {fa(c.terms?.cashPercent ?? 100)}٪</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CustomerSettings({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useApi<Detail>(`/admin/customers/${id}`);
  if (d.error) return <div className="err">{d.error}</div>;
  if (!d.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const c = d.data;
  return (
    <>
      <div className="head"><button type="button" className="btn sm" onClick={onBack}>→ مشتریان</button></div>
      <Profile c={c} onDone={d.reload} />
      <Members c={c} onDone={d.reload} />
      <TermsCard customerId={id} c={c} onDone={d.reload} />
      <CategoryDiscounts customerId={id} />
    </>
  );
}

function Profile({ c, onDone }: { c: Detail; onDone: () => void }) {
  const { toast } = useAdmin();
  const init = () => ({ name: c.name, city: c.city ?? '', address: c.address ?? '', type: c.type });
  const [f, setF] = useState(init);
  const [edit, setEdit] = useState(false);
  const save = async (extra?: object) => {
    try { await api(`/admin/customers/${c.id}`, { method: 'PATCH', body: extra ?? f }); toast('ذخیره شد'); setEdit(false); onDone(); } catch (e) { toast(err(e)); }
  };
  if (!edit) return (
    <div className="card pad stack">
      <div className="between"><h1 style={{ fontSize: 19, margin: 0 }}>{c.name}</h1><button type="button" className="btn sm" onClick={() => { setF(init()); setEdit(true); }}>ویرایش مشخصات</button></div>
      <span className="muted small num">{TYPE_FA[c.type]}{c.city ? ` · ${c.city}` : ''}{c.address ? ` · ${c.address}` : ''} · عضویت از {dayFa(c.createdAt)}</span>
      {!c.isApproved && <div className="decide" style={{ padding: 0 }}><span className="st new">هنوز تأیید نشده</span><button type="button" className="btn ok-fill sm" onClick={() => save({ isApproved: true })}>✓ تأیید مشتری</button></div>}
    </div>
  );
  return (
    <div className="card pad stack">
      <h2 style={{ margin: 0 }}>مشخصات</h2>
      <div className="row2">
        <label className="stack small">نام<input className="in" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={120} /></label>
        <label className="stack small">نوع<select className="in" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>{Object.entries(TYPE_FA).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
      </div>
      <div className="row2">
        <label className="stack small">شهر<input className="in" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} maxLength={60} /></label>
        <label className="stack small">آدرس تحویل<input className="in" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} maxLength={300} /></label>
      </div>
      <div className="decide" style={{ padding: 0 }}><button type="button" className="btn ok-fill" onClick={() => save()}>ذخیره</button><button type="button" className="btn" onClick={() => setEdit(false)}>انصراف</button></div>
    </div>
  );
}

/** The customer's Telegram users: who can order, who sees the account. */
function Members({ c, onDone }: { c: Detail; onDone: () => void }) {
  const { toast } = useAdmin();
  const [f, setF] = useState({ telegramId: '', firstName: '', role: 'BUYER' });
  const [busy, setBusy] = useState(false);
  const add = async (body = f) => {
    setBusy(true);
    try { await api(`/admin/customers/${c.id}/members`, { method: 'POST', body: { ...body, telegramId: toEnDigits(body.telegramId).trim() } }); toast('کاربر ذخیره شد'); setF({ telegramId: '', firstName: '', role: 'BUYER' }); onDone(); }
    catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  const remove = async (m: Member) => {
    if (!confirm(`${personName(m.user)} از این مشتری حذف شود؟`)) return;
    try { await api(`/admin/customers/${c.id}/members/${m.user.id}`, { method: 'DELETE' }); toast('حذف شد'); onDone(); } catch (e) { toast(err(e)); }
  };
  return (
    <div className="card pad stack">
      <h2 style={{ margin: 0 }}>کاربران این مشتری <span className="muted small num">({fa(c.members.length)})</span></h2>
      {!c.members.length ? <span className="muted small">هنوز کاربری تعریف نشده است.</span> : (
        <div className="plist">
          {c.members.map(m => (
            <div key={m.user.id} className="prow static">
              <span className="pinfo"><b>{personName(m.user)}</b><span className="muted small num">آیدی <bdi>{m.user.telegramId}</bdi>{m.user.username ? ` · @${m.user.username}` : ''}{m.user.lastSeenAt ? ` · آخرین ورود ${dayFa(m.user.lastSeenAt)}` : ' · هنوز وارد نشده'}</span></span>
              <select className="in" style={{ width: 140 }} value={m.role} onChange={e => add({ telegramId: m.user.telegramId, firstName: '', role: e.target.value })} aria-label="نقش" disabled={busy}>
                {['OWNER', 'BUYER', 'VIEWER'].map(r => <option key={r} value={r}>{ROLE_FA[r]}</option>)}
              </select>
              <button type="button" className="btn sm ghost" onClick={() => remove(m)}>حذف</button>
            </div>
          ))}
        </div>
      )}
      <div className="memadd">
        <input className="in num" inputMode="numeric" placeholder="آیدی عددی تلگرام" value={f.telegramId} onChange={e => setF({ ...f, telegramId: e.target.value })} />
        <input className="in" placeholder="نام (اختیاری)" value={f.firstName} onChange={e => setF({ ...f, firstName: e.target.value })} maxLength={60} />
        <select className="in" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{['OWNER', 'BUYER', 'VIEWER'].map(r => <option key={r} value={r}>{ROLE_FA[r]}</option>)}</select>
        <button type="button" className="btn ok-fill" disabled={busy || !f.telegramId.trim()} onClick={() => add()}>+ افزودن کاربر</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{Object.entries(ROLE_HELP).map(([k, t]) => `${ROLE_FA[k]}: ${t}`).join(' · ')}. آیدی عددی را کاربر از ربات‌هایی مثل userinfobot می‌گیرد.</p>
    </div>
  );
}

/** Percent off the list price for each product category. The customer sees these as their own prices. */
function CategoryDiscounts({ customerId }: { customerId: string }) {
  const { me, toast } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const d = useApi<Discounts>(`/admin/customers/${customerId}/discounts`);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (d.data) setVals(Object.fromEntries(d.data.categories.map(c => [c.id, c.pct ? String(c.pct) : '']))); }, [d.data]);
  if (!d.data) return <div className="card pad muted">{d.error ?? 'در حال بارگذاری…'}</div>;
  const changed = d.data.categories.some(c => (Number(toEnDigits(vals[c.id] ?? '').replace('٫', '.')) || 0) !== c.pct);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<Discounts>(`/admin/customers/${customerId}/discounts`, { method: 'PUT', body: { items: d.data!.categories.map(c => ({ categoryId: c.id, pct: toEnDigits(vals[c.id] || '0').replace('٫', '.') })) } });
      d.setData(r); toast('درصدها ذخیره شد');
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card pad stack">
      <div className="between"><h2 style={{ margin: 0 }}>درصد تخفیف هر دسته کالا</h2>{can && changed && <button type="button" className="btn ok-fill sm" disabled={busy} onClick={save}>ذخیره</button>}</div>
      <div className="catdisc">
        {d.data.categories.map(c => (
          <label key={c.id} className={Number(toEnDigits(vals[c.id] ?? '')) ? 'on' : ''}>
            <span><b>{c.name}</b><small className="muted num">{fa(c.families)} محصول</small></span>
            <span className="pctin"><input className="in num" inputMode="decimal" placeholder={d.data!.defaultDiscount ? fa(d.data!.defaultDiscount) : '۰'} value={vals[c.id] ?? ''} disabled={!can} onChange={e => setVals(v => ({ ...v, [c.id]: e.target.value }))} aria-label={`درصد ${c.name}`} />٪</span>
          </label>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>درصد از قیمت لیست کم می‌شود و همان در کاتالوگ، سبد و پیش‌فاکتور این مشتری می‌آید. خالی یعنی قیمت لیست{d.data.defaultDiscount ? ` (یا ${fa(d.data.defaultDiscount)}٪ گروه قیمتی)` : ''}. قیمت اختصاصی یک کالا، اگر تعریف شده باشد، بر این درصد مقدم است.{!can ? ' تغییر درصدها با مدیر است.' : ''}</p>
    </div>
  );
}
