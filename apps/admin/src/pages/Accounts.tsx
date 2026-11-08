import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dayFa, fa, jalaliToIso, jalaliToday, openPrivate, payModeFa, personName, rial, termsLine, toEnDigits, useApi, useBlobUrl } from '../lib';
import { DocsPanel } from '../components/Docs';

interface Balance { id: string; name: string; city: string | null; invoices: number; invoiced: string; paid: string; pendingCheques: string; balance: string }
interface ToInvoice { id: string; number: number; createdAt: string; customer: { id: string; name: string }; items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string | null }[] }
interface Invoice { id: string; number: number; status: 'ISSUED' | 'CANCELLED'; issuedAt: string; total: string; itemCount: number; order: { number: number } | null }
interface Payment { id: string; amount: string; method: string; methodFa: string; status: string; statusFa: string; hasReceipt: boolean; receiptPdf?: boolean; chequeNumber: string | null; bank: string | null; dueDate: string | null; receivedAt: string; note: string | null; invoice: { number: number } | null }
interface Account {
  customer: {
    id: string; name: string; city: string | null;
    terms: { cashDiscountPct: string; termDiscountPct: string; termMonths: number; allowCash: boolean; allowTerm: boolean } | null;
    support: { id: string; firstName: string | null; lastName: string | null; username: string | null } | null;
  };
  summary: { invoiced: string; paid: string; pendingCheques: string; reported: string; balance: string; balanceAfterCheques: string };
  invoices: Invoice[]; payments: Payment[];
  statement: { kind: string; id: string; title: string; at: string; debit: string; credit: string; balance: string }[];
}

const clean = (s: string) => toEnDigits(s).replace(/[,،٬\s]/g, '');
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'ثبت نشد');
const PAY_ST: Record<string, string> = { REPORTED: 'new', PENDING: 'ask', CLEARED: 'ok', BOUNCED: 'no', CANCELLED: 'gray' };

/** Customer accounts: issue invoices for confirmed orders, record money received, follow each balance. */
export function AccountsPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  if (focus) return <CustomerAccount key={focus} id={focus} onBack={() => onFocus()} />;
  return <AccountList onOpen={onFocus} />;
}

function AccountList({ onOpen }: { onOpen: (id: string) => void }) {
  const { me } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useApi<Balance[]>(`/admin/accounts?q=${encodeURIComponent(query)}`);
  const todo = useApi<ToInvoice[]>('/admin/accounts/to-invoice');
  return (
    <>
      <div className="head"><h1>حساب مشتریان</h1></div>
      {todo.data && todo.data.length > 0 && (
        <section className="stack">
          <h2>منتظر صدور فاکتور <span className="muted small num">({fa(todo.data.length)})</span></h2>
          {todo.data.map(o => <IssueInvoice key={o.id} o={o} can={me.staffRole === 'ADMIN'} onDone={() => { todo.reload(); list.reload(); }} />)}
        </section>
      )}
      <section className="stack">
        <h2>مانده‌ی حساب‌ها</h2>
        <input className="in search" placeholder="نام مشتری" value={q} onChange={e => setQ(e.target.value)} />
        {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : !list.data.length ? <div className="empty">مشتری‌ای پیدا نشد.</div> : (
          <div className="card plist">
            {list.data.map(c => (
              <button key={c.id} type="button" className="prow" onClick={() => onOpen(c.id)}>
                <span className="pinfo"><b>{c.name}</b><span className="muted small num">{c.city ?? ''}{c.city ? ' · ' : ''}{fa(c.invoices)} فاکتور{BigInt(c.pendingCheques) ? ` · چک در جریان ${fa(c.pendingCheques)}` : ''}</span></span>
                <span className="num small" style={{ textAlign: 'left' }}>{BigInt(c.balance) > 0n ? <b style={{ color: 'var(--bad)' }}>{fa(c.balance)}</b> : BigInt(c.balance) < 0n ? <b style={{ color: 'var(--ok)' }}>{fa(-BigInt(c.balance))} بستانکار</b> : <span className="muted">تسویه</span>}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function IssueInvoice({ o, can, onDone }: { o: ToInvoice; can: boolean; onDone: () => void }) {
  const { toast } = useAdmin();
  const [open, setOpen] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState('');
  const [shipping, setShipping] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = o.items.filter(i => i.unitPrice === null && !clean(prices[i.id] ?? ''));
  const subtotal = o.items.reduce((s, i) => { const p = i.unitPrice ?? (clean(prices[i.id] ?? '') || '0'); return s + BigInt(p) * BigInt(i.quantity); }, 0n);
  const total = subtotal - BigInt(clean(discount) || '0') + BigInt(clean(shipping) || '0');
  const issue = async () => {
    setBusy(true);
    try {
      const inv = await api<{ number: number }>('/admin/accounts/invoices', { method: 'POST', body: { orderId: o.id, prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, clean(v)])), discount: clean(discount), shipping: clean(shipping), note } });
      toast(`فاکتور ${fa(inv.number)} صادر و برای مشتری فرستاده شد`); onDone();
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return (
    <article className="card ocard">
      <button type="button" className="ohead" onClick={() => setOpen(x => !x)} aria-expanded={open}>
        <span className="num"><b>سفارش #{fa(o.number)}</b> · {o.customer.name}</span>
        <span className="st ok">تأییدشده</span>
        <span className="muted small num">{fa(o.items.length)} قلم{o.items.some(i => i.unitPrice === null) ? ' · قیمت استعلامی دارد' : ''} · {dayFa(o.createdAt)}</span>
      </button>
      {open && (
        <div className="obody">
          <div className="items">
            {o.items.map(i => (
              <div key={i.id}>
                <span>{i.title}<br /><span className="muted small num">{i.packs ? `${fa(i.packs)} بسته · ` : ''}{fa(i.quantity)} عدد</span></span>
                {i.unitPrice !== null ? <span className="num small">{rial(i.unitPrice)}</span>
                  : <input className="in num" dir="ltr" inputMode="numeric" placeholder="قیمت واحد (ریال)" style={{ width: 150 }} value={prices[i.id] ?? ''} onChange={e => setPrices({ ...prices, [i.id]: e.target.value })} />}
              </div>
            ))}
          </div>
          <div className="row2">
            <label className="f"><span>تخفیف (ریال)</span><input className="in num" dir="ltr" inputMode="numeric" value={discount} onChange={e => setDiscount(e.target.value)} /></label>
            <label className="f"><span>هزینه‌ی حمل (ریال)</span><input className="in num" dir="ltr" inputMode="numeric" value={shipping} onChange={e => setShipping(e.target.value)} /></label>
          </div>
          <label className="f"><span>توضیح روی فاکتور (اختیاری)</span><input className="in" value={note} onChange={e => setNote(e.target.value)} /></label>
          <div className="tot"><span>مبلغ فاکتور</span><span className="num">{missing.length ? '—' : rial(total.toString())}</span></div>
          {can ? <button type="button" className="btn primary" disabled={busy || missing.length > 0} onClick={issue}>{missing.length ? `قیمت ${fa(missing.length)} قلم استعلامی را وارد کنید` : busy ? 'در حال صدور…' : 'صدور فاکتور و ارسال برای مشتری'}</button>
            : <div className="note">صدور فاکتور با مدیر است.</div>}
        </div>
      )}
    </article>
  );
}

/** A customer's money: balance, invoices, payments, documents. Also shown as the «حساب مالی» tab of the customer page. */
export function CustomerAccount({ id, onBack, embedded }: { id: string; onBack?: () => void; embedded?: boolean }) {
  const { me, toast, open } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const a = useApi<Account>(`/admin/accounts/customers/${id}`);
  const [tab, setTab] = useState<'statement' | 'invoices' | 'payments' | 'docs'>('statement');
  const [inv, setInv] = useState<string | null>(null);
  if (a.error) return <div className="err">{a.error}</div>;
  if (!a.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const d = a.data; const s = d.summary;
  const payStatus = async (pid: string, status: string, ok: string) => {
    try { await api(`/admin/accounts/payments/${pid}`, { method: 'PATCH', body: { status } }); toast(ok); a.reload(); } catch (e) { toast(err(e)); }
  };
  const review = async (pid: string, ok: boolean) => {
    const comment = ok ? undefined : prompt('دلیل رد؟ (برای مشتری فرستاده می‌شود)');
    if (comment === null) return;
    try { const r = await api<{ statusFa: string }>(`/admin/accounts/payments/${pid}/review`, { method: 'POST', body: { ok, comment } }); toast(r.statusFa); a.reload(); } catch (e) { toast(err(e)); }
  };
  const cancel = async (iid: string) => {
    const reason = prompt('دلیل ابطال فاکتور؟');
    if (reason === null) return;
    try { await api(`/admin/accounts/invoices/${iid}/cancel`, { method: 'POST', body: { reason } }); toast('فاکتور باطل شد'); a.reload(); } catch (e) { toast(err(e)); }
  };
  if (inv) return <InvoiceView id={inv} onBack={() => setInv(null)} />;

  return (
    <>
      {!embedded && <div className="head"><button type="button" className="btn sm" onClick={onBack}>→ حساب‌ها</button><button type="button" className="btn sm" onClick={() => open('customers/settings', id)}>پرونده‌ی مشتری و شرایط فروش</button></div>}
      <div className="card pad stack">
        {!embedded && <h1 style={{ fontSize: 19 }}>{d.customer.name}</h1>}
        {!embedded && <span className="muted small num">شرایط فروش: {termsLine(d.customer.terms)} · کارشناس: {d.customer.support ? personName(d.customer.support) : 'تعیین نشده'}</span>}
        <div className="sums">
          <div><span>مانده‌ی بدهی</span><b className="num" style={{ color: BigInt(s.balance) > 0n ? 'var(--bad)' : 'var(--ok)' }}>{rial(s.balance)}</b></div>
          <div><span>جمع فاکتورها</span><b className="num">{rial(s.invoiced)}</b></div>
          <div><span>دریافت‌شده</span><b className="num">{rial(s.paid)}</b></div>
          <div><span>چک در جریان</span><b className="num">{rial(s.pendingCheques)}</b></div>
        </div>
        {BigInt(s.reported) > 0n && <p className="small" style={{ margin: 0 }}><span className="st new">منتظر بررسی</span> <span className="num">{rial(s.reported)}</span> رسید از طرف مشتری (در تب «دریافتی‌ها»)</p>}
      </div>
      {can && <AddPayment customerId={id} invoices={d.invoices.filter(i => i.status === 'ISSUED')} onDone={a.reload} />}
      <div className="chips">
        {([['statement', 'گردش حساب'], ['invoices', `فاکتورها (${fa(d.invoices.length)})`], ['payments', `دریافتی‌ها (${fa(d.payments.length)})`], ['docs', 'اسناد مالی']] as const).map(([k, t]) => (
          <button key={k} type="button" className="chip" aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>
      {tab === 'statement' && (!d.statement.length ? <div className="empty">هنوز گردشی ثبت نشده است.</div> : (
        <div className="card plist">
          {d.statement.map(e => (
            <div key={e.kind + e.id} className="prow static">
              <span className="pinfo"><b>{e.title}</b><span className="muted small num">{dayFa(e.at)}</span></span>
              <span className="num small" style={{ textAlign: 'left' }}>{BigInt(e.debit) ? <span style={{ color: 'var(--bad)' }}>+{fa(e.debit)}</span> : <span style={{ color: 'var(--ok)' }}>−{fa(e.credit)}</span>}<br /><span className="muted">مانده {fa(e.balance)}</span></span>
            </div>
          ))}
        </div>
      ))}
      {tab === 'invoices' && (!d.invoices.length ? <div className="empty">فاکتوری صادر نشده است.</div> : (
        <div className="card plist">
          {d.invoices.map(i => (
            <div key={i.id} className="prow static">
              <button type="button" className="pinfo linkish" onClick={() => setInv(i.id)}><b className="num">فاکتور {fa(i.number)}{i.order ? ` · سفارش #${fa(i.order.number)}` : ''}</b><span className="muted small num">{dayFa(i.issuedAt)} · {fa(i.itemCount)} قلم</span></button>
              <span className="num small">{i.status === 'CANCELLED' ? <span className="st gray">باطل</span> : rial(i.total)}</span>
              {can && i.status === 'ISSUED' && <button type="button" className="btn sm ghost" onClick={() => cancel(i.id)}>ابطال</button>}
            </div>
          ))}
        </div>
      ))}
      {tab === 'docs' && <DocsPanel customerId={id} />}
      {tab === 'payments' && (!d.payments.length ? <div className="empty">دریافتی ثبت نشده است.</div> : (
        <div className="stack">
          {d.payments.map(p => (
            <div key={p.id} className="card vrow">
              <div className="between"><b className="num">{rial(p.amount)}</b><span className={`st ${PAY_ST[p.status]}`}>{p.status === 'PENDING' ? 'در جریان' : p.statusFa}</span></div>
              <span className="muted small num">{p.methodFa}{p.chequeNumber ? ` ${p.chequeNumber}` : ''}{p.bank ? ` · ${p.bank}` : ''}{p.dueDate ? ` · سررسید ${dayFa(p.dueDate)}` : ''} · ثبت {dayFa(p.receivedAt)}{p.invoice ? ` · بابت فاکتور ${fa(p.invoice.number)}` : ''}</span>
              {p.note && <span className="small">{p.note}</span>}
              {p.hasReceipt && <Receipt id={p.id} pdf={p.receiptPdf} />}
              {p.status === 'REPORTED' && (
                <div className="decide" style={{ padding: 0 }}>
                  <button type="button" className="btn ok-fill sm" onClick={() => review(p.id, true)}>✓ تأیید رسید</button>
                  <button type="button" className="btn danger sm" onClick={() => review(p.id, false)}>رد</button>
                </div>
              )}
              {can && p.status === 'PENDING' && (
                <div className="decide" style={{ padding: 0 }}>
                  <button type="button" className="btn ok-fill sm" onClick={() => payStatus(p.id, 'CLEARED', 'چک وصول شد')}>✓ وصول شد</button>
                  <button type="button" className="btn danger sm" onClick={() => payStatus(p.id, 'BOUNCED', 'چک برگشتی ثبت شد')}>برگشت خورد</button>
                </div>
              )}
              {can && p.status === 'CLEARED' && <button type="button" className="btn sm ghost" style={{ justifySelf: 'start' }} onClick={() => confirm('این دریافتی باطل شود؟') && payStatus(p.id, 'CANCELLED', 'باطل شد')}>ابطال</button>}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function AddPayment({ customerId, invoices, onDone }: { customerId: string; invoices: Invoice[]; onDone: () => void }) {
  const { toast } = useAdmin();
  const [open, setOpen] = useState(false);
  const [t] = useState(jalaliToday);
  const [f, setF] = useState({ method: 'TRANSFER', amount: '', chequeNumber: '', bank: '', y: String(t[0]), m: String(t[1]), d: String(t[2]), note: '', invoiceId: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await api('/admin/accounts/payments', { method: 'POST', body: {
        customerId, method: f.method, amount: clean(f.amount), note: f.note, invoiceId: f.invoiceId || undefined,
        ...(f.method === 'CHEQUE' ? { chequeNumber: f.chequeNumber, bank: f.bank, dueDate: jalaliToIso(+toEnDigits(f.y), +f.m, +toEnDigits(f.d)) } : {}),
      } });
      toast('دریافتی ثبت شد و به مشتری اطلاع داده شد'); setOpen(false); setF({ ...f, amount: '', chequeNumber: '', bank: '', note: '' }); onDone();
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="btn primary" onClick={() => setOpen(true)}>+ ثبت دریافتی (نقد، واریز یا چک)</button>;
  const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  return (
    <div className="card pad stack">
      <div className="between"><h2>ثبت دریافتی</h2><button type="button" className="btn sm" onClick={() => setOpen(false)}>بستن</button></div>
      <div className="chips">{[['TRANSFER', 'واریز'], ['CASH', 'نقد'], ['CHEQUE', 'چک']].map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={f.method === k} onClick={() => setF({ ...f, method: k })}>{l}</button>)}</div>
      <label className="f"><span>مبلغ (ریال)</span><input className="in num" dir="ltr" inputMode="numeric" value={f.amount} onChange={set('amount')} autoFocus /></label>
      {f.method === 'CHEQUE' && (
        <>
          <div className="row2">
            <label className="f"><span>شماره‌ی چک</span><input className="in num" dir="ltr" value={f.chequeNumber} onChange={set('chequeNumber')} /></label>
            <label className="f"><span>بانک</span><input className="in" value={f.bank} onChange={set('bank')} /></label>
          </div>
          <label className="f"><span>سررسید</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="in num" style={{ width: 64 }} inputMode="numeric" value={f.d} onChange={set('d')} aria-label="روز" />
              <select className="in" value={f.m} onChange={set('m')} aria-label="ماه">{MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}</select>
              <input className="in num" style={{ width: 84 }} inputMode="numeric" value={f.y} onChange={set('y')} aria-label="سال" />
            </div>
          </label>
          <p className="muted small" style={{ margin: 0 }}>چک تا «وصول شد» زدن، از مانده کم نمی‌شود و در «چک در جریان» می‌ماند.</p>
        </>
      )}
      {invoices.length > 0 && <label className="f"><span>بابت فاکتور (اختیاری)</span><select className="in" value={f.invoiceId} onChange={set('invoiceId')}><option value="">علی‌الحساب</option>{invoices.map(i => <option key={i.id} value={i.id}>فاکتور {fa(i.number)} · {rial(i.total)}</option>)}</select></label>}
      <label className="f"><span>توضیح (اختیاری)</span><input className="in" value={f.note} onChange={set('note')} /></label>
      <button type="button" className="btn primary" disabled={busy || !clean(f.amount)} onClick={save}>{busy ? 'در حال ثبت…' : 'ثبت'}</button>
    </div>
  );
}

interface InvoiceDetail {
  id: string; number: number; status: string; issuedAt: string; subtotal: string; discount: string; shipping: string; cashDiscount?: string; chequeMarkup?: string; total: string; cashPercent: number; payMode?: string; termMonths?: number; listTotal?: string; chequeDueDays?: number[]; note: string | null;
  customer: { name: string; city: string | null }; order: { number: number } | null; split: { cash: string; cheque: string };
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string; total: string }[];
}
export function InvoiceView({ id, onBack }: { id: string; onBack: () => void }) {
  const v = useApi<InvoiceDetail>(`/admin/accounts/invoices/${id}`);
  if (!v.data) return <div className="card pad muted">{v.error ?? 'در حال بارگذاری…'}</div>;
  const i = v.data;
  return (
    <>
      <div className="head"><button type="button" className="btn sm" onClick={onBack}>→ بازگشت</button><button type="button" className="btn sm" onClick={() => print()}>چاپ</button></div>
      <div className="card pad stack invoice">
        <div className="between"><h2 className="num">فاکتور فروش {fa(i.number)}</h2>{i.status === 'CANCELLED' ? <span className="st gray">باطل</span> : <span className="muted small num">{dayFa(i.issuedAt)}</span>}</div>
        <div className="small">اصفهان پلاست ← <b>{i.customer.name}</b>{i.customer.city ? ` · ${i.customer.city}` : ''}{i.order ? <span className="muted num"> · سفارش #{fa(i.order.number)}</span> : null}</div>
        <div className="items">
          {i.items.map(x => <div key={x.id}><span>{x.title}<br /><span className="muted small num">{x.packs ? `${fa(x.packs)} بسته · ` : ''}{fa(x.quantity)} × {fa(x.unitPrice)}</span></span><b className="num">{fa(x.total)}</b></div>)}
        </div>
        <div className="items small">
          {BigInt(i.listTotal ?? '0') > BigInt(i.subtotal) && <><div><span>جمع به قیمت لیست</span><span className="num">{rial(i.listTotal!)}</span></div><div><span>تخفیف {payModeFa(i.payMode ?? 'CASH')}</span><span className="num">−{rial(String(BigInt(i.listTotal!) - BigInt(i.subtotal)))}</span></div></>}
          <div><span>جمع اقلام</span><span className="num">{rial(i.subtotal)}</span></div>
          {BigInt(i.discount) > 0n && <div><span>تخفیف</span><span className="num">−{rial(i.discount)}</span></div>}
          {BigInt(i.cashDiscount ?? '0') > 0n && <div><span>تخفیف نقدی</span><span className="num">−{rial(i.cashDiscount!)}</span></div>}
          {BigInt(i.chequeMarkup ?? '0') > 0n && <div><span>افزایش چکی</span><span className="num">{rial(i.chequeMarkup!)}</span></div>}
          {BigInt(i.shipping) > 0n && <div><span>حمل</span><span className="num">{rial(i.shipping)}</span></div>}
        </div>
        <div className="tot"><span>مبلغ قابل پرداخت</span><span className="num">{rial(i.total)}</span></div>
        <p className="small muted num" style={{ margin: 0 }}>{i.payMode === 'TERM' ? `${payModeFa('TERM', i.termMonths)}: چک ${rial(i.split.cheque)}${i.termMonths ? `، سررسید ${fa(i.termMonths)} ماه بعد از فاکتور` : ''}${BigInt(i.split.cash) ? ` · نقد (کرایه) ${rial(i.split.cash)}` : ''}` : BigInt(i.split.cheque) ? `نقد ${fa(i.cashPercent)}٪: ${rial(i.split.cash)} · چک: ${rial(i.split.cheque)}` : `نقدی: ${rial(i.split.cash)}`}</p>
        {i.note && <p className="note" style={{ margin: 0 }}>{i.note}</p>}
      </div>
    </>
  );
}

function Receipt({ id, pdf }: { id: string; pdf?: boolean }) {
  const { toast } = useAdmin();
  const url = useBlobUrl(pdf ? null : `/admin/accounts/payments/${id}/receipt`);
  if (pdf) return <button type="button" className="btn sm" style={{ justifySelf: 'start' }} onClick={() => openPrivate(`/admin/accounts/payments/${id}/receipt`).catch(e => toast(e.message))}>📄 باز کردن PDF رسید</button>;
  const [big, setBig] = useState(false);
  if (!url) return <span className="muted small">در حال بارگذاری عکس…</span>;
  return <img src={url} alt="عکس رسید" onClick={() => setBig(b => !b)} style={{ width: big ? '100%' : 96, borderRadius: 10, border: '1px solid var(--line)', cursor: 'zoom-in' }} />;
}
