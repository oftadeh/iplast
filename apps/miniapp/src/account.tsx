import { useState } from 'react';
import { useApp } from './App';
import { Icon } from './icons';
import { fa, useApi } from './lib';
import { openSupportChat } from './telegram';

interface Invoice { id: string; number: number; status: 'ISSUED' | 'CANCELLED'; issuedAt: string; total: string; itemCount: number; order: { number: number } | null }
interface Payment { id: string; amount: string; method: string; methodFa: string; status: string; chequeNumber: string | null; bank: string | null; dueDate: string | null; receivedAt: string; invoice: { number: number } | null }
interface Account {
  customer: { id: string; name: string };
  summary: { invoiced: string; paid: string; pendingCheques: string; balance: string; balanceAfterCheques: string };
  invoices: Invoice[]; payments: Payment[];
  statement: { kind: 'invoice' | 'payment'; id: string; title: string; at: string; debit: string; credit: string; balance: string }[];
}
interface InvoiceDetail {
  id: string; number: number; status: string; issuedAt: string; subtotal: string; discount: string; shipping: string; total: string; cashPercent: number; note: string | null;
  customer: { name: string; city: string | null }; order: { id: string; number: number } | null; split: { cash: string; cheque: string }; paidAgainst: string;
  items: { id: string; title: string; quantity: number; packs: number | null; unitPrice: string; total: string }[];
}

const day = (d: string) => new Date(d).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
const rial = (s: string | bigint) => `${fa(s)} ریال`;
const PAY_ST: Record<string, [string, string]> = { PENDING: ['در جریان', 'ask'], CLEARED: ['وصول شد', 'ok'], BOUNCED: ['برگشتی', 'no'], CANCELLED: ['باطل', 'no'] };

/** «حساب من»: what the company owes, its invoices, payments and cheques. */
export function AccountScreen() {
  const { authed, go } = useApp();
  const a = useApi<Account>(authed ? '/me/account' : null, [authed]);
  const [tab, setTab] = useState<'invoices' | 'statement' | 'payments'>('invoices');
  return (
    <>
      <div className="top"><h1>حساب من</h1></div>
      {authed === false && <div className="empty">برای دیدن حساب، فروشگاه را از داخل ربات تلگرام باز کنید.</div>}
      {a.error && <div className="empty">{a.error}</div>}
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
            <div className="pad"><button type="button" className="cta ghost" onClick={openSupportChat}><Icon n="chat" s={18} />&nbsp; سؤال درباره‌ی حساب</button></div>
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
        <div><span>جمع اقلام</span><span className="num">{rial(i.subtotal)}</span></div>
        {BigInt(i.discount) > 0n && <div><span>تخفیف</span><span className="num">−{rial(i.discount)}</span></div>}
        {BigInt(i.shipping) > 0n && <div><span>هزینه‌ی حمل</span><span className="num">{rial(i.shipping)}</span></div>}
        <div className="big"><span>مبلغ فاکتور</span><b className="num">{fa(i.total)} <small style={{ fontSize: 12, fontWeight: 600 }}>ریال</small></b></div>
        <div><span>نقد {fa(i.cashPercent)}٪</span><span className="num">{rial(i.split.cash)}</span></div>
        {i.cashPercent < 100 && <div><span>چک {fa(100 - i.cashPercent)}٪</span><span className="num">{rial(i.split.cheque)}</span></div>}
        {BigInt(i.paidAgainst) > 0n && <p className="num">پرداخت‌شده بابت این فاکتور: {rial(i.paidAgainst)}</p>}
      </div>
      {i.note && <div className="notice" style={{ margin: '12px 16px 0' }}>{i.note}</div>}
      <div style={{ height: 24 }} />
    </>
  );
}
