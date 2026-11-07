import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dateFa, fa, personName, useApi } from '../lib';

interface Row { id: string; number: number; status: string; statusFa: string; createdAt: string; itemCount: number; customer: { id: string; name: string; support: { firstName: string | null; lastName: string | null } | null } }
interface List { rows: Row[] }
interface Detail { id: string; note: string | null; customer: { name: string; city: string | null; address?: string | null }; items: { id: string; title: string; quantity: number; packs: number | null }[]; events: { id: string; status: string; comment: string | null; createdAt: string }[] }

const TABS = [
  { id: 'CONFIRMED,PREPARING', title: 'آماده‌سازی' },
  { id: 'SHIPPED', title: 'ارسال‌شده' },
  { id: 'DELIVERED', title: 'تحویل‌شده' },
];

/** After the manager's final approval: the warehouse prepares, ships (with the waybill number) and marks delivery. */
export function WarehousePage() {
  const [tab, setTab] = useState(TABS[0].id);
  const list = useApi<List>(`/admin/orders?status=${tab}`);
  const rows = [...(list.data?.rows ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <>
      <div className="head"><h1>انبار و ارسال</h1></div>
      <div className="chips">{TABS.map(t => <button key={t.id} type="button" className="chip" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.title}{tab === t.id && list.data ? <span className="n num">{fa(rows.length)}</span> : null}</button>)}</div>
      {tab === TABS[0].id && <p className="muted small" style={{ margin: 0 }}>سفارش‌هایی که مدیر تأیید نهایی کرده است. با «ارسال شد» به مشتری و کارشناسش خبر داده می‌شود.</p>}
      <section className="stack">
        {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div>
          : !rows.length ? <div className="empty">موردی نیست.</div>
          : rows.map(r => <ShipCard key={r.id} r={r} onDone={list.reload} />)}
      </section>
    </>
  );
}

function ShipCard({ r, onDone }: { r: Row; onDone: () => void }) {
  const { toast } = useAdmin();
  const [open, setOpen] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [waybill, setWaybill] = useState('');
  const [busy, setBusy] = useState(false);
  const d = useApi<Detail>(open || shipping ? `/admin/orders/${r.id}` : null);
  const act = async (action: 'prep' | 'ship' | 'delivered', comment?: string) => {
    setBusy(true);
    try {
      await api(`/admin/orders/${r.id}/decide`, { method: 'POST', body: { action, comment } });
      toast(action === 'prep' ? `سفارش #${fa(r.number)} در حال آماده‌سازی` : action === 'ship' ? `سفارش #${fa(r.number)} ارسال شد؛ به مشتری خبر داده شد` : `سفارش #${fa(r.number)} تحویل شد`);
      onDone();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  const agent = r.customer.support ? personName({ ...r.customer.support, username: null }) : null;
  return (
    <article className="card ocard">
      <button type="button" className="ohead" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="num"><b>#{fa(r.number)}</b> · {r.customer.name}</span>
        <span className={`st ${r.status === 'DELIVERED' ? 'ok' : r.status === 'SHIPPED' ? '' : 'new'}`}>{r.status === 'CONFIRMED' ? 'منتظر آماده‌سازی' : r.statusFa}</span>
        <span className="muted small num">{fa(r.itemCount)} قلم · {dateFa(r.createdAt)}{agent ? ` · کارشناس: ${agent}` : ''}</span>
      </button>
      {(open || shipping) && (
        <div className="obody">
          {!d.data ? <div className="muted small">در حال بارگذاری…</div> : (
            <>
              <div className="items">{d.data.items.map(i => <div key={i.id}><span>{i.title}</span><b className="num">{i.packs ? `${fa(i.packs)} بسته · ` : ''}{fa(i.quantity)} عدد</b></div>)}</div>
              {d.data.customer.city && <p className="small" style={{ margin: 0 }}>شهر: {d.data.customer.city}{d.data.customer.address ? ` · ${d.data.customer.address}` : ''}</p>}
              {d.data.note && <p className="note" style={{ margin: 0 }}>{d.data.note}</p>}
              {d.data.events.filter(e => e.status === 'SHIPPED' && e.comment).map(e => <p key={e.id} className="small" style={{ margin: 0 }}>اطلاعات ارسال: {e.comment}</p>)}
            </>
          )}
        </div>
      )}
      {shipping ? (
        <div className="obody">
          <label className="f"><span>شماره بارنامه / نام باربری (برای مشتری فرستاده می‌شود)</span><input className="in" autoFocus value={waybill} onChange={e => setWaybill(e.target.value)} maxLength={200} placeholder="مثلاً باربری ایران‌پیما، بارنامه ۱۲۳۴۵" /></label>
          <div className="decide" style={{ padding: 0 }}>
            <button type="button" className="btn ok-fill" disabled={busy} onClick={() => act('ship', waybill.trim() || undefined)}>🚚 ثبت ارسال</button>
            <button type="button" className="btn" onClick={() => setShipping(false)}>انصراف</button>
          </div>
        </div>
      ) : r.status === 'CONFIRMED' || r.status === 'PREPARING' ? (
        <div className="decide">
          {r.status === 'CONFIRMED' && <button type="button" className="btn" disabled={busy} onClick={() => act('prep')}>📦 شروع آماده‌سازی</button>}
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => setShipping(true)}>🚚 ارسال شد</button>
        </div>
      ) : r.status === 'SHIPPED' ? (
        <div className="decide"><button type="button" className="btn ok-fill" disabled={busy} onClick={() => act('delivered')}>✓ تحویل مشتری شد</button></div>
      ) : null}
    </article>
  );
}
