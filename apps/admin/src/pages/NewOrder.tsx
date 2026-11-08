import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, fa, toEnDigits, useApi } from '../lib';

interface Cust { id: string; name: string; city: string | null; isApproved: boolean; support: { id: string; firstName: string | null; lastName: string | null } | null }
interface Hit { variantId: string; name: string; label: string; perPack: number | null; packName: string | null; unitName: string; list: string | null; price: string | null }
interface Line extends Hit { n: string; pack: boolean }

const qtyOf = (l: Line) => { const n = Number(toEnDigits(l.n)) || 0; return l.pack && l.perPack ? n * l.perPack : n; };

/**
 * «ثبت سفارش تلفنی»: the agent enters a customer's phone order. It goes into the normal steps (pricing → proforma
 * sent to the customer in the bot → customer accepts → final approval), so the customer gets used to the app.
 */
export function NewOrderPage() {
  const { me, toast, open } = useAdmin();
  const customers = useApi<Cust[]>('/admin/customers');
  const [cid, setCid] = useState('');
  const [cq, setCq] = useState('');
  const [mode, setMode] = useState<'CASH' | 'TERM'>('CASH');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const mineOnly = me.staffRole === 'SALES';
  const list = (customers.data ?? []).filter(c => (!mineOnly || !c.support || c.support.id === me.id) && (!cq.trim() || c.name.includes(cq.trim()) || (c.city ?? '').includes(cq.trim())));
  const cust = customers.data?.find(c => c.id === cid);

  // search sizes as the agent types (priced for this customer and sale type)
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      api<Hit[]>(`/admin/orders/variants?q=${encodeURIComponent(q.trim())}${cid ? `&customerId=${cid}` : ''}&mode=${mode}`).then(setHits, () => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, cid, mode]);
  // re-price the chosen lines when the customer or sale type changes
  useEffect(() => {
    if (!lines.length) return;
    let live = true;
    Promise.all(lines.map(l => api<Hit[]>(`/admin/orders/variants?q=${encodeURIComponent(`${l.name} ${l.label}`)}${cid ? `&customerId=${cid}` : ''}&mode=${mode}`).then(r => r.find(h => h.variantId === l.variantId)).catch(() => undefined)))
      .then(r => live && setLines(ls => ls.map((l, i) => (r[i] ? { ...l, price: r[i]!.price, list: r[i]!.list } : l))));
    return () => { live = false; };
  }, [cid, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (h: Hit) => {
    setLines(ls => (ls.some(l => l.variantId === h.variantId) ? ls : [...ls, { ...h, n: '1', pack: !!h.perPack }]));
    setQ(''); setHits([]);
  };
  const set = (i: number, p: Partial<Line>) => setLines(ls => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const total = lines.reduce((a, l) => a + (l.price ? BigInt(l.price) * BigInt(qtyOf(l)) : 0n), 0n);
  const ok = !!cid && lines.length > 0 && lines.every(l => qtyOf(l) > 0);

  const submit = async () => {
    setBusy(true);
    try {
      const o = await api<{ number: number }>('/admin/orders', { method: 'POST', body: { customerId: cid, payMode: mode, note: note.trim() || undefined, items: lines.map(l => ({ variantId: l.variantId, quantity: qtyOf(l), packs: l.pack && l.perPack ? Number(toEnDigits(l.n)) : undefined })) } });
      toast(`سفارش #${fa(o.number)} ثبت شد؛ حالا قیمت‌گذاری و ارسال پیش‌فاکتور`);
      setLines([]); setNote('');
      open('orders/agent');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="head"><h1>ثبت سفارش تلفنی</h1><span className="muted small">سفارشی که مشتری تلفنی یا حضوری داده؛ پیش‌فاکتورش در ربات برای خودش می‌رود</span></div>
      <div className="neworder">
        <section className="card pad stack">
          <h2>۱. مشتری</h2>
          {!cust ? (
            <>
              <input className="in" placeholder="جست‌وجوی نام یا شهر" value={cq} onChange={e => setCq(e.target.value)} />
              <div className="pick">
                {!customers.data ? <span className="muted small">در حال بارگذاری…</span> : list.length === 0 ? <span className="muted small">مشتری پیدا نشد.</span> :
                  list.slice(0, 30).map(c => <button key={c.id} type="button" onClick={() => setCid(c.id)}><b>{c.name}</b><small>{c.city ?? ''}</small></button>)}
              </div>
            </>
          ) : (
            <div className="between"><span><b>{cust.name}</b> <span className="muted small">{cust.city ?? ''}</span></span><button type="button" className="btn sm" onClick={() => setCid('')}>تغییر</button></div>
          )}
          <h2 style={{ marginTop: 8 }}>۲. نوع فروش</h2>
          <div className="seg" role="group">
            <button type="button" aria-pressed={mode === 'CASH'} onClick={() => setMode('CASH')}>نقدی</button>
            <button type="button" aria-pressed={mode === 'TERM'} onClick={() => setMode('TERM')}>مدت‌دار</button>
          </div>
          <span className="muted small">قیمت‌ها با درصد همین مشتری برای این نوع فروش حساب می‌شود.</span>
        </section>

        <section className="card pad stack">
          <h2>۳. اقلام</h2>
          <div className="searchpick">
            <input className="in" placeholder="نام کالا یا سایز، مثلاً «نری ۶۳» یا «سه‌راه ۵۰»" value={q} onChange={e => setQ(e.target.value)} />
            {hits.length > 0 && (
              <div className="hits">{hits.map(h => (
                <button key={h.variantId} type="button" onClick={() => add(h)}>
                  <span><b>{h.name}</b> {h.label}</span>
                  <span className="num small">{h.price ? `${fa(h.price)} ریال` : <span className="muted">استعلامی</span>}</span>
                </button>
              ))}</div>
            )}
          </div>
          {lines.length === 0 ? <div className="muted small" style={{ padding: '12px 0' }}>هنوز قلمی اضافه نشده است.</div> : (
            <div className="tablewrap"><table className="lines">
              <thead><tr><th>کالا</th><th>تعداد</th><th>فی (ریال)</th><th>مبلغ</th><th /></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={l.variantId}>
                  <td><b>{l.name}</b> <span className="small">{l.label}</span></td>
                  <td className="nowrap">
                    <input className="in num qty" inputMode="numeric" value={l.n} onChange={e => set(i, { n: e.target.value })} />
                    {l.perPack ? <select className="in unit" value={l.pack ? 'p' : 'u'} onChange={e => set(i, { pack: e.target.value === 'p' })}><option value="p">{l.packName ?? 'بسته'} ({fa(l.perPack)})</option><option value="u">{l.unitName}</option></select> : <span className="small muted"> {l.unitName}</span>}
                  </td>
                  <td className="num">{l.price ? fa(l.price) : <span className="st ask">استعلامی</span>}</td>
                  <td className="num">{l.price ? fa(BigInt(l.price) * BigInt(qtyOf(l))) : '—'}</td>
                  <td><button type="button" className="btn sm danger" aria-label="حذف" onClick={() => setLines(ls => ls.filter((_, k) => k !== i))}>✕</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <label className="stack small">توضیح سفارش<textarea className="in" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="محل تحویل، زمان ارسال…" maxLength={1000} /></label>
          <div className="between">
            <span>جمع تقریبی: <b className="num">{fa(total)}</b> ریال</span>
            <button type="button" className="btn primary" disabled={!ok || busy} onClick={submit}>{busy ? 'در حال ثبت…' : 'ثبت سفارش و رفتن به قیمت‌گذاری'}</button>
          </div>
          <span className="muted small">بعد از ثبت، در «منتظر کارشناس» قیمت‌ها را نهایی کنید تا پیش‌فاکتور در ربات برای مشتری برود و همان‌جا تأیید کند.</span>
        </section>
      </div>
    </>
  );
}
