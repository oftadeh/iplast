import { useState } from 'react';
import { useApp } from './App';
import { Icon } from './icons';
import { ApiError, Order, api, fa, payModeFa, personName, useApi } from './lib';
import { haptic, tg } from './telegram';

const ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const TEENS = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const HUNDREDS = ['', 'یکصد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const SCALES = ['', 'هزار', 'میلیون', 'میلیارد', 'هزار میلیارد', 'میلیون میلیارد'];
function under1000(n: number) {
  const out: string[] = [];
  if (n >= 100) { out.push(HUNDREDS[Math.floor(n / 100)]); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; }
  if (n >= 10) { out.push(TEENS[n - 10]); n = 0; }
  if (n > 0) out.push(ONES[n]);
  return out.join(' و ');
}
/** An amount in Persian words, as written on Iranian invoices («... ریال»). */
export function inWords(v: bigint) {
  if (v === 0n) return 'صفر';
  const parts: string[] = [];
  for (let i = 0; v > 0n; i++, v /= 1000n) {
    const g = Number(v % 1000n);
    if (g) parts.unshift(`${under1000(g)}${SCALES[i] ? ' ' + SCALES[i] : ''}`);
  }
  return parts.join(' و ');
}

const dayFa = (d: Date | string) => new Date(d).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
const n = (s?: string | null) => (s ? BigInt(s) : 0n);

type Doc = Order & {
  payMode?: 'CASH' | 'TERM'; termMonths?: number;
  items: (Order['items'][number] & { listPrice?: string | null; salePct?: string | null })[];
  customer: { id: string; name: string; city?: string | null; address?: string | null; nationalId?: string | null; support?: { firstName: string | null; lastName: string | null; phone: string | null } | null };
};

/**
 * The customer's proforma as a document: letterhead, number and dates, buyer, lines with list price, discount and
 * net price, totals with the amount in words, payment terms and validity. The customer accepts it here.
 */
export function ProformaScreen({ id, token }: { id?: string; token?: string }) {
  const app = useApp() as ReturnType<typeof useApp> | null;
  const toast = app?.toast ?? ((t: string) => alert(t));
  const pub = !!token;
  const o = useApi<Doc>(pub ? `/public/proforma/${encodeURIComponent(token!)}` : `/orders/${encodeURIComponent(id!)}`);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  if (o.error) return <div className="empty">{o.error}</div>;
  if (!o.data) return <div className="skel" style={{ height: 600, margin: 16, borderRadius: 16 }} />;
  const d = o.data;
  const b = d.breakdown;
  const pf = d.proformas?.[0];
  const issued = pf?.issuedAt ?? d.createdAt;
  const mode = b?.mode ?? d.payMode ?? 'CASH';
  const months = b?.termMonths ?? d.termMonths ?? 0;
  const priced = !d.items.some(i => i.unitPrice === null);
  const total = n(d.payable ?? d.total);
  const final = !!pf && ['PROFORMA_SENT', 'SALES_APPROVED', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED'].includes(d.status);
  const due = new Date(new Date(issued).getTime() + months * 30 * 86400000);
  const support = d.customer.support ? personName(d.customer.support) : null;
  const inTelegram = !!tg()?.initData;
  /** A read-only link to this proforma, for the customer's accountant or to print as PDF in a browser. */
  const share = async (how: 'send' | 'open') => {
    setSharing(true);
    try {
      const { url } = await api<{ url: string }>(`/orders/${d.id}/share`, { method: 'POST' });
      const w = tg() as unknown as { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } | null;
      if (how === 'send') {
        const msg = `پیش‌فاکتور شماره ${d.number} اصفهان پلاست`;
        if (w?.openTelegramLink) w.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(msg)}`);
        else if (navigator.share) await navigator.share({ title: msg, url }).catch(() => {});
        else { await navigator.clipboard?.writeText(url); toast('لینک کپی شد'); }
      } else if (w?.openLink) w.openLink(url);
      else window.open(url, '_blank');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'لینک ساخته نشد'); } finally { setSharing(false); }
  };
  const send = async (ok: boolean) => {
    setBusy(true);
    try {
      await api(`/orders/${d.id}/accept`, { method: 'POST', body: { ok, comment: ok ? undefined : text.trim() || undefined } });
      haptic('success'); toast(ok ? 'پیش‌فاکتور تأیید شد' : 'درخواست تغییر برای کارشناس رفت'); setAsking(false); o.reload();
    } catch (e) { haptic('error'); toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  return (
    <>
      <article className="pfdoc" aria-label="پیش‌فاکتور">
        <header className="pf-h">
          <div className="pf-brand"><span className="pf-mark">iP</span><div><b>اصفهان پلاست</b><small>لوله و اتصالات پلی‌اتیلن · شیرآلات · تجهیزات آبیاری</small></div></div>
          <div className="pf-title"><h1>پیش‌فاکتور فروش</h1>{!final && <span className="pf-draft">پیش‌نویس، در انتظار قیمت‌گذاری کارشناس</span>}</div>
        </header>

        <dl className="pf-meta num">
          <div><dt>شماره</dt><dd>{fa(d.number)}{pf ? <small> / نسخه {fa(pf.version)}</small> : null}</dd></div>
          <div><dt>تاریخ صدور</dt><dd>{dayFa(issued)}</dd></div>
          <div><dt>نوع فروش</dt><dd>{payModeFa(mode, months)}</dd></div>
          {pf && d.status === 'PROFORMA_SENT' && <div><dt>معتبر تا</dt><dd>{new Date(pf.expiresAt).toLocaleString('fa-IR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>}
        </dl>

        <section className="pf-party">
          <div><span>خریدار</span><b>{d.customer.name}</b>{(d.customer.city || d.customer.address) && <small>{[d.customer.city, d.customer.address].filter(Boolean).join('، ')}</small>}{d.customer.nationalId && <small className="num">شناسه ملی / کد اقتصادی: {fa(d.customer.nationalId)}</small>}</div>
          <div><span>کارشناس فروش</span><b>{support ?? 'واحد فروش'}</b>{d.customer.support?.phone && <small className="num"><bdi>{d.customer.support.phone}</bdi></small>}</div>
        </section>

        <table className="pf-t num">
          <thead><tr><th>#</th><th className="l">شرح کالا</th><th>تعداد</th><th className="wide">فی لیست</th><th className="wide">تخفیف</th><th>فی (ریال)</th><th>مبلغ (ریال)</th></tr></thead>
          <tbody>
            {d.items.map((i, k) => {
              const unit = i.unitPrice === null ? null : BigInt(i.unitPrice);
              const list = i.listPrice ? BigInt(i.listPrice) : null;
              const off = unit !== null && list !== null && list > unit ? Number(((list - unit) * 10000n) / list) / 100 : 0;
              return (
                <tr key={i.id}>
                  <td>{fa(k + 1)}</td>
                  <td className="l">{i.title}{i.packs ? <small> · {fa(i.packs)} بسته</small> : null}
                    {list !== null && off > 0 && <small className="narrow">لیست {fa(list)}<br />{fa(off)}٪ تخفیف</small>}</td>
                  <td>{fa(i.quantity)}</td>
                  <td className="wide">{list !== null ? fa(list) : '—'}</td>
                  <td className="wide">{off ? `${fa(off)}٪` : '—'}</td>
                  <td>{unit === null ? <span className="tag warn">استعلامی</span> : fa(unit)}</td>
                  <td>{unit === null ? '—' : fa(unit * BigInt(i.quantity))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="pf-sum num">
          {b && n(b.saleDiscount) > 0n && <><div><span>جمع به قیمت لیست</span><span>{fa(b.listTotal!)}</span></div><div><span>تخفیف {payModeFa(mode)}</span><span><bdi>−{fa(b.saleDiscount!)}</bdi></span></div></>}
          {b && <div><span>جمع کالا</span><span>{fa(b.subtotal)}</span></div>}
          {b && n(b.discount) > 0n && <div><span>تخفیف ویژه</span><span><bdi>−{fa(b.discount)}</bdi></span></div>}
          {b && n(b.shipping) > 0n && <div><span>کرایه حمل</span><span>{fa(b.shipping)}</span></div>}
          <div className="tot"><span>{priced ? 'مبلغ قابل پرداخت' : 'جمع اقلام قیمت‌دار'}</span><span>{fa(total)} ریال</span></div>
          {priced && total > 0n && <p className="words">به حروف: {inWords(total)} ریال</p>}
        </section>

        <section className="pf-terms">
          <h2>شرایط پرداخت و تحویل</h2>
          <ul>
            {mode === 'TERM'
              ? <li className="num">پرداخت با چک به مبلغ {fa(n(b?.cheque) || total)} ریال با سررسید {fa(months)} ماه پس از صدور فاکتور{pf ? ` (حدود ${dayFa(due)})` : ''}{b && n(b.cash) > 0n ? `؛ کرایه حمل ${fa(b.cash)} ریال نقد` : ''}.</li>
              : <li>پرداخت نقد یا واریز به حساب شرکت، پیش از ارسال بار.</li>}
            {!priced && <li>قیمت اقلام «استعلامی» را کارشناس فروش اعلام می‌کند و در نسخه‌ی بعدی پیش‌فاکتور می‌آید.</li>}
            <li>قیمت‌ها بر اساس لیست قیمت روز شرکت است و تا تأیید نهایی و صدور فاکتور قطعی نیست.</li>
            {pf && d.status === 'PROFORMA_SENT' && <li className="num">این پیش‌فاکتور تا {new Date(pf.expiresAt).toLocaleString('fa-IR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} معتبر است.</li>}
            {d.note && <li>توضیح سفارش: {d.note}</li>}
          </ul>
        </section>

        <footer className="pf-f">
          {pf?.acceptedAt ? <span className="pf-stamp ok num">تأیید خریدار · {dayFa(pf.acceptedAt)}</span>
            : d.status === 'PROFORMA_SENT' ? <span className="pf-stamp">منتظر تأیید خریدار</span>
            : d.status === 'PROFORMA_EXPIRED' ? <span className="pf-stamp bad">منقضی شده</span> : null}
          {['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED'].includes(d.status) && <span className="pf-stamp ok">تأیید نهایی فروش</span>}
          <small>ثبت‌کننده: {personName(d.placedBy)} · سفارش #{fa(d.number)}</small>
        </footer>
      </article>

      {!pub && d.status === 'PROFORMA_SENT' && (
        <div className="pf-act">
          {asking ? (
            <>
              <textarea className="note-in" style={{ margin: 0 }} value={text} onChange={e => setText(e.target.value)} placeholder="چه تغییری می‌خواهید؟ (برای کارشناس فروش)" maxLength={500} autoFocus />
              <div className="btns"><button type="button" className="cta" disabled={busy || !text.trim()} onClick={() => send(false)}>ارسال درخواست تغییر</button><button type="button" className="cta ghost" onClick={() => setAsking(false)}>انصراف</button></div>
            </>
          ) : (
            <div className="btns">
              <button type="button" className="cta" disabled={busy} onClick={() => send(true)}><Icon n="check" s={18} />&nbsp; تأیید پیش‌فاکتور</button>
              <button type="button" className="cta ghost" disabled={busy} onClick={() => setAsking(true)}>تغییر می‌خواهم</button>
            </div>
          )}
        </div>
      )}
      <div className="pf-act">
        {!pub && <div className="btns">
          <button type="button" className="cta ghost" disabled={sharing} onClick={() => share('send')}>📤 ارسال برای حسابدار</button>
          {inTelegram
            ? <button type="button" className="cta ghost" disabled={sharing} onClick={() => share('open')}>🖨 PDF و چاپ</button>
            : <button type="button" className="cta ghost" onClick={() => print()}>🖨 چاپ / ذخیره PDF</button>}
        </div>}
        {pub && <button type="button" className="cta" onClick={() => print()}>🖨 چاپ / ذخیره PDF</button>}
        {!pub && <small className="pf-hint">لینک پیش‌فاکتور فقط‌خواندنی است و ۱۴ روز اعتبار دارد.</small>}
      </div>
    </>
  );
}
