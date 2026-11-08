import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, STATUS_CLASS, api, dateFa, fa, personName, rial, toEnDigits, useApi, useBlobUrl } from '../lib';

interface Row {
  id: string; number: number; status: string; statusFa: string; createdAt: string; total: string; itemCount: number; inquiryCount: number; channel: string;
  customer: { id: string; name: string; support: { firstName: string | null; lastName: string | null } | null };
  placedBy: { firstName: string | null; lastName: string | null; username: string | null };
}
interface List { rows: Row[]; counts: Record<string, number> }
interface Detail {
  id: string; status: string; note: string | null; total: string; split: { cash: string; cheque: string };
  termsSnapshot: { cashPercent?: number } | null; customer: { name: string; city: string | null };
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null }[];
  events: { id: string; status: string; comment: string | null; createdAt: string }[];
}
interface Customer { id: string; name: string; city: string | null; isApproved: boolean; createdAt: string; terms: { cashPercent: number } | null; _count: { members: number; orders: number } }
interface Reported {
  id: string; amount: string; method: string; methodFa: string; chequeNumber: string | null; bank: string | null; dueDate: string | null;
  receivedAt: string; note: string | null; hasReceipt: boolean; customer: { id: string; name: string }; invoice: { number: number } | null;
}

const AGENT = 'SUBMITTED,SALES_REVIEW,NEEDS_FIX';
const SHORT: Record<string, string> = { SUBMITTED: 'منتظر کارشناس', SALES_REVIEW: 'در بررسی کارشناس', SALES_APPROVED: 'منتظر تأیید نهایی', CONFIRMED: 'تأیید نهایی شد' };
const FINAL = 'SALES_APPROVED';

/**
 * One place to decide. Step 1: the customer's sales agent checks the proforma. Step 2: a manager gives the final OK.
 * Also: receipts customers sent (cheque / bank transfer photos) and new customer accounts.
 */
export function ApprovalsPage({ view }: { view: 'agent' | 'final' | 'hist' | 'pay' | 'customers' }) {
  const { me } = useAdmin();
  const isAdmin = me.staffRole === 'ADMIN';
  const agent = useApi<List>(view === 'agent' ? `/admin/orders?status=${AGENT}` : null);
  const final = useApi<List>(view === 'final' ? `/admin/orders?status=${FINAL}` : null);
  const paid = useApi<Reported[]>(view === 'pay' ? '/admin/accounts/reported' : null);
  const customers = useApi<Customer[]>(view === 'customers' ? '/admin/customers' : null);
  const [histTab, setHist] = useState<'CONFIRMED' | 'REJECTED'>('CONFIRMED');
  const hist = useApi<List>(view === 'hist' ? `/admin/orders?status=${histTab}` : null);

  const newCustomers = (customers.data ?? []).filter(c => !c.isApproved);
  const tab = view;
  void isAdmin;
  const reload = () => { agent.reload(); final.reload(); hist.reload(); };

  return (
    <>
      {tab === 'agent' && (
        <>
          <p className="muted small" style={{ margin: 0 }}>مرحله‌ی ۱: پیش‌فاکتورهایی که ایجنت هوش مصنوعی یا خود مشتری ثبت کرده. کارشناس فروشِ هر مشتری بررسی و تأیید می‌کند؛ بعد برای مدیر پیامک و پیام تلگرام می‌رود.</p>
          <Orders list={agent} empty="پیش‌فاکتوری منتظر کارشناس نیست." onChanged={reload} />
        </>
      )}
      {tab === 'final' && (
        <>
          <p className="muted small" style={{ margin: 0 }}>مرحله‌ی ۲: پیش‌فاکتورهایی که کارشناس فروش تأیید کرده؛ تأیید نهایی با مدیر است.</p>
          <Orders list={final} empty="پیش‌فاکتوری منتظر تأیید نهایی نیست." onChanged={reload} />
        </>
      )}
      {tab === 'pay' && (
        <section className="stack">
          <p className="muted small" style={{ margin: 0 }}>عکس چک و فیش واریزی که مشتری‌ها از مینی‌اپ فرستاده‌اند. بعد از تأیید، واریزی از مانده کم می‌شود و چک تا وصول در «چک‌های در جریان» می‌ماند.</p>
          {paid.error ? <div className="err">{paid.error}</div> : !paid.data ? <div className="card pad muted">در حال بارگذاری…</div>
            : !paid.data.length ? <div className="empty">رسیدی منتظر بررسی نیست.</div>
            : paid.data.map(p => <PaymentCard key={p.id} p={p} onDone={paid.reload} />)}
        </section>
      )}
      {tab === 'customers' && (
        <section className="stack">
          <p className="muted small" style={{ margin: 0 }}>حساب‌هایی که با اولین سفارش ساخته شده‌اند و هنوز تأیید نشده‌اند.</p>
          {customers.error ? <div className="err">{customers.error}</div> : !customers.data ? <div className="card pad muted">در حال بارگذاری…</div>
            : !newCustomers.length ? <div className="empty">مشتری جدیدی منتظر تأیید نیست.</div>
            : newCustomers.map(c => <NewCustomer key={c.id} c={c} onDone={customers.reload} />)}
        </section>
      )}
      {tab === 'hist' && (
        <>
          <div className="chips">
            <button type="button" className="chip" aria-pressed={histTab === 'CONFIRMED'} onClick={() => setHist('CONFIRMED')}>تأییدشده</button>
            <button type="button" className="chip" aria-pressed={histTab === 'REJECTED'} onClick={() => setHist('REJECTED')}>ردشده</button>
          </div>
          <Orders list={hist} empty="موردی نیست." onChanged={reload} />
        </>
      )}
    </>
  );
}

function Orders({ list, empty, onChanged, title }: { list: { data: List | null; error: string | null }; empty: string; onChanged: () => void; title?: string }) {
  const rows = list.data?.rows ?? [];
  return (
    <section className="stack">
      {title && <h2>{title}</h2>}
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div>
        : !rows.length ? <div className="empty">{empty}</div>
        : [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(r => <OrderCard key={r.id} r={r} onChanged={onChanged} open={rows.length === 1} />)}
    </section>
  );
}

function OrderCard({ r, onChanged, open: initiallyOpen }: { r: Row; onChanged: () => void; open: boolean }) {
  const { toast, me } = useAdmin();
  const [open, setOpen] = useState(initiallyOpen);
  const [mode, setMode] = useState<'fix' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const d = useApi<Detail>(open ? `/admin/orders/${r.id}` : null);
  const atAgent = ['SUBMITTED', 'SALES_REVIEW', 'NEEDS_FIX'].includes(r.status);
  const atFinal = r.status === 'SALES_APPROVED';
  const isAdmin = me.staffRole === 'ADMIN';
  const agentName = r.customer.support ? personName({ ...r.customer.support, username: null }) : null;

  const decide = async (action: 'sales_ok' | 'final_ok' | 'fix' | 'reject', comment?: string) => {
    setBusy(true);
    try {
      const o = await api<{ status: string }>(`/admin/orders/${r.id}/decide`, { method: 'POST', body: { action, comment } });
      const no = `پیش‌فاکتور #${fa(r.number)}`;
      toast(o.status === 'CONFIRMED' ? `${no} تأیید نهایی شد` : o.status === 'SALES_APPROVED' ? `${no} تأیید شد و برای مدیر رفت` : o.status === 'NEEDS_FIX' ? `${no} برای اصلاح به مشتری برگشت` : `${no} رد شد`);
      setMode(null); onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  return (
    <article className="card ocard">
      <button type="button" className="ohead" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="num"><b>#{fa(r.number)}</b> · {r.customer.name}</span>
        <span className={`st ${STATUS_CLASS(r.status)}`}>{SHORT[r.status] ?? r.statusFa}</span>
        <span className="muted small num">{personName(r.placedBy)} · {r.channel === 'agent' ? '🤖 ایجنت هوش مصنوعی' : r.channel === 'bot' ? 'ربات' : 'مینی‌اپ'} · {dateFa(r.createdAt)} · کارشناس: {agentName ?? 'تعیین نشده'}</span>
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
              {d.data.events.filter(e => e.comment).slice(-2).map(e => <p key={e.id} className="small" style={{ margin: 0 }}>توضیح ({dateFa(e.createdAt)}): {e.comment}</p>)}
            </>
          )}
        </div>
      )}
      {(atAgent || atFinal) && (mode ? (
        <div className="obody">
          <textarea className="in" autoFocus value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
            placeholder={mode === 'fix' ? 'چه چیزی باید اصلاح شود؟ (برای مشتری فرستاده می‌شود)' : 'دلیل رد (برای مشتری فرستاده می‌شود؛ اختیاری)'} />
          <div className="decide" style={{ padding: 0 }}>
            {mode === 'fix'
              ? <button type="button" className="btn ok-fill" disabled={busy || !reason.trim()} onClick={() => decide('fix', reason.trim())}>برگرداندن برای اصلاح</button>
              : <button type="button" className="btn danger-fill" disabled={busy} onClick={() => decide('reject', reason.trim() || undefined)}>رد پیش‌فاکتور</button>}
            <button type="button" className="btn" onClick={() => setMode(null)}>انصراف</button>
          </div>
        </div>
      ) : atAgent ? (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => decide('sales_ok')}>✓ تأیید کارشناس</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setMode('fix')}>اصلاح</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('reject')}>✕ رد</button>
        </div>
      ) : isAdmin ? (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => decide('final_ok')}>✓ تأیید نهایی</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('reject')}>✕ رد</button>
        </div>
      ) : <div className="decide muted small">منتظر تأیید نهایی مدیر</div>)}
    </article>
  );
}

function PaymentCard({ p, onDone }: { p: Reported; onDone: () => void }) {
  const { toast } = useAdmin();
  const img = useBlobUrl(p.hasReceipt ? `/admin/accounts/payments/${p.id}/receipt` : null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);
  const review = async (ok: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ statusFa: string }>(`/admin/accounts/payments/${p.id}/review`, { method: 'POST', body: { ok, comment: reason.trim() || undefined } });
      toast(`${p.customer.name}: ${r.statusFa}`); onDone();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  return (
    <article className="card ocard">
      <div className="paycard">
        {p.hasReceipt
          ? <button type="button" className="receipt" onClick={() => setZoom(z => !z)} aria-label="بزرگ‌نمایی رسید">{img ? <img src={img} alt="عکس رسید" /> : <span className="muted small">…</span>}</button>
          : <span className="receipt muted small">بدون عکس</span>}
        <div className="stack" style={{ gap: 4 }}>
          <b>{p.customer.name}</b>
          <span className="num"><b>{rial(p.amount)}</b> · {p.methodFa}</span>
          <span className="muted small num">
            {p.chequeNumber ? `چک ${p.chequeNumber} · ` : ''}{p.bank ? `${p.bank} · ` : ''}{p.dueDate ? `سررسید ${dateFa(p.dueDate)} · ` : ''}ارسال {dateFa(p.receivedAt)}{p.invoice ? ` · فاکتور ${fa(p.invoice.number)}` : ''}
          </span>
          {p.note && <span className="note small">{p.note}</span>}
        </div>
      </div>
      {zoom && img && <img className="receipt-big" src={img} alt="عکس رسید" onClick={() => setZoom(false)} />}
      {rejecting ? (
        <div className="obody">
          <textarea className="in" autoFocus placeholder="دلیل (برای مشتری فرستاده می‌شود؛ اختیاری)" value={reason} onChange={e => setReason(e.target.value)} maxLength={300} />
          <div className="decide" style={{ padding: 0 }}>
            <button type="button" className="btn danger-fill" disabled={busy} onClick={() => review(false)}>تأیید نمی‌شود</button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>انصراف</button>
          </div>
        </div>
      ) : (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => review(true)}>✓ {p.method === 'CHEQUE' ? 'چک دریافت شد' : 'واریز تأیید شد'}</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>✕ رد</button>
        </div>
      )}
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
      <div className="decide" style={{ padding: 0 }}>
        {me.staffRole === 'ADMIN' && <label className="row small">نقد٪ <input className="in num" style={{ width: 70 }} inputMode="numeric" value={cash} onChange={e => setCash(e.target.value)} /></label>}
        <button type="button" className="btn ok-fill" disabled={busy} onClick={approve}>✓ تأیید مشتری</button>
      </div>
    </article>
  );
}
