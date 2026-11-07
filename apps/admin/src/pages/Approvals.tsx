import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, STATUS_CLASS, api, dateFa, fa, personName, rial, toEnDigits, useApi } from '../lib';

interface Row { id: string; number: number; status: string; statusFa: string; createdAt: string; total: string; itemCount: number; inquiryCount: number; channel: string; customer: { id: string; name: string }; placedBy: { firstName: string | null; lastName: string | null; username: string | null } }
interface List { rows: Row[]; counts: Record<string, number> }
interface Detail {
  id: string; status: string; note: string | null; total: string; split: { cash: string; cheque: string };
  termsSnapshot: { cashPercent?: number } | null; customer: { name: string; city: string | null };
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null }[];
  events: { id: string; status: string; comment: string | null; createdAt: string }[];
}
interface Customer { id: string; name: string; city: string | null; isApproved: boolean; createdAt: string; terms: { cashPercent: number } | null; _count: { members: number; orders: number } }

const TABS = [
  { id: 'pending', title: 'در انتظار تأیید' },
  { id: 'CONFIRMED', title: 'تأییدشده' },
  { id: 'REJECTED', title: 'ردشده' },
] as const;

/** One place to decide: new orders (approve / reject) and new customer accounts. */
export function ApprovalsPage() {
  const [tab, setTab] = useState<string>('pending');
  const submitted = useApi<List>('/admin/orders?status=SUBMITTED');
  const review = useApi<List>('/admin/orders?status=SALES_REVIEW');
  const other = useApi<List>(tab === 'pending' ? null : `/admin/orders?status=${tab}`);
  const customers = useApi<Customer[]>('/admin/customers');
  const reload = () => { submitted.reload(); review.reload(); other.reload(); };

  const pending = [...(submitted.data?.rows ?? []), ...(review.data?.rows ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rows = tab === 'pending' ? pending : other.data?.rows ?? [];
  const loading = tab === 'pending' ? !submitted.data || !review.data : !other.data;
  const error = submitted.error || review.error || other.error;
  const newCustomers = (customers.data ?? []).filter(c => !c.isApproved);
  const counts = submitted.data?.counts ?? {};

  return (
    <>
      <div className="head"><h1>تأییدها</h1></div>
      <div className="chips">
        {TABS.map(t => {
          const n = t.id === 'pending' ? pending.length : counts[t.id] ?? 0;
          return <button key={t.id} type="button" className="chip" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.title}<span className="n num">{fa(n)}</span></button>;
        })}
      </div>

      {tab === 'pending' && newCustomers.length > 0 && (
        <section className="stack">
          <h2>مشتریان جدید <span className="muted small num">({fa(newCustomers.length)})</span></h2>
          {newCustomers.map(c => <NewCustomer key={c.id} c={c} onDone={customers.reload} />)}
        </section>
      )}

      <section className="stack">
        {tab === 'pending' && <h2>سفارش‌ها</h2>}
        {error ? <div className="err">{error}</div> : loading ? <div className="card pad muted">در حال بارگذاری…</div>
          : !rows.length ? <div className="empty">{tab === 'pending' ? 'سفارشی منتظر تأیید نیست.' : 'موردی نیست.'}</div>
          : rows.map(r => <OrderCard key={r.id} r={r} onChanged={reload} open={tab === 'pending' && rows.length === 1} />)}
      </section>
    </>
  );
}

function OrderCard({ r, onChanged, open: initiallyOpen }: { r: Row; onChanged: () => void; open: boolean }) {
  const { toast } = useAdmin();
  const [open, setOpen] = useState(initiallyOpen);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const d = useApi<Detail>(open ? `/admin/orders/${r.id}` : null);
  const pending = r.status === 'SUBMITTED' || r.status === 'SALES_REVIEW';

  const decide = async (status: 'CONFIRMED' | 'REJECTED' | 'SALES_REVIEW', comment?: string) => {
    setBusy(true);
    try {
      await api(`/admin/orders/${r.id}/status`, { method: 'PATCH', body: { status, comment } });
      toast(status === 'CONFIRMED' ? `سفارش #${fa(r.number)} تأیید شد` : status === 'REJECTED' ? `سفارش #${fa(r.number)} رد شد` : 'در بررسی');
      onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  return (
    <article className="card ocard">
      <button type="button" className="ohead" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="num"><b>#{fa(r.number)}</b> · {r.customer.name}</span>
        <span className={`st ${STATUS_CLASS(r.status)}`}>{r.statusFa}</span>
        <span className="muted small num">{personName(r.placedBy)} · {r.channel === 'bot' ? 'ربات' : 'مینی‌اپ'} · {dateFa(r.createdAt)}</span>
        <span className="small num"><b>{fa(r.itemCount)} قلم</b>{r.inquiryCount ? <span className="st ask" style={{ marginInlineStart: 6 }}>{fa(r.inquiryCount)} استعلامی</span> : null} · {BigInt(r.total) ? rial(r.total) : '—'}</span>
      </button>
      {open && (
        <div className="obody">
          {!d.data ? <div className="muted small">در حال بارگذاری…</div> : (
            <>
              <div className="items">
                {d.data.items.map(i => (
                  <div key={i.id}><span>{i.title}<br /><span className="muted small num">{i.packs ? `${fa(i.packs)} بسته · ` : ''}{fa(i.quantity)} عدد × {rial(i.unitPrice)}</span></span>
                    <b className="num">{i.unitPrice !== null ? fa(BigInt(i.unitPrice) * BigInt(i.quantity)) : <span className="st ask">استعلامی</span>}</b></div>
                ))}
              </div>
              <div className="tot"><span>جمع تقریبی</span><span className="num">{rial(d.data.total)}</span></div>
              <p className="small muted num" style={{ margin: 0 }}>نقد {fa(d.data.termsSnapshot?.cashPercent ?? 100)}٪: {rial(d.data.split.cash)} · چک: {rial(d.data.split.cheque)}</p>
              {d.data.note && <p className="note" style={{ margin: 0 }}>{d.data.note}</p>}
              {!pending && d.data.events.at(-1)?.comment && <p className="small" style={{ margin: 0 }}>توضیح: {d.data.events.at(-1)!.comment}</p>}
            </>
          )}
        </div>
      )}
      {pending && (rejecting ? (
        <div className="obody">
          <textarea className="in" autoFocus placeholder="دلیل رد (برای مشتری فرستاده می‌شود؛ اختیاری)" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
          <div className="decide">
            <button type="button" className="btn danger-fill" disabled={busy} onClick={() => decide('REJECTED', reason.trim() || undefined)}>رد سفارش</button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>انصراف</button>
          </div>
        </div>
      ) : (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => decide('CONFIRMED')}>✓ تأیید</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>✕ رد</button>
          {r.status === 'SUBMITTED' && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => decide('SALES_REVIEW')}>در بررسی</button>}
        </div>
      ))}
    </article>
  );
}

function NewCustomer({ c, onDone }: { c: Customer; onDone: () => void }) {
  const { toast, me } = useAdmin();
  const [cash, setCash] = useState(String(c.terms?.cashPercent ?? 100));
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const pct = Number(toEnDigits(cash));
      if (me.staffRole === 'ADMIN' && pct !== (c.terms?.cashPercent ?? 100)) await api(`/admin/customers/${c.id}/terms`, { method: 'PUT', body: { cashPercent: pct, chequeDueDays: [] } });
      await api(`/admin/customers/${c.id}`, { method: 'PATCH', body: { isApproved: true } });
      toast(`${c.name} تأیید شد`); onDone();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  return (
    <article className="card pad stack">
      <div className="between"><b>{c.name}</b><span className="muted small num">{dateFa(c.createdAt)}</span></div>
      <span className="muted small num">{c.city ?? 'شهر نامشخص'} · {fa(c._count.members)} کاربر · {fa(c._count.orders)} سفارش</span>
      <div className="decide">
        {me.staffRole === 'ADMIN' && <label className="row small">نقد٪ <input className="in num" style={{ width: 70 }} inputMode="numeric" value={cash} onChange={e => setCash(e.target.value)} /></label>}
        <button type="button" className="btn ok-fill" disabled={busy} onClick={approve}>✓ تأیید مشتری</button>
      </div>
    </article>
  );
}
