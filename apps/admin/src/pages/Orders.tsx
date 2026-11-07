import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, STATUS_CLASS, api, dateFa, fa, personName, rial, useApi } from '../lib';

interface Row { id: string; number: number; status: string; statusFa: string; createdAt: string; total: string; itemCount: number; inquiryCount: number; channel: string; customer: { id: string; name: string }; placedBy: { firstName: string | null; lastName: string | null; username: string | null } }
interface List { rows: Row[]; counts: Record<string, number>; statuses: { id: string; fa: string }[] }
interface Detail {
  id: string; number: number; status: string; statusFa: string; createdAt: string; note: string | null; channel: string; total: string;
  split: { cash: string; cheque: string }; termsSnapshot: { cashPercent?: number; chequeDueDays?: number[] } | null;
  customer: { id: string; name: string; city: string | null };
  placedBy: { firstName: string | null; lastName: string | null; username: string | null };
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null }[];
  events: { id: string; status: string; comment: string | null; createdAt: string }[];
}

export function OrdersPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useApi<List>(`/admin/orders?status=${status}&q=${encodeURIComponent(query)}`);
  const all = list.data ? Object.values(list.data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <div className="head"><h1>سفارش‌ها</h1><input className="in search" placeholder="جست‌وجوی نام مشتری یا شماره سفارش" value={q} onChange={e => setQ(e.target.value)} /></div>
      {list.data && (
        <div className="chips">
          <button type="button" className="chip" aria-pressed={!status} onClick={() => setStatus('')}>همه<span className="n num">{fa(all)}</span></button>
          {list.data.statuses.filter(s => list.data!.counts[s.id]).map(s => (
            <button key={s.id} type="button" className="chip" aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>{s.fa}<span className="n num">{fa(list.data!.counts[s.id])}</span></button>
          ))}
        </div>
      )}
      <div className="grid2">
        <div className="card tablewrap">
          {list.error ? <div className="pad err">{list.error}</div> : !list.data ? <div className="pad muted">در حال بارگذاری…</div> : !list.data.rows.length ? <div className="empty" style={{ border: 0 }}>سفارشی پیدا نشد.</div> : (
            <table>
              <thead><tr><th>شماره</th><th>مشتری</th><th>ثبت‌کننده</th><th>اقلام</th><th>جمع</th><th>وضعیت</th><th>زمان</th></tr></thead>
              <tbody>
                {list.data.rows.map(r => (
                  <tr key={r.id} className="click" aria-selected={r.id === focus} onClick={() => onFocus(r.id)}>
                    <td className="num"><b>#{fa(r.number)}</b></td>
                    <td>{r.customer.name}</td>
                    <td className="small">{personName(r.placedBy)}</td>
                    <td className="num small">{fa(r.itemCount)}{r.inquiryCount ? <span className="st ask" style={{ marginInlineStart: 6 }}>{fa(r.inquiryCount)} استعلامی</span> : null}</td>
                    <td className="num small">{BigInt(r.total) ? fa(r.total) : '—'}</td>
                    <td><span className={`st ${STATUS_CLASS(r.status)}`}>{r.statusFa}</span></td>
                    <td className="small muted num nowrap">{dateFa(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {focus ? <OrderDetail key={focus} id={focus} statuses={list.data?.statuses ?? []} onChanged={list.reload} /> : <div className="empty">یک سفارش را از فهرست انتخاب کنید.</div>}
      </div>
    </>
  );
}

function OrderDetail({ id, statuses, onChanged }: { id: string; statuses: { id: string; fa: string }[]; onChanged: () => void }) {
  const { toast, open } = useAdmin();
  const o = useApi<Detail>(`/admin/orders/${id}`);
  const [next, setNext] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (o.error) return <div className="card pad err">{o.error}</div>;
  if (!o.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const d = o.data;
  const cashPct = d.termsSnapshot?.cashPercent ?? 100;

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api<Detail>(`/admin/orders/${id}/status`, { method: 'PATCH', body: { status: next, comment: comment.trim() || undefined } });
      o.setData(r); setNext(''); setComment(''); onChanged(); toast('وضعیت ثبت شد و به مشتری خبر داده شد');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="card pad stack">
        <div className="between"><h2 className="num">سفارش #{fa(d.number)}</h2><span className={`st ${STATUS_CLASS(d.status)}`}>{d.statusFa}</span></div>
        <dl className="kv">
          <dt>مشتری</dt><dd><button type="button" className="btn sm" onClick={() => open('customers', d.customer.id)}>{d.customer.name}</button></dd>
          <dt>ثبت‌کننده</dt><dd>{personName(d.placedBy)}{d.placedBy.username ? <> · <bdi dir="ltr">@{d.placedBy.username}</bdi></> : null}</dd>
          <dt>زمان</dt><dd className="num">{dateFa(d.createdAt)}</dd>
          <dt>کانال</dt><dd>{d.channel === 'miniapp' ? 'مینی‌اپ' : d.channel === 'bot' ? 'ربات' : d.channel}</dd>
          {d.note && <><dt>توضیح مشتری</dt><dd>{d.note}</dd></>}
        </dl>
      </div>
      <div className="card pad">
        <div className="items">
          {d.items.map(i => (
            <div key={i.id}><span>{i.title}<br /><span className="muted small num">{fa(i.quantity)} عدد{i.packs ? ` (${fa(i.packs)} بسته)` : ''} × {rial(i.unitPrice)}</span></span>
              <b className="num">{i.unitPrice !== null ? fa(BigInt(i.unitPrice) * BigInt(i.quantity)) : <span className="st ask">استعلامی</span>}</b></div>
          ))}
        </div>
        <div className="tot"><span>جمع تقریبی</span><span className="num">{rial(d.total)}</span></div>
        <p className="small muted num" style={{ margin: '8px 0 0' }}>نقد {fa(cashPct)}٪: {rial(d.split.cash)} · چک {fa(100 - cashPct)}٪: {rial(d.split.cheque)}{d.termsSnapshot?.chequeDueDays?.length ? ` · سررسید ${d.termsSnapshot.chequeDueDays.map(x => fa(x)).join('، ')} روزه` : ''}</p>
      </div>
      <div className="card pad stack">
        <h2>تغییر وضعیت</h2>
        <select className="in" value={next} onChange={e => setNext(e.target.value)}>
          <option value="">انتخاب وضعیت جدید…</option>
          {statuses.filter(s => s.id !== d.status).map(s => <option key={s.id} value={s.id}>{s.fa}</option>)}
        </select>
        <textarea className="in" placeholder="توضیح برای مشتری (اختیاری؛ همراه اعلان در ربات فرستاده می‌شود)" value={comment} onChange={e => setComment(e.target.value)} maxLength={1000} />
        {err && <div className="err">{err}</div>}
        <button type="button" className="btn primary" disabled={!next || busy} onClick={save}>{busy ? 'در حال ثبت…' : 'ثبت و اطلاع به مشتری'}</button>
      </div>
      <div className="card pad stack">
        <h2>تاریخچه</h2>
        <ol className="tl">{d.events.map(e => <li key={e.id}><div><b>{statuses.find(s => s.id === e.status)?.fa ?? e.status}</b> <span className="muted small num">{dateFa(e.createdAt)}</span>{e.comment && <div className="small">{e.comment}</div>}</div></li>)}</ol>
      </div>
    </div>
  );
}
