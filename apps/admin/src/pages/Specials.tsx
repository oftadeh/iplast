import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dayFa, fa, jalaliToIso, pctFa, toEnDigits, useApi } from '../lib';

export interface Special {
  id: string; familyId: string; customerId: string | null; payMode: 'CASH' | 'TERM' | null; kind: 'EXTRA' | 'FIXED'; pct: number;
  minPacks: number | null; startsAt: string | null; endsAt: string | null; note: string | null; isActive: boolean; state: 'on' | 'off' | 'ended' | 'later';
  family: { id: string; name: string; packName: string | null; unitName: string; media: { key: string }[] };
  customer: { id: string; name: string; code: number } | null;
}
interface Cust { id: string; name: string; city: string | null; code: number }
interface Prod { id: string; name: string; category: { name: string }; packName: string | null }

const err = (e: unknown, f = 'ثبت نشد') => (e instanceof ApiError ? e.message : f);
const STATE: Record<Special['state'], [string, string]> = { on: ['فعال', 'ok'], off: ['خاموش', 'gray'], ended: ['تمام‌شده', 'gray'], later: ['شروع نشده', 'ask'] };

/** «۵٪ بیشتر از درصد مشتری · فقط نقدی · از ۱۰۰ کارتن به بالا» */
export function specialLine(s: Pick<Special, 'kind' | 'pct' | 'payMode' | 'minPacks'> & { family?: { packName: string | null; unitName: string } }) {
  return [
    s.kind === 'FIXED' ? `${pctFa(s.pct)} زیر قیمت لیست` : `${pctFa(s.pct)} بیشتر از درصد مشتری`,
    s.payMode === 'CASH' ? 'فقط نقدی' : s.payMode === 'TERM' ? 'فقط مدت‌دار (روال)' : 'نقدی و مدت‌دار',
    s.minPacks ? `از ${fa(s.minPacks)} ${s.family?.packName ?? s.family?.unitName ?? 'کارتن'} به بالا` : '',
  ].filter(Boolean).join(' · ');
}

/** «تخفیف‌های ویژه»: every special discount of every product, to see and manage them in one place. */
export function SpecialsPage() {
  const { me } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const [tab, setTab] = useState<'on' | 'all'>('on');
  const [adding, setAdding] = useState(false);
  const list = useApi<Special[]>('/admin/specials');
  const rows = (list.data ?? []).filter(s => tab === 'all' || s.state === 'on' || s.state === 'later');
  return (
    <>
      <div className="head"><h1>تخفیف‌های ویژه</h1>{can && !adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ تخفیف ویژه‌ی جدید</button>}</div>
      <p className="note" style={{ margin: 0 }}>
        تخفیف ویژه روی یک کالا، علاوه بر درصد نقدی و مدت‌دار هر مشتری اعمال می‌شود. مثلاً مشتری‌ای که روال ۳۰٪ و نقدی ۳۵٪ دارد، با «۵٪ بیشتر» روی این کالا
        روال ۳۵٪ و نقدی ۴۰٪ می‌گیرد. می‌توانید آن را فقط برای یک مشتری، فقط نقدی یا فقط روال، یا فقط از تعداد مشخصی کارتن به بالا (مثلاً ۱۰۰ کارتن) بگذارید.
        مشتری در مینی‌اپ برچسب «تخفیف ویژه» را روی همان کالا می‌بیند.
      </p>
      {adding && <SpecialForm onDone={() => { setAdding(false); list.reload(); }} onCancel={() => setAdding(false)} />}
      <div className="chips">
        <button type="button" className="chip" aria-pressed={tab === 'on'} onClick={() => setTab('on')}>فعال</button>
        <button type="button" className="chip" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>همه</button>
      </div>
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : !rows.length ? <div className="empty">{tab === 'on' ? 'تخفیف ویژه‌ی فعالی نیست.' : 'هنوز تخفیف ویژه‌ای تعریف نشده است.'}</div> : (
        <div className="stack">{rows.map(s => <SpecialRow key={s.id} s={s} can={can} showProduct onChanged={list.reload} />)}</div>
      )}
    </>
  );
}

/** The special discounts of one product, in its editor. */
export function ProductSpecials({ familyId }: { familyId: string }) {
  const { me } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const [adding, setAdding] = useState(false);
  const list = useApi<Special[]>(`/admin/specials?family=${familyId}`);
  return (
    <>
      <div className="between"><h2>⭐ تخفیف ویژه</h2>{can && !adding && <button type="button" className="btn sm" onClick={() => setAdding(true)}>+ افزودن</button>}</div>
      {adding && <SpecialForm familyId={familyId} onDone={() => { setAdding(false); list.reload(); }} onCancel={() => setAdding(false)} />}
      {list.data && !list.data.length && !adding && <div className="empty small">این کالا تخفیف ویژه ندارد.{can ? ' با «افزودن» برای همه یا یک مشتری خاص بگذارید.' : ''}</div>}
      {list.data?.map(s => <SpecialRow key={s.id} s={s} can={can} onChanged={list.reload} />)}
    </>
  );
}

function SpecialRow({ s, can, showProduct, onChanged }: { s: Special; can: boolean; showProduct?: boolean; onChanged: () => void }) {
  const { toast, open } = useAdmin();
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); try { await f(); toast(ok); onChanged(); } catch (e) { toast(err(e)); } finally { setBusy(false); } };
  if (edit) return <SpecialForm initial={s} familyId={s.familyId} onDone={() => { setEdit(false); onChanged(); }} onCancel={() => setEdit(false)} />;
  const [stTxt, stCls] = STATE[s.state];
  return (
    <div className={`card vrow ${s.state === 'on' || s.state === 'later' ? '' : 'off'}`}>
      <div className="between">
        <b>{showProduct ? <button type="button" className="link" onClick={() => open('catalog/products', s.familyId)}>{s.family.name}</button> : '⭐ تخفیف ویژه'}</b>
        <span className={`st ${stCls}`}>{stTxt}</span>
      </div>
      <span className="small num">{specialLine(s)}</span>
      <span className="muted small num">
        {s.customer ? `فقط برای ${s.customer.name} (کد ${fa(s.customer.code)})` : 'همه‌ی مشتریان'}
        {s.startsAt ? ` · از ${dayFa(s.startsAt)}` : ''}{s.endsAt ? ` · تا ${dayFa(s.endsAt)}` : ''}{s.note ? ` · «${s.note}»` : ''}
      </span>
      {can && (
        <div className="row">
          <button type="button" className="btn sm" disabled={busy} onClick={() => setEdit(true)}>ویرایش</button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => run(() => api(`/admin/specials/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }), s.isActive ? 'تخفیف خاموش شد' : 'تخفیف روشن شد')}>{s.isActive ? 'خاموش کردن' : 'روشن کردن'}</button>
          <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => { if (confirm('این تخفیف ویژه حذف شود؟')) void run(() => api(`/admin/specials/${s.id}`, { method: 'DELETE' }), 'حذف شد'); }}>حذف</button>
        </div>
      )}
    </div>
  );
}

/** Jalali «۱۴۰۵/۰۹/۳۰» → ISO date; empty → null. */
function jalaliInput(v: string, endOfDay: boolean) {
  const m = toEnDigits(v.trim()).match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (!v.trim()) return null;
  if (!m) throw new Error('تاریخ را به شکل ۱۴۰۵/۰۹/۳۰ بنویسید');
  return `${jalaliToIso(+m[1], +m[2], +m[3])}T${endOfDay ? '23:59:59' : '00:00:00'}+03:30`;
}
const toJalali = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fa-IR-u-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[^\d/]/g, '') : '');

function SpecialForm({ familyId, initial, onDone, onCancel }: { familyId?: string; initial?: Special; onDone: () => void; onCancel: () => void }) {
  const { toast } = useAdmin();
  const customers = useApi<Cust[]>('/admin/customers');
  const [f, setF] = useState({
    familyId: familyId ?? '', familyName: initial?.family.name ?? '',
    kind: initial?.kind ?? 'EXTRA' as 'EXTRA' | 'FIXED', pct: initial ? String(initial.pct) : '', payMode: initial?.payMode ?? '' as '' | 'CASH' | 'TERM',
    who: initial?.customerId ? 'one' : 'all', customerId: initial?.customerId ?? '', minPacks: initial?.minPacks ? String(initial.minPacks) : '',
    startsAt: toJalali(initial?.startsAt ?? null), endsAt: toJalali(initial?.endsAt ?? null), note: initial?.note ?? '',
  });
  const [cq, setCq] = useState('');
  const [pq, setPq] = useState('');
  const [prods, setProds] = useState<Prod[]>([]);
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  useEffect(() => {
    if (familyId || pq.trim().length < 2) { setProds([]); return; }
    const t = setTimeout(() => api<Prod[]>(`/admin/products?q=${encodeURIComponent(pq.trim())}`).then(r => setProds(r.slice(0, 8)), () => setProds([])), 250);
    return () => clearTimeout(t);
  }, [pq, familyId]);
  const custs = (customers.data ?? []).filter(c => !cq.trim() || c.name.includes(cq.trim()) || (c.city ?? '').includes(cq.trim()) || String(c.code) === toEnDigits(cq.trim())).slice(0, 8);
  const chosen = customers.data?.find(c => c.id === f.customerId);
  const pctN = Number(toEnDigits(f.pct).replace('٫', '.'));

  const save = async () => {
    setE('');
    let startsAt: string | null, endsAt: string | null;
    try { startsAt = jalaliInput(f.startsAt, false); endsAt = jalaliInput(f.endsAt, true); } catch (x) { setE((x as Error).message); return; }
    setBusy(true);
    try {
      const body = {
        familyId: f.familyId, kind: f.kind, pct: toEnDigits(f.pct), payMode: f.payMode || null, customerId: f.who === 'one' ? f.customerId : null,
        minPacks: toEnDigits(f.minPacks) || null, startsAt, endsAt, note: f.note,
      };
      if (initial) await api(`/admin/specials/${initial.id}`, { method: 'PATCH', body }); else await api('/admin/specials', { method: 'POST', body });
      toast(initial ? 'تخفیف ویژه به‌روز شد' : 'تخفیف ویژه ثبت شد؛ از همین حالا اعمال می‌شود');
      onDone();
    } catch (x) { setE(err(x)); } finally { setBusy(false); }
  };

  return (
    <div className="card pad stack">
      <h2>{initial ? 'ویرایش تخفیف ویژه' : 'تخفیف ویژه‌ی جدید'}</h2>
      {!familyId && (
        <label className="f"><span>کالا</span>
          {f.familyId ? (
            <div className="row"><b>{f.familyName}</b><button type="button" className="btn sm ghost" onClick={() => setF({ ...f, familyId: '', familyName: '' })}>تغییر</button></div>
          ) : (
            <div className="searchpick">
              <input className="in" placeholder="نام کالا را بنویسید…" value={pq} onChange={ev => setPq(ev.target.value)} />
              {prods.map(p => <button key={p.id} type="button" className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setF({ ...f, familyId: p.id, familyName: p.name }); setPq(''); }}>{p.name} <span className="muted small">· {p.category.name}</span></button>)}
            </div>
          )}
        </label>
      )}
      <div className="f"><span>نوع تخفیف</span>
        <div className="seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={f.kind === 'EXTRA'} onClick={() => setF({ ...f, kind: 'EXTRA' })}>درصد اضافه روی درصد مشتری</button>
          <button type="button" role="radio" aria-checked={f.kind === 'FIXED'} onClick={() => setF({ ...f, kind: 'FIXED' })}>درصد ثابت برای این کالا</button>
        </div>
      </div>
      <label className="f"><span>{f.kind === 'EXTRA' ? 'چند درصد بیشتر؟' : 'چند درصد زیر قیمت لیست؟'}</span>
        <input className="in num" dir="ltr" inputMode="decimal" value={f.pct} onChange={ev => setF({ ...f, pct: ev.target.value })} placeholder={f.kind === 'EXTRA' ? '5' : '40'} />
        <small className="muted num">{f.kind === 'EXTRA'
          ? (pctN > 0 ? `مثلاً مشتری نقدی ۳۵٪ ← ${pctFa(Math.min(100, 35 + pctN))} و روال ۳۰٪ ← ${pctFa(Math.min(100, 30 + pctN))}` : 'به درصد نقدی یا مدت‌دار خود مشتری اضافه می‌شود.')
          : 'اگر درصد خود مشتری از این بیشتر باشد، همان درصد مشتری می‌ماند.'}</small>
      </label>
      <div className="f"><span>برای کدام نوع خرید؟</span>
        <div className="seg" role="radiogroup">
          {([['', 'هر دو'], ['CASH', 'فقط نقدی'], ['TERM', 'فقط مدت‌دار (روال)']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.payMode === k} onClick={() => setF({ ...f, payMode: k })}>{l}</button>)}
        </div>
      </div>
      <div className="f"><span>برای چه کسی؟</span>
        <div className="seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={f.who === 'all'} onClick={() => setF({ ...f, who: 'all' })}>همه‌ی مشتریان</button>
          <button type="button" role="radio" aria-checked={f.who === 'one'} onClick={() => setF({ ...f, who: 'one' })}>یک مشتری خاص</button>
        </div>
      </div>
      {f.who === 'one' && (
        chosen ? <div className="row"><b>{chosen.name}</b><span className="muted small num">کد {fa(chosen.code)}{chosen.city ? ` · ${chosen.city}` : ''}</span><button type="button" className="btn sm ghost" onClick={() => setF({ ...f, customerId: '' })}>تغییر</button></div> : (
          <div className="searchpick">
            <input className="in" placeholder="نام، شهر یا کد مشتری" value={cq} onChange={ev => setCq(ev.target.value)} />
            {custs.map(c => <button key={c.id} type="button" className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setF({ ...f, customerId: c.id }); setCq(''); }}>{c.name} <span className="muted small num">· کد {fa(c.code)}{c.city ? ` · ${c.city}` : ''}</span></button>)}
          </div>
        )
      )}
      <label className="f"><span>شرط حداقل تعداد (کارتن / کیسه) — اختیاری</span>
        <input className="in num" dir="ltr" inputMode="numeric" value={f.minPacks} onChange={ev => setF({ ...f, minPacks: ev.target.value })} placeholder="مثلاً 100" />
        <small className="muted">جمع کارتن‌های همه‌ی سایزهای این کالا در یک سفارش حساب می‌شود. خالی = بدون شرط.</small>
      </label>
      <div className="row2">
        <label className="f"><span>از تاریخ (اختیاری)</span><input className="in num" dir="ltr" value={f.startsAt} onChange={ev => setF({ ...f, startsAt: ev.target.value })} placeholder="1405/09/01" /></label>
        <label className="f"><span>تا تاریخ (اختیاری)</span><input className="in num" dir="ltr" value={f.endsAt} onChange={ev => setF({ ...f, endsAt: ev.target.value })} placeholder="1405/09/30" /></label>
      </div>
      <label className="f"><span>توضیح برای مشتری (اختیاری)</span><input className="in" value={f.note} onChange={ev => setF({ ...f, note: ev.target.value })} placeholder="مثلاً جشنواره‌ی پاییز" maxLength={120} /></label>
      {e && <div className="err">{e}</div>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !f.familyId || !(pctN > 0) || (f.who === 'one' && !f.customerId)} onClick={save}>{busy ? 'در حال ثبت…' : initial ? 'ذخیره' : 'ثبت تخفیف ویژه'}</button>
        <button type="button" className="btn" onClick={onCancel}>انصراف</button>
      </div>
    </div>
  );
}
