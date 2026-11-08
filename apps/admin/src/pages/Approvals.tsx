import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, STATUS_CLASS, api, dateFa, fa, openPrivate, payModeFa, pctFa, pctOff, personName, rial, termsLine, toEnDigits, useApi, useBlobUrl, type PayMode } from '../lib';

interface Row {
  id: string; number: number; status: string; statusFa: string; createdAt: string; total: string; payable?: string; itemCount: number; inquiryCount: number; channel: string;
  customer: { id: string; name: string; support: { firstName: string | null; lastName: string | null } | null };
  placedBy: { firstName: string | null; lastName: string | null; username: string | null };
}
interface List { rows: Row[]; counts: Record<string, number> }
interface Snapshot { cashPct?: number; termPct?: number; termMonths?: number; allowCash?: boolean; allowTerm?: boolean; categories?: Record<string, { cash?: number | null; term?: number | null }> }
interface Detail {
  id: string; status: string; note: string | null; total: string; payable: string;
  discount: string; shipping: string; payMode: PayMode; termMonths: number;
  termsSnapshot: Snapshot | null; customer: { name: string; city: string | null };
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null; listPrice: string | null; salePct: string | null }[];
  events: { id: string; status: string; comment: string | null; createdAt: string }[];
  proformas: { id: string; version: number; total: string; issuedAt: string; expiresAt: string; acceptedAt: string | null; changed: boolean }[];
}
type Line = { qty: string; price: string; remove: boolean };
interface Customer { id: string; name: string; city: string | null; isApproved: boolean; createdAt: string; terms: { cashDiscountPct: string; termDiscountPct: string; termMonths: number; allowCash: boolean; allowTerm: boolean } | null; _count: { members: number; orders: number } }
interface Reported {
  id: string; amount: string; method: string; methodFa: string; chequeNumber: string | null; bank: string | null; dueDate: string | null;
  receivedAt: string; note: string | null; hasReceipt: boolean; receiptPdf?: boolean; customer: { id: string; name: string }; invoice: { number: number } | null;
}

const AGENT = 'SUBMITTED,SALES_REVIEW,NEEDS_FIX,PROFORMA_SENT,PROFORMA_EXPIRED';
const SHORT: Record<string, string> = { SUBMITTED: 'منتظر کارشناس', SALES_REVIEW: 'در بررسی کارشناس', SALES_APPROVED: 'منتظر تأیید نهایی', CONFIRMED: 'تأیید نهایی شد', PROFORMA_SENT: 'منتظر تأیید مشتری', PROFORMA_EXPIRED: 'منقضی شد؛ دوباره بفرستید', NEEDS_FIX: 'نیاز به اصلاح' };
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
          <p className="muted small" style={{ margin: 0 }}>مرحله‌ی ۱: پیش‌فاکتورهایی که ایجنت هوش مصنوعی یا خود مشتری ثبت کرده. کارشناس فروش قیمت اقلام استعلامی را می‌گذارد و در صورت نیاز تعداد، تخفیف و کرایه را اصلاح می‌کند. اگر چیزی تغییر کند، پیش‌فاکتور نهایی برای تأیید مشتری می‌رود؛ بعد برای تأیید نهایی مدیر.</p>
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

const big = (s: string) => { const t = toEnDigits(s).replace(/[^\d]/g, ''); return t ? BigInt(t) : null; };
const grp = (s: string) => { const n = big(s); return n === null ? '' : fa(n); };

/**
 * Live preview of the money, the same rule the server applies. When the agent switches cash ↔ term, lines priced
 * from the list get the other percentage (the order's terms snapshot); a price typed by the agent stays as typed.
 */
function preview(d: Detail, lines: Record<string, Line>, discount: string, shipping: string, mode: PayMode, months: number) {
  const t = d.termsSnapshot ?? {};
  let list = 0n, sub = 0n, missing = 0;
  const unit: Record<string, bigint | null> = {};
  for (const i of d.items) {
    const l = lines[i.id];
    const q = big(l?.qty ?? '') ?? BigInt(i.quantity);
    let p = big(l?.price ?? '');
    if (p === null && i.unitPrice !== null) {
      p = BigInt(i.unitPrice);
      if (mode !== d.payMode && i.listPrice !== null && i.salePct !== null) p = BigInt(i.listPrice) - pctOff(BigInt(i.listPrice), mode === 'CASH' ? t.cashPct : t.termPct);
    }
    unit[i.id] = p;
    if (l?.remove) continue;
    if (p === null) { missing++; continue; }
    sub += p * q;
    list += (i.listPrice !== null && BigInt(i.listPrice) > p ? BigInt(i.listPrice) : p) * q;
  }
  const disc = big(discount) ?? 0n, ship = big(shipping) ?? 0n;
  const goods = sub - (disc > sub ? sub : disc);
  const cheque = mode === 'TERM' ? goods : 0n;
  return { list, sub, missing, unit, cash: goods - cheque + ship, cheque, total: goods + ship, months };
}

function OrderCard({ r, onChanged, open: initiallyOpen }: { r: Row; onChanged: () => void; open: boolean }) {
  const { toast, me } = useAdmin();
  const [open, setOpen] = useState(initiallyOpen);
  const [mode, setMode] = useState<'fix' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [discount, setDiscount] = useState('');
  const [shipping, setShipping] = useState('');
  const [agentNote, setAgentNote] = useState('');
  const [payMode, setPayMode] = useState<PayMode | ''>('');
  const [months, setMonths] = useState('');
  const d = useApi<Detail>(open ? `/admin/orders/${r.id}` : null);
  const atAgent = ['SUBMITTED', 'SALES_REVIEW', 'NEEDS_FIX', 'PROFORMA_SENT', 'PROFORMA_EXPIRED'].includes(r.status);
  const atFinal = r.status === 'SALES_APPROVED';
  const isAdmin = me.staffRole === 'ADMIN';
  const canEdit = atAgent && me.staffRole !== 'WAREHOUSE';
  const agentName = r.customer.support ? personName({ ...r.customer.support, username: null }) : null;
  const setLine = (id: string, patch: Partial<Line>) => setLines(x => ({ ...x, [id]: { ...{ qty: '', price: '', remove: false }, ...x[id], ...patch } }));

  const dd = d.data;
  const sale: PayMode = (payMode || dd?.payMode || 'CASH') as PayMode;
  const mon = sale === 'TERM' ? Number(toEnDigits(months)) || (dd?.payMode === 'TERM' && dd.termMonths ? dd.termMonths : dd?.termsSnapshot?.termMonths ?? 3) : 0;
  const pv = dd ? preview(dd, lines, discount || dd.discount, shipping || dd.shipping, sale, mon) : null;
  const edited = dd ? Object.entries(lines).some(([id, l]) => {
    const i = dd.items.find(x => x.id === id);
    if (!i) return false;
    return l.remove || (big(l.qty) !== null && big(l.qty) !== BigInt(i.quantity)) || (big(l.price) !== null && String(big(l.price)) !== i.unitPrice);
  }) || sale !== dd.payMode || (sale === 'TERM' && mon !== dd.termMonths) || (discount !== '' && big(discount) !== BigInt(dd.discount)) || (shipping !== '' && big(shipping) !== BigInt(dd.shipping)) || dd.items.some(i => i.unitPrice === null) || r.status === 'PROFORMA_SENT' || r.status === 'PROFORMA_EXPIRED' : false;

  const decide = async (action: 'sales_ok' | 'final_ok' | 'fix' | 'reject', comment?: string) => {
    setBusy(true);
    try {
      const edit = action === 'sales_ok' ? {
        items: Object.entries(lines).map(([id, l]) => ({ id, remove: l.remove || undefined, quantity: l.qty ? toEnDigits(l.qty) : undefined, unitPrice: l.price ? toEnDigits(l.price) : undefined })),
        discount: discount ? toEnDigits(discount) : undefined, shipping: shipping ? toEnDigits(shipping) : undefined,
        ...(dd && (sale !== dd.payMode || (sale === 'TERM' && mon !== dd.termMonths)) ? { payMode: sale, termMonths: sale === 'TERM' ? mon : undefined } : {}),
      } : undefined;
      const o = await api<{ status: string }>(`/admin/orders/${r.id}/decide`, { method: 'POST', body: { action, comment, edit } });
      const no = `پیش‌فاکتور #${fa(r.number)}`;
      toast(o.status === 'CONFIRMED' ? `${no} تأیید نهایی شد و فاکتور صادر شد` : o.status === 'PROFORMA_SENT' ? `${no} برای تأیید مشتری فرستاده شد` : o.status === 'SALES_APPROVED' ? `${no} تأیید شد و برای مدیر رفت` : o.status === 'NEEDS_FIX' ? `${no} برای اصلاح به مشتری برگشت` : `${no} رد شد`);
      setMode(null); setLines({}); setPayMode(''); setMonths(''); onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  const pf = dd?.proformas?.[0];

  return (
    <article className="card ocard">
      <button type="button" className="ohead" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="num"><b>#{fa(r.number)}</b> · {r.customer.name}</span>
        <span className={`st ${STATUS_CLASS(r.status)}`}>{SHORT[r.status] ?? r.statusFa}</span>
        <span className="muted small num">{personName(r.placedBy)} · {r.channel === 'agent' ? '🤖 ایجنت هوش مصنوعی' : r.channel === 'bot' ? 'ربات' : 'مینی‌اپ'} · {dateFa(r.createdAt)} · کارشناس: {agentName ?? 'تعیین نشده'}</span>
        <span className="small num"><b>{fa(r.itemCount)} قلم</b>{r.inquiryCount ? <span className="st ask" style={{ marginInlineStart: 6 }}>{fa(r.inquiryCount)} استعلامی</span> : null} · {BigInt(r.payable ?? r.total) ? rial(r.payable ?? r.total) : '—'}</span>
      </button>
      {open && (
        <div className="obody">
          {!dd ? <div className="muted small">در حال بارگذاری…</div> : (
            <>
              <div className="paymode">
                <span className="small muted">نوع فروش</span>
                {canEdit ? (
                  <>
                    <div className="seg" role="radiogroup" aria-label="نوع فروش">
                      {(['CASH', 'TERM'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={sale === m} onClick={() => setPayMode(m)}>{m === 'CASH' ? `نقدی ${pctFa(dd.termsSnapshot?.cashPct ?? 0)}` : `مدت‌دار ${pctFa(dd.termsSnapshot?.termPct ?? 0)}`}</button>)}
                    </div>
                    {sale === 'TERM' && <label className="small row">مدت <input className="in num" style={{ width: 56 }} inputMode="numeric" value={months} placeholder={fa(mon)} onChange={e => setMonths(toEnDigits(e.target.value).replace(/[^\d]/g, ''))} /> ماه</label>}
                  </>
                ) : <b>{payModeFa(dd.payMode, dd.termMonths)}</b>}
                {sale !== dd.payMode && <span className="st ask">قیمت‌ها با درصد {payModeFa(sale)} دوباره حساب شد</span>}
              </div>
              {canEdit ? (
                <div className="pfedit">
                  <div className="pfrow head"><span>کالا</span><span>تعداد</span><span>قیمت واحد (ریال)</span><span /></div>
                  {dd.items.map(i => {
                    const l = lines[i.id];
                    return (
                      <div key={i.id} className={`pfrow ${l?.remove ? 'gone' : ''} ${i.unitPrice === null && !l?.price ? 'need' : ''}`}>
                        <span>{i.title}{i.packs ? <small className="muted num"> · {fa(i.packs)} بسته</small> : null}{i.listPrice !== null && pv?.unit[i.id] != null && BigInt(i.listPrice) > pv.unit[i.id]! && <small className="muted num"><br />لیست {fa(i.listPrice)} · −{pctFa(Number(((BigInt(i.listPrice) - pv.unit[i.id]!) * 10000n) / BigInt(i.listPrice)) / 100)}</small>}</span>
                        <input className="in num" inputMode="numeric" aria-label="تعداد" value={l?.qty ? grp(l.qty) : ''} placeholder={fa(i.quantity)} onChange={e => setLine(i.id, { qty: toEnDigits(e.target.value).replace(/[^\d]/g, '') })} disabled={l?.remove} />
                        <input className="in num" inputMode="numeric" aria-label="قیمت واحد" value={l?.price ? grp(l.price) : ''} placeholder={pv?.unit[i.id] == null ? 'استعلامی — قیمت بگذارید' : fa(pv.unit[i.id]!)} onChange={e => setLine(i.id, { price: toEnDigits(e.target.value).replace(/[^\d]/g, '') })} disabled={l?.remove} />
                        <button type="button" className="btn sm" title={l?.remove ? 'برگرداندن' : 'حذف این قلم'} onClick={() => setLine(i.id, { remove: !l?.remove })}>{l?.remove ? '↺' : '✕'}</button>
                      </div>
                    );
                  })}
                  <div className="pfrow foot">
                    <label>تخفیف (ریال)<input className="in num" inputMode="numeric" value={discount ? grp(discount) : ''} placeholder={fa(dd.discount)} onChange={e => setDiscount(toEnDigits(e.target.value).replace(/[^\d]/g, ''))} /></label>
                    <label>کرایه (ریال، نقدی)<input className="in num" inputMode="numeric" value={shipping ? grp(shipping) : ''} placeholder={fa(dd.shipping)} onChange={e => setShipping(toEnDigits(e.target.value).replace(/[^\d]/g, ''))} /></label>
                  </div>
                </div>
              ) : (
                <div className="items">
                  {dd.items.map(i => (
                    <div key={i.id}><span>{i.title}<br /><span className="muted small num">{i.packs ? `${fa(i.packs)} بسته · ` : ''}{fa(i.quantity)} عدد × {rial(i.unitPrice)}</span></span>
                      <b className="num">{i.unitPrice !== null ? fa(BigInt(i.unitPrice) * BigInt(i.quantity)) : <span className="st ask">استعلامی</span>}</b></div>
                  ))}
                </div>
              )}
              {pv && (
                <div className="pfsum num">
                  {pv.list > pv.sub && <><div><span>جمع به قیمت لیست</span><span>{fa(pv.list)}</span></div><div><span>تخفیف {payModeFa(sale)}</span><span>−{fa(pv.list - pv.sub)}</span></div></>}
                  <div><span>جمع اقلام</span><span>{fa(pv.sub)}</span></div>
                  {(big(discount || dd.discount) ?? 0n) > 0n && <div><span>تخفیف کارشناس</span><span>−{fa(big(discount || dd.discount)!)}</span></div>}
                  {(big(shipping || dd.shipping) ?? 0n) > 0n && <div><span>کرایه</span><span>{fa(big(shipping || dd.shipping)!)}</span></div>}
                  <div className="tot"><span>مبلغ قابل پرداخت</span><span>{rial(String(pv.total))}</span></div>
                  <div className="muted small"><span>{sale === 'TERM' ? `چک ${fa(pv.cheque)} با سررسید ${fa(pv.months)} ماه بعد${pv.cash ? ` · نقد (کرایه) ${fa(pv.cash)}` : ''}` : `پرداخت نقدی ${fa(pv.cash)}`}</span></div>
                  {pv.missing > 0 && <div className="st ask">{fa(pv.missing)} قلم هنوز قیمت ندارد</div>}
                </div>
              )}
              {pf && <p className="small muted num" style={{ margin: 0 }}>پیش‌فاکتور نسخه {fa(pf.version)} · صدور {dateFa(pf.issuedAt)} · {pf.acceptedAt ? `تأیید مشتری ${dateFa(pf.acceptedAt)}` : pf.changed ? `مهلت تأیید مشتری ${dateFa(pf.expiresAt)}` : 'بدون تغییر نسبت به سفارش مشتری'}</p>}
              {dd.note && <p className="note" style={{ margin: 0 }}>{dd.note}</p>}
              {dd.events.filter(e => e.comment).slice(-2).map(e => <p key={e.id} className="small" style={{ margin: 0 }}>توضیح ({dateFa(e.createdAt)}): {e.comment}</p>)}
              {canEdit && !mode && <input className="in" value={agentNote} onChange={e => setAgentNote(e.target.value)} maxLength={500} placeholder="توضیح برای مشتری (اختیاری)، مثلاً زمان تحویل" />}
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
      ) : atAgent && canEdit ? (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy || !dd || (pv?.missing ?? 0) > 0} onClick={() => decide('sales_ok', agentNote.trim() || undefined)}>
            {!open ? '✓ تأیید کارشناس' : edited ? '✓ تأیید و ارسال برای مشتری' : '✓ تأیید کارشناس'}
          </button>
          {!open && <button type="button" className="btn" onClick={() => setOpen(true)}>قیمت‌گذاری</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => setMode('fix')}>اصلاح</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('reject')}>✕ رد</button>
        </div>
      ) : atAgent ? <div className="decide muted small">منتظر کارشناس فروش</div>
      : isAdmin ? (
        <div className="decide">
          <button type="button" className="btn ok-fill" disabled={busy} onClick={() => decide('final_ok')}>✓ تأیید نهایی و صدور فاکتور</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('reject')}>✕ رد</button>
        </div>
      ) : <div className="decide muted small">منتظر تأیید نهایی مدیر</div>)}
    </article>
  );
}

function PaymentCard({ p, onDone }: { p: Reported; onDone: () => void }) {
  const { toast } = useAdmin();
  const img = useBlobUrl(p.hasReceipt && !p.receiptPdf ? `/admin/accounts/payments/${p.id}/receipt` : null);
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
        {p.receiptPdf
          ? <button type="button" className="receipt" onClick={() => openPrivate(`/admin/accounts/payments/${p.id}/receipt`).catch(e => toast(e.message))}>📄 PDF</button>
          : p.hasReceipt
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
  const { toast, open } = useAdmin();
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try { await api(`/admin/customers/${c.id}`, { method: 'PATCH', body: { isApproved: true } }); toast(`${c.name} تأیید شد`); onDone(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  return (
    <article className="card pad stack">
      <div className="between"><b>{c.name}</b><span className="muted small num">{dateFa(c.createdAt)}</span></div>
      <span className="muted small num">{c.city ?? 'شهر نامشخص'} · {fa(c._count.members)} کاربر · {fa(c._count.orders)} سفارش · شرایط فروش: {termsLine(c.terms)}</span>
      <div className="decide" style={{ padding: 0 }}>
        <button type="button" className="btn" onClick={() => open('customers/settings', `${c.id}/sale`)}>تعیین شرایط فروش</button>
        <button type="button" className="btn ok-fill" disabled={busy} onClick={approve}>✓ تأیید مشتری</button>
      </div>
    </article>
  );
}
