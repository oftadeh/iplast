import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, ROLE_FA, TYPE_FA, api, dayFa, fa, pctFa, pctOff, personName, termsLine, toEnDigits, useApi, type Staff } from '../lib';
import { CustomerAccount } from './Accounts';

type Terms = { cashDiscountPct: string; termDiscountPct: string; termMonths: number; allowCash: boolean; allowTerm: boolean };
interface Row { id: string; code: number; name: string; city: string | null; type: string; isApproved: boolean; createdAt: string; terms: Terms | null; support: { id: string; firstName: string | null; lastName: string | null } | null; _count: { members: number; orders: number } }
interface Member { role: string; addedAt: string; user: { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null; phone: string | null; lastSeenAt: string | null } }
interface Detail {
  id: string; code: number; name: string; city: string | null; address: string | null; type: string; isApproved: boolean; createdAt: string; creditLimit: string | null;
  terms: Terms | null;
  support: { id: string; firstName: string | null; lastName: string | null; username: string | null } | null;
  members: Member[];
}
interface Sale {
  cashPct: number; termPct: number; termMonths: number; allowCash: boolean; allowTerm: boolean; updatedAt: string | null;
  categories: { id: string; slug: string; name: string; families: number; cash: number | null; term: number | null }[];
}

const codeFa = (n: number) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'ثبت نشد');
const ROLE_HELP: Record<string, string> = { OWNER: 'همه‌ی سفارش‌ها و حساب مالی را می‌بیند', BUYER: 'سفارش ثبت می‌کند، فقط سفارش‌های خودش را می‌بیند', VIEWER: 'فقط مشاهده‌ی سفارش‌ها و حساب' };

const TABS = [['sale', 'شرایط فروش'], ['users', 'کاربران'], ['account', 'حساب مالی'], ['profile', 'مشخصات و کارشناس']] as const;
type Tab = (typeof TABS)[number][0];

/**
 * One page per customer: sale terms (cash and term percentages), their Telegram users, their account and profile.
 * The hash is «<customer id>» or «<customer id>/<tab>».
 */
export function CustomersPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  if (!focus) return <CustomerList onOpen={id => onFocus(id)} />;
  const [id, tab] = focus.split('/');
  return <CustomerPage key={id} id={id} tab={(TABS.find(t => t[0] === tab)?.[0] ?? 'sale') as Tab} onTab={t => onFocus(`${id}/${t}`)} onBack={() => onFocus(undefined)} />;
}

function CustomerList({ onOpen }: { onOpen: (id: string) => void }) {
  const { me, toast } = useAdmin();
  const admin = me.staffRole === 'ADMIN';
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useApi<Row[]>(`/admin/customers?q=${encodeURIComponent(query)}&support=${encodeURIComponent(agent)}`);
  const staff = useApi<Staff[]>(admin ? '/admin/staff' : null);
  const agents = (staff.data ?? []).filter(u => u.isActive && u.staffRole !== 'WAREHOUSE');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', city: '', type: 'RETAIL' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const create = async () => {
    try { const c = await api<{ id: string }>('/admin/customers', { method: 'POST', body: f }); toast('مشتری ساخته شد'); onOpen(c.id); } catch (e) { toast(err(e)); }
  };
  const rows = list.data ?? [];
  const toggle = (id: string) => setSel(x => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = rows.length > 0 && rows.every(r => sel.has(r.id));
  const assign = async () => {
    const name = to === 'none' ? 'بدون کارشناس' : personName(agents.find(a => a.id === to) ?? { firstName: '', lastName: '', username: null });
    if (!confirm(`${fa(sel.size)} مشتری به «${name}» سپرده شود؟`)) return;
    try { const r = await api<{ count: number }>('/admin/customers/assign', { method: 'POST', body: { ids: [...sel], supportId: to === 'none' ? null : to } }); toast(`${fa(r.count)} مشتری به ${name} سپرده شد`); setSel(new Set()); setTo(''); list.reload(); } catch (e) { toast(err(e)); }
  };
  return (
    <>
      <div className="head"><h1>مشتریان</h1>{admin && <button type="button" className="btn ok-fill sm" onClick={() => setAdding(a => !a)}>+ مشتری جدید</button>}</div>
      <p className="muted small" style={{ margin: 0 }}>روی هر مشتری بزنید: شرایط فروش، کاربران تلگرامی (چند مسئول خرید برای یک مشتری)، حساب مالی و کارشناس فروش او. {admin ? 'برای سپردن چند مشتری به یک کارشناس، تیکشان بزنید.' : ''}</p>
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
      <div className="custfilter">
        <input className="in search" placeholder="نام، شهر یا کد مشتری" value={q} onChange={e => setQ(e.target.value)} />
        {admin && <select className="in" value={agent} onChange={e => { setAgent(e.target.value); setSel(new Set()); }} aria-label="کارشناس">
          <option value="">همه‌ی کارشناس‌ها</option><option value="none">بدون کارشناس</option>
          {agents.map(a => <option key={a.id} value={a.id}>{personName(a)}</option>)}
        </select>}
      </div>
      {admin && sel.size > 0 && (
        <div className="card pad bulkbar">
          <b className="num">{fa(sel.size)} مشتری انتخاب شده</b>
          <select className="in" value={to} onChange={e => setTo(e.target.value)} aria-label="سپردن به کارشناس">
            <option value="">سپردن به کارشناس…</option><option value="none">بدون کارشناس</option>
            {agents.map(a => <option key={a.id} value={a.id}>{personName(a)} · {a.staffRole === 'ADMIN' ? 'مدیر' : 'کارشناس فروش'}</option>)}
          </select>
          <button type="button" className="btn ok-fill sm" disabled={!to} onClick={assign}>اعمال</button>
          <button type="button" className="btn sm ghost" onClick={() => setSel(new Set())}>لغو انتخاب</button>
        </div>
      )}
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : !rows.length ? <div className="empty">مشتری‌ای پیدا نشد.</div> : (
        <div className="card plist">
          {admin && <label className="prow selall"><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map(r => r.id)))} /> <span className="small muted">انتخاب همه‌ی {fa(rows.length)} مشتری این فهرست</span></label>}
          {rows.map(c => (
            <div key={c.id} className="prow selrow">
              {admin && <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`انتخاب ${c.name}`} />}
              <button type="button" className="prowbtn" onClick={() => onOpen(c.id)}>
                <span className="pinfo"><b>{c.name} <span className="codechip num">#{codeFa(c.code)}</span>{!c.isApproved && <span className="st new" style={{ marginInlineStart: 6 }}>تأییدنشده</span>}</b>
                  <span className="muted small num">{TYPE_FA[c.type] ?? ''}{c.city ? ` · ${c.city}` : ''} · {fa(c._count.members)} کاربر · {fa(c._count.orders)} سفارش · کارشناس: {c.support ? personName({ ...c.support, username: null }) : '—'}</span></span>
                <span className="num small termsline">{termsLine(c.terms)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** «درخواست عضویت»: people who asked to join a customer account with its code. A manager approves with a role. */
export function JoinsPage() {
  const { me, toast } = useAdmin();
  const admin = me.staffRole === 'ADMIN';
  const [all, setAll] = useState(false);
  type J = { id: string; status: string; role: string; note: string | null; createdAt: string; user: { id: string; telegramId: string; firstName: string | null; lastName: string | null; username: string | null; memberships: { customer: { name: string } }[] }; customer: { id: string; name: string; city: string | null; code: number; _count: { members: number } } };
  const d = useApi<J[]>(`/admin/joins${all ? '?status=all' : ''}`);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const decide = async (j: J, ok: boolean) => {
    if (!ok && !confirm('این درخواست رد شود؟')) return;
    try { await api(`/admin/joins/${j.id}`, { method: 'POST', body: { ok, role: roles[j.id] ?? j.role } }); toast(ok ? 'عضو مجموعه شد و به او خبر داده شد' : 'رد شد'); d.reload(); } catch (e) { toast(err(e)); }
  };
  const ST: Record<string, string> = { PENDING: 'منتظر بررسی', APPROVED: 'تأیید شد', REJECTED: 'رد شد' };
  return (
    <>
      <div className="head"><h1>درخواست عضویت</h1><label className="small"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> نمایش بررسی‌شده‌ها</label></div>
      <p className="muted small" style={{ margin: 0 }}>کاربری که «کد مشتری» یک فروشگاه را دارد (مثلاً مسئول خرید دیگرِ همان مجموعه)، از پنل کاربری درخواست عضویت می‌دهد. با تأیید شما، با نقش انتخاب‌شده به آن مشتری وصل می‌شود.{!admin ? ' تأیید با مدیر است.' : ''}</p>
      {d.error ? <div className="err">{d.error}</div> : !d.data ? <div className="card pad muted">در حال بارگذاری…</div> : !d.data.length ? <div className="empty">درخواستی نیست.</div> : (
        <div className="card plist">
          {d.data.map(j => (
            <div key={j.id} className="prow static joinrow">
              <span className="pinfo">
                <b>{personName(j.user)} ← {j.customer.name} <span className="codechip num">#{codeFa(j.customer.code)}</span></b>
                <span className="muted small num">آیدی <bdi>{j.user.telegramId}</bdi>{j.user.username ? ` · @${j.user.username}` : ''} · {dayFa(j.createdAt)} · این مجموعه {fa(j.customer._count.members)} کاربر دارد{j.user.memberships.length ? ` · الان عضو: ${j.user.memberships.map(m => m.customer.name).join('، ')}` : ''}</span>
                {j.note && <span className="small">«{j.note}»</span>}
              </span>
              {j.status === 'PENDING' && admin ? (
                <span className="row" style={{ gap: 6 }}>
                  <select className="in" style={{ width: 130 }} value={roles[j.id] ?? j.role} onChange={e => setRoles({ ...roles, [j.id]: e.target.value })} aria-label="نقش">{['OWNER', 'BUYER', 'VIEWER'].map(r => <option key={r} value={r}>{ROLE_FA[r]}</option>)}</select>
                  <button type="button" className="btn ok-fill sm" onClick={() => decide(j, true)}>✓ تأیید</button>
                  <button type="button" className="btn sm ghost" onClick={() => decide(j, false)}>رد</button>
                </span>
              ) : <span className={`st ${j.status === 'APPROVED' ? 'ok' : j.status === 'REJECTED' ? 'gray' : 'new'}`}>{ST[j.status]}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CustomerPage({ id, tab, onTab, onBack }: { id: string; tab: Tab; onTab: (t: Tab) => void; onBack: () => void }) {
  const d = useApi<Detail>(`/admin/customers/${id}`);
  if (d.error) return <div className="err">{d.error}</div>;
  if (!d.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const c = d.data;
  return (
    <>
      <div className="head"><button type="button" className="btn sm" onClick={onBack}>→ همه‌ی مشتریان</button></div>
      <div className="card pad custhead">
        <div className="between">
          <div className="stack" style={{ gap: 2 }}>
            <h1 style={{ fontSize: 19 }}>{c.name} <span className="codechip num">کد {codeFa(c.code)}</span>{!c.isApproved && <span className="st new" style={{ marginInlineStart: 8, fontSize: 12 }}>تأییدنشده</span>}</h1>
            <span className="muted small num">{TYPE_FA[c.type]}{c.city ? ` · ${c.city}` : ''} · {fa(c.members.length)} کاربر · کارشناس فروش: {c.support ? personName(c.support) : 'تعیین نشده'}</span>
          </div>
          <span className="termsbadge num">{termsLine(c.terms)}</span>
        </div>
      </div>
      <div className="chips" role="tablist">{TABS.map(([k, t]) => <button key={k} type="button" role="tab" className="chip" aria-pressed={tab === k} onClick={() => onTab(k)}>{t}</button>)}</div>
      {tab === 'sale' && <SaleTerms customerId={id} onDone={d.reload} />}
      {tab === 'users' && <Members c={c} onDone={d.reload} />}
      {tab === 'account' && <CustomerAccount id={id} embedded />}
      {tab === 'profile' && <Profile c={c} onDone={d.reload} />}
    </>
  );
}

function Profile({ c, onDone }: { c: Detail; onDone: () => void }) {
  const { toast, me } = useAdmin();
  const staff = useApi<Staff[]>(me.staffRole === 'ADMIN' ? '/admin/staff' : null);
  const init = () => ({ name: c.name, city: c.city ?? '', address: c.address ?? '', type: c.type, supportId: c.support?.id ?? '', creditLimit: c.creditLimit ? fa(c.creditLimit) : '' });
  const [f, setF] = useState(init);
  const [edit, setEdit] = useState(false);
  const save = async (extra?: object) => {
    try { await api(`/admin/customers/${c.id}`, { method: 'PATCH', body: extra ?? { ...f, supportId: f.supportId || null, ...(me.staffRole === 'ADMIN' ? { creditLimit: f.creditLimit.trim() ? toEnDigits(f.creditLimit).replace(/[^\d]/g, '') : null } : { creditLimit: undefined }) } }); toast('ذخیره شد'); setEdit(false); onDone(); } catch (e) { toast(err(e)); }
  };
  const removeCustomer = async () => {
    if (!confirm(`«${c.name}» حذف شود؟ فقط مشتری بدون سفارش و حساب مالی حذف می‌شود.`)) return;
    try { await api(`/admin/customers/${c.id}`, { method: 'DELETE' }); toast('مشتری حذف شد'); location.hash = '#customers/settings'; } catch (e) { toast(err(e)); }
  };
  if (!edit) return (
    <div className="card pad stack">
      <div className="between"><h1 style={{ fontSize: 19, margin: 0 }}>{c.name}</h1><button type="button" className="btn sm" onClick={() => { setF(init()); setEdit(true); }}>ویرایش مشخصات</button></div>
      <span className="muted small num">{TYPE_FA[c.type]}{c.city ? ` · ${c.city}` : ''}{c.address ? ` · ${c.address}` : ''} · عضویت از {dayFa(c.createdAt)}</span>
      <span className="small">سقف اعتبار: <b className="num">{c.creditLimit ? `${fa(c.creditLimit)} ریال` : 'تعیین نشده'}</b>{c.creditLimit && <span className="muted"> (بالاتر از آن، موقع تأیید نهایی هشدار می‌گیرید)</span>}</span>
      <span className="small">کارشناس فروش: <b>{c.support ? personName(c.support) : 'تعیین نشده'}</b>{!c.support && <span className="muted"> (پیش‌فاکتورهای این مشتری برای همه‌ی کارشناسان می‌رود)</span>}</span>
      {!c.isApproved && <div className="decide" style={{ padding: 0 }}><span className="st new">هنوز تأیید نشده</span><button type="button" className="btn ok-fill sm" onClick={() => save({ isApproved: true })}>✓ تأیید مشتری</button></div>}
      {me.staffRole === 'ADMIN' && <button type="button" className="btn sm danger" style={{ justifySelf: 'start' }} onClick={removeCustomer}>حذف این مشتری</button>}
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
      {me.staffRole === 'ADMIN' && (
        <label className="stack small">سقف اعتبار (ریال)<input className="in num" inputMode="numeric" value={f.creditLimit} onChange={e => setF({ ...f, creditLimit: e.target.value })} placeholder="خالی = بدون سقف" /><span className="muted">اگر بدهی مشتری با سفارش جدید از این مبلغ بگذرد، موقع تأیید نهایی به شما هشدار داده می‌شود.</span></label>
      )}
      {me.staffRole === 'ADMIN' && (
        <label className="stack small">کارشناس فروش این مشتری
          <select className="in" value={f.supportId} onChange={e => setF({ ...f, supportId: e.target.value })}>
            <option value="">تعیین نشده (همه‌ی کارشناسان)</option>
            {(staff.data ?? []).filter(u => u.isActive && u.staffRole !== 'WAREHOUSE').map(u => <option key={u.id} value={u.id}>{personName(u)} · {u.staffRole === 'ADMIN' ? 'مدیر' : 'کارشناس فروش'}</option>)}
          </select>
        </label>
      )}
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
  const patch = async (m: Member, body: object) => {
    setBusy(true);
    try { await api(`/admin/customers/${c.id}/members/${m.user.id}`, { method: 'PATCH', body }); toast('ذخیره شد'); onDone(); } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  const rename = (m: Member) => {
    const n = prompt('نام این کاربر', [m.user.firstName, m.user.lastName].filter(Boolean).join(' '));
    if (n === null) return;
    const [first, ...rest] = n.trim().split(/\s+/);
    patch(m, { firstName: first ?? '', lastName: rest.join(' ') });
  };
  const remove = async (m: Member) => {
    if (!confirm(`${personName(m.user)} از این مشتری حذف شود؟`)) return;
    try { await api(`/admin/customers/${c.id}/members/${m.user.id}`, { method: 'DELETE' }); toast('حذف شد'); onDone(); } catch (e) { toast(err(e)); }
  };
  return (
    <div className="card pad stack">
      <h2 style={{ margin: 0 }}>کاربران این مشتری <span className="muted small num">({fa(c.members.length)})</span></h2>
      <p className="muted small" style={{ margin: 0 }}>هر تعداد مسئول خرید می‌توانند زیر یک کد مشتری باشند. خودشان هم می‌توانند با <b className="num">کد {codeFa(c.code)}</b> از پنل کاربری درخواست عضویت بدهند تا شما تأیید کنید.</p>
      {!c.members.length ? <span className="muted small">هنوز کاربری تعریف نشده است.</span> : (
        <div className="plist">
          {c.members.map(m => (
            <div key={m.user.id} className="prow static">
              <span className="pinfo"><b>{personName(m.user)}</b><span className="muted small num">آیدی <bdi>{m.user.telegramId}</bdi>{m.user.username ? ` · @${m.user.username}` : ''}{m.user.lastSeenAt ? ` · آخرین ورود ${dayFa(m.user.lastSeenAt)}` : ' · هنوز وارد نشده'}</span></span>
              <button type="button" className="btn sm ghost" onClick={() => rename(m)}>ویرایش نام</button>
              <select className="in" style={{ width: 140 }} value={m.role} onChange={e => patch(m, { role: e.target.value })} aria-label="نقش" disabled={busy}>
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

const num = (s: string) => toEnDigits(s).replace(/[٫/]/, '.').trim();
const SAMPLE = 1_000_000n;

/**
 * «شرایط فروش»: the two ways this customer buys. Cash = list − cash %; term = list − term %, paid by cheque after the
 * months. Optional per-category percentages override the two defaults (empty = default).
 */
function SaleTerms({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const { me, toast } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const d = useApi<Sale>(`/admin/customers/${customerId}/sale`);
  type F = { cash: string; term: string; months: string; allowCash: boolean; allowTerm: boolean; cats: Record<string, { cash: string; term: string }> };
  const faS = (n: number) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]).replace('.', '٫');
  const from = (x: Sale): F => ({
    cash: x.cashPct ? faS(x.cashPct) : '', term: x.termPct ? faS(x.termPct) : '', months: faS(x.termMonths), allowCash: x.allowCash, allowTerm: x.allowTerm,
    cats: Object.fromEntries(x.categories.map(c => [c.id, { cash: c.cash === null ? '' : faS(c.cash), term: c.term === null ? '' : faS(c.term) }])),
  });
  const [f, setF] = useState<F | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCats, setShowCats] = useState(false);
  useEffect(() => { if (d.data) { setF(from(d.data)); if (d.data.categories.some(c => c.cash !== null || c.term !== null)) setShowCats(true); } }, [d.data]);
  if (!d.data || !f) return <div className="card pad muted">{d.error ?? 'در حال بارگذاری…'}</div>;
  const dirty = JSON.stringify(f) !== JSON.stringify(from(d.data));
  const cashPct = Number(num(f.cash)) || 0, termPct = Number(num(f.term)) || 0, months = Number(num(f.months)) || 0;
  const setCat = (id: string, k: 'cash' | 'term', v: string) => setF({ ...f, cats: { ...f.cats, [id]: { ...f.cats[id], [k]: v } } });
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<Sale>(`/admin/customers/${customerId}/sale`, { method: 'PUT', body: {
        cashPct: num(f.cash) || 0, termPct: num(f.term) || 0, termMonths: num(f.months) || 3, allowCash: f.allowCash, allowTerm: f.allowTerm,
        categories: d.data!.categories.map(c => ({ id: c.id, cash: num(f.cats[c.id]?.cash ?? ''), term: num(f.cats[c.id]?.term ?? '') })),
      } });
      d.setData(r); toast('شرایط فروش ذخیره شد'); onDone();
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  const overrides = d.data.categories.filter(c => (f.cats[c.id]?.cash ?? '') !== '' || (f.cats[c.id]?.term ?? '') !== '').length;
  return (
    <div className="card pad stack">
      <div className="between">
        <h2>شرایط فروش این مشتری</h2>
        {can && dirty && <div className="row" style={{ gap: 6 }}><button type="button" className="btn sm" onClick={() => setF(from(d.data!))}>انصراف</button><button type="button" className="btn ok-fill sm" disabled={busy} onClick={save}>ذخیره</button></div>}
      </div>
      <div className="modes">
        <div className={`mode ${f.allowCash ? 'on' : 'off'}`}>
          <label className="mtitle"><input type="checkbox" checked={f.allowCash} disabled={!can} onChange={e => setF({ ...f, allowCash: e.target.checked })} /> فروش نقدی</label>
          <label className="mrow">تخفیف از قیمت لیست<span className="pctin"><input className="in num" inputMode="decimal" placeholder="۰" value={f.cash} disabled={!can || !f.allowCash} onChange={e => setF({ ...f, cash: e.target.value })} aria-label="درصد نقدی" />٪</span></label>
          <small className="muted">پرداخت کامل، نقد یا واریز.</small>
        </div>
        <div className={`mode ${f.allowTerm ? 'on' : 'off'}`}>
          <label className="mtitle"><input type="checkbox" checked={f.allowTerm} disabled={!can} onChange={e => setF({ ...f, allowTerm: e.target.checked })} /> فروش مدت‌دار (روال)</label>
          <label className="mrow">تخفیف از قیمت لیست<span className="pctin"><input className="in num" inputMode="decimal" placeholder="۰" value={f.term} disabled={!can || !f.allowTerm} onChange={e => setF({ ...f, term: e.target.value })} aria-label="درصد مدت‌دار" />٪</span></label>
          <label className="mrow">مدت پرداخت<span className="pctin"><input className="in num" inputMode="numeric" value={f.months} disabled={!can || !f.allowTerm} onChange={e => setF({ ...f, months: e.target.value })} aria-label="مدت به ماه" />ماه</span></label>
          <small className="muted">پرداخت با چک، سررسید {fa(months || 3)} ماه بعد از فاکتور.</small>
        </div>
      </div>
      <div className="example num">
        <span>مثال، کالای {fa(SAMPLE)} ریالی:</span>
        {f.allowCash && <b>نقدی {fa(SAMPLE - pctOff(SAMPLE, cashPct))}</b>}
        {f.allowTerm && <b>مدت‌دار {fa(months || 3)} ماهه {fa(SAMPLE - pctOff(SAMPLE, termPct))}</b>}
      </div>
      <button type="button" className="btn sm ghost" style={{ justifySelf: 'start' }} onClick={() => setShowCats(x => !x)} aria-expanded={showCats}>
        {showCats ? '▾' : '◂'} درصد متفاوت برای بعضی دسته‌ها{overrides ? ` (${fa(overrides)} دسته)` : ' (اختیاری)'}
      </button>
      {showCats && (
        <div className="cattable">
          <div className="crow head"><span>دسته کالا</span><span>نقدی</span><span>مدت‌دار</span></div>
          {d.data.categories.map(c => {
            const v = f.cats[c.id] ?? { cash: '', term: '' };
            return (
              <div key={c.id} className={`crow ${v.cash !== '' || v.term !== '' ? 'on' : ''}`}>
                <span><b>{c.name}</b> <small className="muted num">{fa(c.families)} محصول</small></span>
                <span className="pctin"><input className="in num" inputMode="decimal" placeholder={pctFa(cashPct).replace('٪', '')} value={v.cash} disabled={!can || !f.allowCash} onChange={e => setCat(c.id, 'cash', e.target.value)} aria-label={`نقدی ${c.name}`} />٪</span>
                <span className="pctin"><input className="in num" inputMode="decimal" placeholder={pctFa(termPct).replace('٪', '')} value={v.term} disabled={!can || !f.allowTerm} onChange={e => setCat(c.id, 'term', e.target.value)} aria-label={`مدت‌دار ${c.name}`} />٪</span>
              </div>
            );
          })}
          <p className="muted small" style={{ margin: 0 }}>خانه‌ی خالی یعنی همان درصد پیش‌فرض بالا (کم‌رنگ نوشته شده).</p>
        </div>
      )}
      <p className="muted small" style={{ margin: 0 }}>مشتری در مینی‌اپ قیمت نقدی و مدت‌دار هر کالا را با همین درصدها می‌بیند و موقع ثبت سفارش یکی را انتخاب می‌کند. کارشناس فروش می‌تواند در پیش‌فاکتور نوع فروش را عوض کند. قیمت اختصاصی یک کالا، اگر تعریف شده باشد، بر درصدها مقدم است.{!can ? ' تغییر شرایط فروش با مدیر است.' : ''}</p>
    </div>
  );
}
