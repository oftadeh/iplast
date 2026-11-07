import { useMemo, useRef, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dateFa, fa, getToken, rial, useApi } from '../lib';

interface PriceList { id: string; title: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; sourceFile: string | null; createdAt: string; publishedAt: string | null; _count?: { prices: number; importRows: number } }
interface Row {
  id: string; page: number | null; familyTitle: string | null; rawText: string; accountingCode: string | null; perPack: number | null;
  amount: string | null; match: 'MATCHED' | 'AMBIGUOUS' | 'NEW' | 'UNMATCHED'; variantId: string | null; resolvedBy: string | null;
  variant: { id: string; sku: string; title: string } | null; oldAmount: string | null; hadOld: boolean;
}
interface Detail { list: PriceList; counts: Partial<Record<Row['match'], number>>; changes: { up: number; down: number; same: number; toInquiry: number; fromInquiry: number }; activeList: { id: string; title: string } | null; missingVariants: number; duplicates: number; rows: Row[] }

const LIST_ST: Record<string, [string, string]> = { DRAFT: ['پیش‌نویس', 'ask'], ACTIVE: ['فعال', 'ok'], ARCHIVED: ['بایگانی', 'gray'] };
const MATCH_ST: Record<string, [string, string]> = { MATCHED: ['وصل شد', 'ok'], AMBIGUOUS: ['پیشنهادی، بررسی کنید', 'ask'], NEW: ['در کاتالوگ نیست', 'gray'], UNMATCHED: ['وصل نشد', 'no'] };

const changed = (r: Row) => !!r.variant && r.hadOld && r.amount !== r.oldAmount;
const FILTERS: [string, string, (r: Row) => boolean][] = [
  ['review', 'نیاز به بررسی', r => r.match === 'AMBIGUOUS' || r.match === 'UNMATCHED'],
  ['ai', 'کار هوش مصنوعی', r => r.resolvedBy === 'ai'],
  ['changed', 'تغییر قیمت', changed],
  ['matched', 'وصل‌شده', r => !!r.variant],
  ['new', 'در کاتالوگ نیست', r => r.match === 'NEW'],
  ['all', 'همه', () => true],
];

export function PricesPage() {
  const { me, toast } = useAdmin();
  const lists = useApi<PriceList[]>('/admin/prices/lists');
  const draft = lists.data?.find(l => l.status === 'DRAFT');
  const [sel, setSel] = useState<string | null>(null);
  const current = sel ?? draft?.id ?? null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const ai = useApi<{ enabled: boolean }>('/admin/prices/ai').data?.enabled ?? false;

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const qs = `?ai=${ai ? 1 : 0}${draft ? `&listId=${draft.id}` : ''}`;
      const r = await fetch(`/api/admin/prices/import${qs}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${getToken()}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j?.message ?? 'بارگذاری نشد');
      const n = fa(Object.values(j.counts as Record<string, number>).reduce((a, b) => a + b, 0));
      toast(j.ai ? `${n} ردیف خوانده شد؛ هوش مصنوعی ${fa(j.ai.matched + j.ai.suggested)} ردیف دیگر را هم وصل کرد` : `${n} ردیف از فایل خوانده شد`);
      setSel(j.list.id); lists.reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'بارگذاری نشد'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  return (
    <>
      <div className="head"><h1>به‌روزرسانی قیمت{ai ? <span className="st ai" style={{ marginInlineStart: 8, verticalAlign: 'middle' }}>هوش مصنوعی</span> : null}</h1>
        <div className="row">
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
          <button type="button" className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? (ai ? 'هوش مصنوعی در حال خواندن PDF… (تا یک دقیقه)' : 'در حال خواندن PDF…') : draft ? 'افزودن PDF دیگر به پیش‌نویس' : 'بارگذاری PDF لیست قیمت'}</button>
        </div>
      </div>
      <div className="note">
        <b>۱.</b> PDF لیست قیمت را بارگذاری کنید. {ai ? 'ردیف‌ها با «کد کالا» به سایزها وصل می‌شوند و هوش مصنوعی ردیف‌های بدون کد یا با کد تکراری را از روی نام و سایز وصل می‌کند؛ PDF اسکن‌شده را هم خودش می‌خواند.' : 'هر ردیف با «کد کالا» به سایز مربوطش وصل می‌شود.'}
        {' '}<b>۲.</b> تغییر قیمت‌ها و ردیف‌های «نیاز به بررسی» را نگاه کنید. <b>۳.</b> «انتشار» بزنید؛ از همان لحظه مشتریان قیمت جدید را می‌بینند. تا انتشار، لیست فعلی برقرار است.
      </div>

      {lists.data && lists.data.length > 0 && (
        <div className="card tablewrap">
          <table>
            <thead><tr><th>عنوان</th><th>وضعیت</th><th>فایل‌ها</th><th>قیمت‌ها</th><th>زمان</th></tr></thead>
            <tbody>{lists.data.map(l => (
              <tr key={l.id} className="click" aria-selected={l.id === current} onClick={() => setSel(l.id)}>
                <td><b>{l.title}</b></td>
                <td><span className={`st ${LIST_ST[l.status][1]}`}>{LIST_ST[l.status][0]}</span></td>
                <td className="small muted">{l.sourceFile ?? '—'}</td>
                <td className="num small">{l._count?.prices ? fa(l._count.prices) : '—'}</td>
                <td className="num small muted">{dateFa(l.publishedAt ?? l.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {current ? <ListDetail key={current} id={current} ai={ai} isAdmin={me.staffRole === 'ADMIN'} onChanged={() => { lists.reload(); }} onGone={() => { setSel(null); lists.reload(); }} />
        : lists.data && !lists.data.length && <div className="empty">هنوز لیستی بارگذاری نشده است.</div>}
    </>
  );
}

function ListDetail({ id, ai, isAdmin, onChanged, onGone }: { id: string; ai: boolean; isAdmin: boolean; onChanged: () => void; onGone: () => void }) {
  const { toast } = useAdmin();
  const d = useApi<Detail>(`/admin/prices/lists/${id}`);
  const [filter, setFilter] = useState('review');
  const [limit, setLimit] = useState(200);
  const [missing, setMissing] = useState<'keep' | 'inquiry'>('keep');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = useMemo(() => d.data?.rows.filter(FILTERS.find(f => f[0] === filter)![2]) ?? [], [d.data, filter]);
  if (d.error) return <div className="card pad err">{d.error}</div>;
  if (!d.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const x = d.data; const c = x.counts; const ch = x.changes;
  const draft = x.list.status === 'DRAFT';
  const linked = (c.MATCHED ?? 0) + (c.AMBIGUOUS ?? 0);

  const publish = async () => {
    if (!confirm(`«${x.list.title}» منتشر شود؟ از این لحظه مشتریان قیمت‌های این لیست را می‌بینند.`)) return;
    setBusy(true);
    try { await api(`/admin/prices/lists/${id}/publish`, { method: 'POST', body: { missing } }); toast('لیست قیمت منتشر شد'); d.reload(); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'منتشر نشد'); } finally { setBusy(false); }
  };
  const discard = async () => {
    if (!confirm('این پیش‌نویس حذف شود؟')) return;
    try { await api(`/admin/prices/lists/${id}`, { method: 'DELETE' }); toast('پیش‌نویس حذف شد'); onGone(); } catch (e) { toast(e instanceof ApiError ? e.message : 'حذف نشد'); }
  };
  const aiMatch = async () => {
    setBusy(true);
    try {
      const r = await api<{ checked: number; matched: number; suggested: number }>(`/admin/prices/lists/${id}/ai-match`, { method: 'POST' });
      toast(r.matched + r.suggested ? `هوش مصنوعی ${fa(r.matched)} ردیف را وصل کرد${r.suggested ? ` و ${fa(r.suggested)} پیشنهاد داد` : ''}` : 'ردیف مطمئن دیگری پیدا نشد');
      d.reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'انجام نشد'); } finally { setBusy(false); }
  };
  const resolve = async (rowId: string, variantId: string | null) => {
    try { await api(`/admin/prices/rows/${rowId}`, { method: 'PATCH', body: { variantId } }); setEditing(null); d.reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); }
  };

  return (
    <div className="stack">
      <div className="card pad stack">
        <div className="between"><h2>{x.list.title}</h2><span className={`st ${LIST_ST[x.list.status][1]}`}>{LIST_ST[x.list.status][0]}</span></div>
        <div className="row small">
          <span className="st ok">{fa(c.MATCHED ?? 0)} وصل شد</span>
          <span className="st ask">{fa(c.AMBIGUOUS ?? 0)} پیشنهادی</span>
          <span className="st no">{fa(c.UNMATCHED ?? 0)} وصل نشد</span>
          <span className="st gray">{fa(c.NEW ?? 0)} در کاتالوگ نیست</span>
        </div>
        {x.activeList && <p className="small" style={{ margin: 0 }}>
          در مقایسه با «{x.activeList.title}»: <b className="num">{fa(ch.up)}</b> گران‌تر، <b className="num">{fa(ch.down)}</b> ارزان‌تر، <b className="num">{fa(ch.same)}</b> بدون تغییر، <b className="num">{fa(ch.toInquiry)}</b> استعلامی شد، <b className="num">{fa(ch.fromInquiry)}</b> قیمت‌دار شد.
          {' '}<b className="num">{fa(x.missingVariants)}</b> سایز کاتالوگ در این فایل‌ها نیست.</p>}
        {x.duplicates > 0 && <div className="err">{fa(x.duplicates)} سایز به بیش از یک ردیف وصل شده است؛ در انتشار فقط ردیف آخر حساب می‌شود. آن‌ها را در «وصل‌شده» بررسی کنید.</div>}
        {(c.NEW ?? 0) > 0 && <p className="muted small" style={{ margin: 0 }}>ردیف‌های «در کاتالوگ نیست» کالاهایی هستند که هنوز در کاتالوگ مینی‌اپ تعریف نشده‌اند؛ با انتشار، قیمتشان جایی نمایش داده نمی‌شود.</p>}
        {draft && ai && ((c.UNMATCHED ?? 0) + (c.AMBIGUOUS ?? 0) + (c.NEW ?? 0) > 0) && (
          <button type="button" className="btn" disabled={busy} onClick={aiMatch}>{busy ? 'هوش مصنوعی در حال بررسی…' : '✨ وصل‌کردن ردیف‌های باقی‌مانده با هوش مصنوعی'}</button>
        )}
        {draft && (isAdmin ? (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div className="row small">
              <span>سایزهایی که در فایل نیستند:</span>
              <label className="row"><input type="radio" checked={missing === 'keep'} onChange={() => setMissing('keep')} /> قیمت فعلی بماند</label>
              <label className="row"><input type="radio" checked={missing === 'inquiry'} onChange={() => setMissing('inquiry')} /> «استعلامی» شوند</label>
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy || !linked} onClick={publish}>{busy ? 'در حال انتشار…' : `انتشار برای مشتریان (${fa(linked)} سایز)`}</button>
              <button type="button" className="btn danger" onClick={discard}>حذف پیش‌نویس</button>
            </div>
          </div>
        ) : <div className="note">بعد از بررسی، مدیر آن را منتشر می‌کند.</div>)}
      </div>

      <div className="chips">{FILTERS.map(([k, t, f]) => <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => { setFilter(k); setLimit(200); }}>{t}<span className="n num">{fa(x.rows.filter(f).length)}</span></button>)}</div>
      <div className="card tablewrap">
        {!rows.length ? <div className="empty" style={{ border: 0 }}>ردیفی در این دسته نیست.</div> : (
          <table>
            <thead><tr><th>ص</th><th>ردیف در PDF</th><th>کد کالا</th><th>قیمت جدید</th><th>قیمت فعلی</th><th>سایز در کاتالوگ</th></tr></thead>
            <tbody>{rows.slice(0, limit).map(r => {
              const diff = r.amount !== null && r.oldAmount !== null ? Number(BigInt(r.amount) - BigInt(r.oldAmount)) : 0;
              return (
                <tr key={r.id}>
                  <td className="num small muted">{r.page ? fa(r.page) : ''}</td>
                  <td><div className="small muted">{r.familyTitle}</div>{r.rawText}{r.perPack ? <span className="muted small num"> · {fa(r.perPack)} در بسته</span> : null}</td>
                  <td className="num small" dir="ltr" style={{ textAlign: 'right' }}>{r.accountingCode ?? '—'}</td>
                  <td className="num small"><b>{rial(r.amount)}</b>{diff !== 0 && <div className={`small`} style={{ color: diff > 0 ? 'var(--bad)' : 'var(--ok)' }}>{diff > 0 ? '▲' : '▼'} {fa(Math.abs(diff))}</div>}</td>
                  <td className="num small muted">{r.variant ? (r.hadOld ? rial(r.oldAmount) : '—') : ''}</td>
                  <td className="small">
                    {editing === r.id ? <VariantPicker onPick={v => resolve(r.id, v)} onCancel={() => setEditing(null)} /> : (
                      <div className="stack" style={{ gap: 4 }}>
                        <span>{r.resolvedBy === 'ai' ? <span className={`st ai`}>{r.match === 'AMBIGUOUS' ? 'پیشنهاد هوش مصنوعی' : 'هوش مصنوعی'}</span> : <span className={`st ${MATCH_ST[r.match][1]}`}>{r.resolvedBy ? 'دستی' : MATCH_ST[r.match][0]}</span>}</span>
                        {r.variant && <span>{r.variant.title}</span>}
                        {draft && <div className="row">
                          <button type="button" className="btn sm" onClick={() => setEditing(r.id)}>{r.variant ? 'تغییر' : 'انتخاب سایز'}</button>
                          {r.match === 'AMBIGUOUS' && <button type="button" className="btn sm" onClick={() => resolve(r.id, r.variantId)}>درست است</button>}
                          {r.variant && <button type="button" className="btn sm danger" onClick={() => resolve(r.id, null)}>جدا کردن</button>}
                        </div>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        {rows.length > limit && <div className="pad"><button type="button" className="btn" onClick={() => setLimit(limit + 300)}>نمایش بیشتر ({fa(rows.length - limit)})</button></div>}
      </div>
    </div>
  );
}

function VariantPicker({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const res = useApi<{ id: string; sku: string; title: string; accountingCode: string | null }[]>(q.trim().length >= 2 ? `/admin/prices/variants?q=${encodeURIComponent(q.trim())}` : null);
  return (
    <div className="stack" style={{ gap: 6, minWidth: 240 }}>
      <div className="row"><input className="in" autoFocus placeholder="نام کالا یا کد" value={q} onChange={e => setQ(e.target.value)} /><button type="button" className="btn sm" onClick={onCancel}>بستن</button></div>
      {res.data?.map(v => <button key={v.id} type="button" className="btn sm" style={{ textAlign: 'right' }} onClick={() => onPick(v.id)}>{v.title} <span className="muted num">{v.accountingCode ?? ''}</span></button>)}
      {res.data && !res.data.length && <span className="muted small">پیدا نشد</span>}
    </div>
  );
}
