import { useEffect, useState } from 'react';
import { useApp } from './App';
import { Icon } from './icons';
import { ApiError, apiForm, fa, jalaliToIso, payModeFa, jalaliToday, shrinkPhoto, toEnDigits, useApi } from './lib';

interface Invoice { id: string; number: number; status: 'ISSUED' | 'CANCELLED'; issuedAt: string; total: string; itemCount: number; order: { number: number } | null }
interface Payment { id: string; amount: string; method: string; methodFa: string; status: string; chequeNumber: string | null; bank: string | null; dueDate: string | null; receivedAt: string; invoice: { number: number } | null }
interface Account {
  customer: { id: string; name: string };
  summary: { invoiced: string; paid: string; pendingCheques: string; reported: string; balance: string; balanceAfterCheques: string };
  invoices: Invoice[]; payments: Payment[];
  statement: { kind: 'invoice' | 'payment'; id: string; title: string; at: string; debit: string; credit: string; balance: string }[];
}
interface InvoiceDetail {
  id: string; number: number; status: string; issuedAt: string; subtotal: string; discount: string; shipping: string; total: string; cashPercent: number; payMode?: string; termMonths?: number; listTotal?: string; note: string | null;
  customer: { name: string; city: string | null }; order: { id: string; number: number } | null; split: { cash: string; cheque: string }; paidAgainst: string;
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string; total: string }[];
}

const day = (d: string) => new Date(d).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
const rial = (s: string | bigint) => `${fa(s)} ریال`;
const PAY_ST: Record<string, [string, string]> = { REPORTED: ['منتظر بررسی کارشناس', 'info'], PENDING: ['در جریان', 'ask'], CLEARED: ['وصول شد', 'ok'], BOUNCED: ['برگشتی', 'no'], CANCELLED: ['باطل', 'no'] };

/** «حساب من»: what the company owes, its invoices, payments and cheques. */
export function AccountScreen() {
  const { authed, go } = useApp();
  const a = useApi<Account>(authed ? '/me/account' : null, [authed]);
  const [tab, setTab] = useState<'invoices' | 'statement' | 'payments'>('invoices');
  const [sending, setSending] = useState(false);
  const sendBtn = <div className="pad"><button type="button" className="cta" style={{ justifyContent: 'center' }} onClick={() => setSending(true)}><Icon n="file" s={18} />&nbsp; ارسال عکس یا PDF چک و فیش واریزی</button></div>;
  if (sending) return <PayForm invoices={a.data?.invoices.filter(i => i.status === 'ISSUED') ?? []} onClose={sent => { setSending(false); if (sent) { a.reload(); setTab('payments'); } }} />;
  return (
    <>
      <div className="top"><h1>حساب من</h1></div>
      {authed === false && <div className="empty">برای دیدن حساب، پنل کاربری را از داخل ربات تلگرام باز کنید.</div>}
      {a.error && <div className="empty">{a.error}</div>}
      {a.error && authed && sendBtn}
      {authed && !a.data && !a.error && <div className="pad"><div className="skel" style={{ height: 220 }} /></div>}
      {a.data && (() => {
        const s = a.data.summary; const owes = BigInt(s.balance);
        return (
          <>
            <section className="ostat acc">
              <p>{a.data.customer.name}</p>
              <span className="lbl">{owes > 0n ? 'مانده‌ی بدهی' : owes < 0n ? 'بستانکار' : 'حساب تسویه است'}</span>
              <b className="num big">{fa(owes < 0n ? -owes : owes)} <small>ریال</small></b>
              <div className="accgrid">
                <div><span>جمع فاکتورها</span><b className="num">{fa(s.invoiced)}</b></div>
                <div><span>پرداخت‌شده</span><b className="num">{fa(s.paid)}</b></div>
                {BigInt(s.pendingCheques) > 0n && <div><span>چک در جریان</span><b className="num">{fa(s.pendingCheques)}</b></div>}
                {BigInt(s.pendingCheques) > 0n && <div><span>مانده پس از وصول چک‌ها</span><b className="num">{fa(s.balanceAfterCheques)}</b></div>}
              </div>
            </section>
            {BigInt(s.reported) > 0n && <div className="notice" style={{ marginTop: 10 }}><span className="num">{rial(s.reported)}</span> پرداخت فرستاده‌اید که منتظر بررسی کارشناس فروش است.</div>}
            {sendBtn}
            <div className="seg" role="tablist">
              {([['invoices', 'فاکتورها'], ['statement', 'گردش حساب'], ['payments', 'پرداخت‌ها و چک‌ها']] as const).map(([k, t]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{t}</button>
              ))}
            </div>
            {tab === 'invoices' && (!a.data.invoices.length ? <div className="empty">هنوز فاکتوری صادر نشده است. فاکتور بعد از تأیید سفارش صادر می‌شود.</div>
              : a.data.invoices.map(i => (
                <button key={i.id} type="button" className="oc" onClick={() => go({ name: 'invoice', id: i.id })}>
                  <div className="r"><b className="num">فاکتور {fa(i.number)}</b>{i.status === 'CANCELLED' ? <span className="st no">باطل</span> : <b className="num" style={{ fontSize: 13 }}>{rial(i.total)}</b>}</div>
                  <small className="num">{day(i.issuedAt)} · {fa(i.itemCount)} قلم{i.order ? ` · سفارش #${fa(i.order.number)}` : ''}</small>
                </button>
              )))}
            {tab === 'statement' && (!a.data.statement.length ? <div className="empty">هنوز گردشی ثبت نشده است.</div> : (
              <div className="ledger">
                {a.data.statement.map(e => (
                  <div key={e.kind + e.id}>
                    <span><b>{e.title}</b><small className="num">{day(e.at)}</small></span>
                    <span className="num">{BigInt(e.debit) ? <em className="dr">+{fa(e.debit)}</em> : <em className="cr">−{fa(e.credit)}</em>}<small>مانده {fa(e.balance)}</small></span>
                  </div>
                ))}
              </div>
            ))}
            {tab === 'payments' && (!a.data.payments.length ? <div className="empty">پرداختی ثبت نشده است.</div> : a.data.payments.map(p => (
              <div key={p.id} className="oc">
                <div className="r"><b className="num">{rial(p.amount)}</b><span className={`st ${PAY_ST[p.status][1]}`}>{PAY_ST[p.status][0]}</span></div>
                <small className="num">{p.methodFa}{p.chequeNumber ? ` ${p.chequeNumber}` : ''}{p.bank ? ` · ${p.bank}` : ''}{p.dueDate ? ` · سررسید ${day(p.dueDate)}` : ''}{p.invoice ? ` · فاکتور ${fa(p.invoice.number)}` : ''} · {day(p.receivedAt)}</small>
              </div>
            )))}
            <div className="pad"><button type="button" className="cta ghost" onClick={() => go({ name: 'chat' })}><Icon n="chat" s={18} />&nbsp; سؤال درباره‌ی حساب</button></div>
          </>
        );
      })()}
    </>
  );
}

export function InvoiceScreen({ id }: { id: string }) {
  const { go } = useApp();
  const v = useApi<InvoiceDetail>(`/me/account/invoices/${encodeURIComponent(id)}`);
  if (v.error) return <div className="empty" style={{ marginTop: 60 }}>{v.error}</div>;
  if (!v.data) return <div className="pad" style={{ paddingTop: 60 }}><div className="skel" style={{ height: 300 }} /></div>;
  const i = v.data;
  return (
    <>
      <div className="top"><h1 className="num">فاکتور {fa(i.number)}</h1></div>
      <div className="invhead">
        <span>{day(i.issuedAt)}</span>
        {i.status === 'CANCELLED' ? <span className="st no">باطل شده</span> : <span className="st ok">صادر شده</span>}
        {i.order && <button type="button" className="link" onClick={() => go({ name: 'order', id: i.order!.id })}>سفارش #{fa(i.order.number)}</button>}
      </div>
      <div className="items">
        {i.items.map(x => (
          <div key={x.id}><span>{x.title}<small className="num">{x.packs ? `${fa(x.packs)} بسته · ` : ''}{fa(x.quantity)} × {fa(x.unitPrice)}</small></span><b className="num">{fa(x.total)}</b></div>
        ))}
      </div>
      <div className="summary">
        <div><span>نوع خرید</span><b>{payModeFa(i.payMode, i.termMonths)}</b></div>
        {BigInt(i.listTotal ?? '0') > BigInt(i.subtotal) && <div><span>تخفیف {payModeFa(i.payMode)} از قیمت لیست</span><span className="num">−{rial(String(BigInt(i.listTotal!) - BigInt(i.subtotal)))}</span></div>}
        <div><span>جمع اقلام</span><span className="num">{rial(i.subtotal)}</span></div>
        {BigInt(i.discount) > 0n && <div><span>تخفیف</span><span className="num">−{rial(i.discount)}</span></div>}
        {BigInt(i.shipping) > 0n && <div><span>هزینه‌ی حمل</span><span className="num">{rial(i.shipping)}</span></div>}
        <div className="big"><span>مبلغ فاکتور</span><b className="num">{fa(i.total)} <small style={{ fontSize: 12, fontWeight: 600 }}>ریال</small></b></div>
        {BigInt(i.split.cash) > 0n && <div><span>{i.payMode === 'TERM' ? 'نقد (کرایه)' : 'نقد'}</span><span className="num">{rial(i.split.cash)}</span></div>}
        {BigInt(i.split.cheque) > 0n && <div><span>چک{i.payMode === 'TERM' && i.termMonths ? `، سررسید ${fa(i.termMonths)} ماه بعد از فاکتور` : ''}</span><span className="num">{rial(i.split.cheque)}</span></div>}
        {BigInt(i.paidAgainst) > 0n && <p className="num">پرداخت‌شده بابت این فاکتور: {rial(i.paidAgainst)}</p>}
      </div>
      {i.note && <div className="notice" style={{ margin: '12px 16px 0' }}>{i.note}</div>}
      <div style={{ height: 24 }} />
    </>
  );
}

/** The customer sends a photo of a cheque or a bank transfer receipt; their sales agent and the managers check it. */
function PayForm({ invoices, onClose }: { invoices: Invoice[]; onClose: (sent: boolean) => void }) {
  const { toast } = useApp();
  const [t] = useState(jalaliToday);
  const [f, setF] = useState({ method: 'TRANSFER', amount: '', chequeNumber: '', bank: '', y: String(t[0]), m: String(t[1]), d: String(t[2]), invoiceId: '', note: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!photo) return; const u = URL.createObjectURL(photo); setPreview(u); return () => URL.revokeObjectURL(u); }, [photo]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const cheque = f.method === 'CHEQUE';
  const amount = toEnDigits(f.amount).replace(/[^0-9]/g, '');
  const send = async () => {
    setErr('');
    if (!photo) return setErr('عکس یا PDF چک یا فیش را انتخاب کنید.');
    if (!amount || BigInt(amount) < 1000n) return setErr('مبلغ را به ریال بنویسید.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', await shrinkPhoto(photo), 'receipt.jpg');
      fd.append('method', f.method); fd.append('amount', amount);
      if (cheque) {
        fd.append('chequeNumber', toEnDigits(f.chequeNumber));
        fd.append('dueDate', jalaliToIso(Number(toEnDigits(f.y)), Number(toEnDigits(f.m)), Number(toEnDigits(f.d))));
      }
      if (f.bank.trim()) fd.append('bank', f.bank.trim());
      if (f.invoiceId) fd.append('invoiceId', f.invoiceId);
      if (f.note.trim()) fd.append('note', f.note.trim());
      await apiForm('/me/account/payments', fd);
      toast('فرستاده شد؛ بعد از بررسی کارشناس فروش خبرتان می‌کنیم');
      onClose(true);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'ارسال نشد؛ دوباره تلاش کنید'); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="top"><h1>ارسال چک یا فیش واریزی</h1></div>
      <p className="notice">عکس را بفرستید تا به دست کارشناس فروش و مدیریت برسد. بعد از تأیید، واریزی از مانده‌ی حسابتان کم می‌شود و چک تا وصول در «چک‌های در جریان» می‌ماند.</p>
      <div className="paysel" style={{ marginTop: 12 }}>
        <label><input type="radio" name="pm" checked={!cheque} onChange={() => setF({ ...f, method: 'TRANSFER' })} />واریز / کارت‌به‌کارت<small>عکس فیش یا رسید</small></label>
        <label><input type="radio" name="pm" checked={cheque} onChange={() => setF({ ...f, method: 'CHEQUE' })} />چک<small>عکس روی چک</small></label>
      </div>
      <div className="stackf">
        <label className="photo-in">
          {photo?.type === 'application/pdf' ? <span><Icon n="file" s={22} /><b>📄 {photo.name}</b></span> : preview ? <img src={preview} alt="پیش‌نمایش رسید" /> : <span><Icon n="file" s={22} /><b>انتخاب عکس یا PDF</b><small>{cheque ? 'روی چک، خوانا' : 'فیش واریزی یا اسکرین‌شات رسید'}</small></span>}
          <input type="file" accept="image/*,application/pdf" onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field"><span>مبلغ (ریال)</span><input className="num" dir="ltr" inputMode="numeric" value={amount ? fa(BigInt(amount)) : ''} onChange={set('amount')} placeholder="مثلاً ۵۰٬۰۰۰٬۰۰۰" /></label>
        {cheque && <label className="field"><span>شماره چک (صیادی)</span><input className="num" dir="ltr" inputMode="numeric" value={f.chequeNumber} onChange={set('chequeNumber')} maxLength={40} /></label>}
        {cheque && (
          <div className="field"><span>تاریخ سررسید</span>
            <div className="jdate"><input className="num" inputMode="numeric" aria-label="سال" placeholder="سال" value={f.y} onChange={set('y')} /><input className="num" inputMode="numeric" aria-label="ماه" placeholder="ماه" value={f.m} onChange={set('m')} /><input className="num" inputMode="numeric" aria-label="روز" placeholder="روز" value={f.d} onChange={set('d')} /></div>
          </div>
        )}
        <label className="field"><span>بانک {cheque ? '' : '(اختیاری)'}</span><input value={f.bank} onChange={set('bank')} maxLength={60} placeholder="مثلاً ملت" /></label>
        {invoices.length > 0 && (
          <label className="field"><span>بابت فاکتور (اختیاری)</span>
            <select value={f.invoiceId} onChange={set('invoiceId')}><option value="">—</option>{invoices.map(i => <option key={i.id} value={i.id}>فاکتور {fa(i.number)} · {rial(i.total)}</option>)}</select>
          </label>
        )}
        <textarea className="note-in" value={f.note} onChange={set('note')} placeholder="توضیح (اختیاری)" maxLength={500} />
        {err && <div className="notice warn">{err}</div>}
      </div>
      <div className="pad" style={{ display: 'grid', gap: 8 }}>
        <button type="button" className="cta" style={{ justifyContent: 'center' }} disabled={busy} onClick={send}>{busy ? 'در حال ارسال…' : 'ارسال برای کارشناس فروش'}</button>
        <button type="button" className="cta ghost" style={{ justifyContent: 'center' }} onClick={() => onClose(false)}>انصراف</button>
      </div>
    </>
  );
}
