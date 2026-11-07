import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dateFa, fa, useApi } from '../lib';

interface Sent { id: string; audience: string; audienceFa: string; text: string; recipients: number; sent: number; failed: number; createdAt: string }
interface Customer { id: string; name: string; city: string | null; isApproved: boolean }

const AUD = [
  { id: 'customers', title: 'همه‌ی مشتریان', help: 'هر کس فروشگاه را در ربات باز کرده' },
  { id: 'customer', title: 'یک مشتری', help: 'همه‌ی کاربرانِ یک شرکت' },
  { id: 'sales', title: 'کارشناسان فروش', help: 'همه‌ی کارشناسان فعال' },
  { id: 'staff', title: 'همه‌ی کارکنان', help: 'مدیران، کارشناسان و انبار' },
];

/** The manager sends a message or announcement; it arrives in each person's chat with the bot. */
export function MessagesPage() {
  const { toast } = useAdmin();
  const [aud, setAud] = useState('customers');
  const [cust, setCust] = useState('');
  const [text, setText] = useState('');
  const [btn, setBtn] = useState(true);
  const [busy, setBusy] = useState(false);
  const customers = useApi<Customer[]>(aud === 'customer' ? '/admin/customers' : null);
  const ready = aud !== 'customer' || !!cust;
  const count = useApi<{ count: number }>(ready ? `/admin/broadcasts/count?audience=${aud}${aud === 'customer' ? `&customerId=${cust}` : ''}` : null);
  const history = useApi<Sent[]>('/admin/broadcasts');
  const forCustomers = aud === 'customers' || aud === 'customer';
  // counts of a message still going out are refreshed until it finishes
  const going = (history.data ?? []).some(h => h.sent + h.failed < h.recipients);
  useEffect(() => { if (!going) return; const t = setInterval(history.reload, 2500); return () => clearInterval(t); }, [going]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const n = count.data?.count ?? 0;
    if (!confirm(`این پیام برای ${fa(n)} نفر در ربات فرستاده شود؟`)) return;
    setBusy(true);
    try {
      const r = await api<{ recipients: number }>('/admin/broadcasts', { method: 'POST', body: { audience: aud, customerId: aud === 'customer' ? cust : undefined, text, withButton: forCustomers && btn } });
      toast(`در حال ارسال برای ${fa(r.recipients)} نفر`); setText(''); history.reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ارسال نشد'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="head"><h1>پیام و اعلان</h1></div>
      <section className="card pad stack">
        <div className="f"><span className="muted small">گیرنده</span>
          <div className="seg2">{AUD.map(a => <button key={a.id} type="button" aria-pressed={aud === a.id} onClick={() => setAud(a.id)}><b>{a.title}</b><small>{a.help}</small></button>)}</div>
        </div>
        {aud === 'customer' && (
          <label className="f"><span>مشتری</span>
            <select className="in" value={cust} onChange={e => setCust(e.target.value)}>
              <option value="">انتخاب کنید…</option>
              {(customers.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ''}</option>)}
            </select>
          </label>
        )}
        <label className="f"><span>متن پیام</span><textarea className="in" rows={6} value={text} onChange={e => setText(e.target.value)} maxLength={3500} placeholder={forCustomers ? 'مثلاً: لیست قیمت آذر ۱۴۰۵ منتشر شد. قیمت‌های جدید در فروشگاه است.' : 'مثلاً: جلسه‌ی فروش شنبه ساعت ۱۰'} /></label>
        {forCustomers && <label className="row small"><input type="checkbox" checked={btn} onChange={e => setBtn(e.target.checked)} /> دکمه‌ی «باز کردن فروشگاه» زیر پیام</label>}
        <div className="preview">
          <span className="muted small">پیش‌نمایش در ربات</span>
          <div className="bubble"><b>{forCustomers ? '📢 پیام اصفهان پلاست' : '📢 پیام مدیریت'}</b>{'\n\n'}{text || '…'}</div>
          {forCustomers && btn && <div className="bubble-btn">🛒 باز کردن فروشگاه</div>}
        </div>
        <button type="button" className="btn primary" disabled={busy || text.trim().length < 2 || !ready || !count.data?.count} onClick={send}>
          {busy ? 'در حال ارسال…' : `ارسال برای ${count.data ? fa(count.data.count) : '…'} نفر`}
        </button>
      </section>
      <section className="stack">
        <h2>پیام‌های فرستاده‌شده</h2>
        {!history.data ? <div className="card pad muted">در حال بارگذاری…</div> : !history.data.length ? <div className="empty">هنوز پیامی فرستاده نشده است.</div> : (
          <div className="card plist">
            {history.data.map(h => (
              <div key={h.id} className="prow static" style={{ alignItems: 'start' }}>
                <span className="pinfo"><b>{h.audienceFa}</b><span className="small clamp">{h.text}</span><span className="muted small num">{dateFa(h.createdAt)}</span></span>
                <span className="small num" style={{ textAlign: 'left' }}>{h.sent + h.failed < h.recipients ? <span className="st new">در حال ارسال {fa(h.sent)}/{fa(h.recipients)}</span> : <span className="st ok">{fa(h.sent)} رسید</span>}{h.failed ? <><br /><span className="muted">{fa(h.failed)} نرسید</span></> : null}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted small" style={{ margin: 0 }}>پیام فقط به کسانی می‌رسد که یک بار ربات را استارت کرده‌اند و آن را مسدود نکرده‌اند.</p>
      </section>
    </>
  );
}
