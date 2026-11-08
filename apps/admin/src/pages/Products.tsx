import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, fa, getToken, rial, toEnDigits, useApi } from '../lib';

interface Row { id: string; name: string; isActive: boolean; model: string | null; category: { name: string }; media: { key: string }[]; sizes: number; priced: number; inactiveSizes: number }
interface Meta { categories: { id: string; name: string }[] }
interface Axis { id: string; name: string; unit: string | null }
interface Variant { id: string; title: string; accountingCode: string | null; perPack: number | null; isActive: boolean; options: Record<string, string>; price: string | null; priceStatus: 'PRICED' | 'INQUIRY' | null }
interface Product {
  id: string; slug: string; name: string; description: string | null; model: string | null; badge: string | null; unitName: string; packName: string | null; isActive: boolean;
  category: { id: string; name: string }; axes: Axis[]; media: { id: string; key: string; isPrimary: boolean }[]; synonyms: string[];
  variants: Variant[]; priceList: { id: string; title: string } | null;
}

const err = (e: unknown, f = 'ثبت نشد') => (e instanceof ApiError ? e.message : f);
const digits = (s: string | null) => (s ? fa(s) : '');

/** Products: find, define a new one, edit its details, sizes, pack counts, prices and photo. */
export function ProductsPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  if (focus === 'new') return <NewProduct onDone={id => onFocus(id)} onCancel={() => onFocus()} />;
  if (focus) return <ProductEditor key={focus} id={focus} onBack={() => onFocus()} />;
  return <ProductList onOpen={onFocus} />;
}

function ProductList({ onOpen }: { onOpen: (id: string) => void }) {
  const { me } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const meta = useApi<Meta>('/admin/products/meta');
  const list = useApi<Row[]>(`/admin/products?q=${encodeURIComponent(query)}&category=${cat}`);
  return (
    <>
      <div className="head"><h1>کالاها</h1>{me.staffRole === 'ADMIN' && <button type="button" className="btn primary" onClick={() => onOpen('new')}>+ کالای جدید</button>}</div>
      <div className="row">
        <input className="in search" placeholder="نام، مترادف یا کد کالا" value={q} onChange={e => setQ(e.target.value)} />
        <select className="in" value={cat} onChange={e => setCat(e.target.value)}>
          <option value="">همه‌ی دسته‌ها</option>
          {meta.data?.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {list.error ? <div className="err">{list.error}</div> : !list.data ? <div className="card pad muted">در حال بارگذاری…</div> : !list.data.length ? <div className="empty">کالایی پیدا نشد.</div> : (
        <div className="card plist">
          {list.data.map(p => (
            <button key={p.id} type="button" className="prow" onClick={() => onOpen(p.id)}>
              <span className="thumb">{p.media[0] ? <img src={'/' + p.media[0].key} alt="" loading="lazy" /> : null}</span>
              <span className="pinfo">
                <b>{p.name}{p.model ? <span className="muted small"> · {p.model}</span> : null}</b>
                <span className="muted small num">{p.category.name} · {fa(p.sizes)} سایز · {p.priced === p.sizes ? 'همه قیمت‌دار' : `${fa(p.priced)} قیمت‌دار`}</span>
              </span>
              {!p.isActive ? <span className="st gray">غیرفعال</span> : p.priced < p.sizes ? <span className="st ask">{fa(p.sizes - p.priced)} استعلامی</span> : null}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function NewProduct({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const meta = useApi<Meta>('/admin/products/meta');
  const [f, setF] = useState({ name: '', categoryId: '', newCategory: '', unitName: 'عدد', packName: 'کارتن', model: '', axes: 'سایز' });
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const save = async () => {
    setBusy(true); setE('');
    try {
      const p = await api<Product>('/admin/products', { method: 'POST', body: { ...f, categoryId: f.categoryId === '+' ? undefined : f.categoryId, newCategory: f.categoryId === '+' ? f.newCategory : undefined, axes: f.axes.split(/[،,]/) } });
      onDone(p.id);
    } catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="head"><h1>کالای جدید</h1><button type="button" className="btn" onClick={onCancel}>انصراف</button></div>
      <div className="card pad stack">
        <label className="f"><span>نام کالا</span><input className="in" value={f.name} onChange={set('name')} placeholder="مثلاً زانو نر پیچی" autoFocus /></label>
        <label className="f"><span>دسته‌بندی</span>
          <select className="in" value={f.categoryId} onChange={set('categoryId')}>
            <option value="">انتخاب کنید…</option>
            {meta.data?.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="+">+ دسته‌ی جدید</option>
          </select>
        </label>
        {f.categoryId === '+' && <label className="f"><span>نام دسته‌ی جدید</span><input className="in" value={f.newCategory} onChange={set('newCategory')} /></label>}
        <div className="row2">
          <label className="f"><span>واحد</span><input className="in" value={f.unitName} onChange={set('unitName')} placeholder="عدد / شاخه / متر" /></label>
          <label className="f"><span>بسته‌بندی</span><input className="in" value={f.packName} onChange={set('packName')} placeholder="کارتن / کیسه (خالی = ندارد)" /></label>
        </div>
        <label className="f"><span>مدل یا برند (اختیاری)</span><input className="in" value={f.model} onChange={set('model')} /></label>
        <label className="f"><span>سایز از چه تشکیل می‌شود؟</span><input className="in" value={f.axes} onChange={set('axes')} />
          <small className="muted">با «،» جدا کنید. مثلاً «سایز لوله، سایز رزوه» برای نری ۶۳ × ۲″. بعداً عوض نمی‌شود.</small></label>
        {e && <div className="err">{e}</div>}
        <button type="button" className="btn primary" disabled={busy || !f.name.trim() || !f.categoryId} onClick={save}>{busy ? 'در حال ثبت…' : 'ثبت و افزودن سایزها'}</button>
      </div>
    </>
  );
}

function ProductEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { me, toast } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const p = useApi<Product>(`/admin/products/${id}`);
  const meta = useApi<Meta>('/admin/products/meta');
  const fileRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (p.data) setInfo({ name: p.data.name, categoryId: p.data.category.id, unitName: p.data.unitName, packName: p.data.packName ?? '', model: p.data.model ?? '', description: p.data.description ?? '', synonyms: p.data.synonyms.join('، ') });
  }, [p.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (p.error) return <div className="err">{p.error}</div>;
  if (!p.data || !info) return <div className="card pad muted">در حال بارگذاری…</div>;
  const d = p.data;

  const patch = async (body: object, ok: string) => {
    setBusy(true);
    try { p.setData(await api<Product>(`/admin/products/${id}`, { method: 'PATCH', body })); toast(ok); } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  const saveInfo = () => patch({ ...info, synonyms: info.synonyms.split(/[،,]/) }, 'ذخیره شد');
  const photo = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData(); const img = await fitPhoto(file); fd.append('file', img, img === file ? file.name : 'photo.' + (img.type === 'image/webp' ? 'webp' : 'jpg'));
      const r = await fetch(`/api/admin/products/${id}/photo`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${getToken()}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j?.message ?? 'بارگذاری نشد');
      p.setData(j); toast('عکس ثبت شد');
    } catch (e) { toast(err(e, 'بارگذاری نشد')); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const set = (k: string) => (ev: { target: { value: string } }) => setInfo({ ...info, [k]: ev.target.value });
  const photoKey = d.media.find(m => m.isPrimary)?.key ?? d.media[0]?.key;

  return (
    <>
      <div className="head">
        <button type="button" className="btn sm" onClick={onBack}>→ کالاها</button>
        {can && <button type="button" className={`btn sm ${d.isActive ? 'danger' : ''}`} disabled={busy} onClick={() => patch({ isActive: !d.isActive }, d.isActive ? 'کالا از فروشگاه برداشته شد' : 'کالا در فروشگاه نمایش داده می‌شود')}>{d.isActive ? 'غیرفعال‌کردن' : 'فعال‌کردن'}</button>}
      </div>
      <div className="card pad stack">
        <div className="pedit-top">
          <button type="button" className="thumb big" disabled={!can || busy} onClick={() => fileRef.current?.click()} aria-label="تغییر عکس">
            {photoKey ? <img src={'/' + photoKey} alt="" /> : <span className="small muted">+ عکس</span>}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => e.target.files?.[0] && photo(e.target.files[0])} />
          <div className="stack" style={{ gap: 4 }}>
            <h1 style={{ fontSize: 19 }}>{d.name}</h1>
            <span className="muted small">{d.category.name}{!d.isActive && <span className="st gray" style={{ marginInlineStart: 6 }}>غیرفعال</span>}</span>
          </div>
        </div>
        <fieldset disabled={!can || busy} className="stack plain">
          <label className="f"><span>نام کالا</span><input className="in" value={info.name} onChange={set('name')} /></label>
          <label className="f"><span>دسته‌بندی</span><select className="in" value={info.categoryId} onChange={set('categoryId')}>{meta.data?.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <div className="row2">
            <label className="f"><span>واحد</span><input className="in" value={info.unitName} onChange={set('unitName')} /></label>
            <label className="f"><span>بسته‌بندی</span><input className="in" value={info.packName} onChange={set('packName')} placeholder="ندارد" /></label>
          </div>
          <label className="f"><span>مدل یا برند</span><input className="in" value={info.model} onChange={set('model')} /></label>
          <label className="f"><span>کلمات جست‌وجو (مترادف‌ها)</span><input className="in" value={info.synonyms} onChange={set('synonyms')} placeholder="نری، اتصال نر" />
            <small className="muted">دستیار سفارش و جست‌وجوی مینی‌اپ این کلمات را هم می‌شناسند.</small></label>
          <label className="f"><span>توضیحات</span><textarea className="in" value={info.description} onChange={set('description')} /></label>
          {can && <button type="button" className="btn primary" onClick={saveInfo}>ذخیره‌ی مشخصات</button>}
        </fieldset>
      </div>

      <div className="between"><h2>سایزها و قیمت <span className="muted small num">({fa(d.variants.length)})</span></h2><span className="muted small">{d.priceList?.title ?? 'لیست قیمت فعالی نیست'}</span></div>
      {can && <p className="note" style={{ margin: 0 }}>قیمت را به ریال وارد کنید و ✓ بزنید؛ همان لحظه برای مشتریان اعمال می‌شود. خالی = استعلامی.</p>}
      <div className="stack">
        {d.variants.map(v => <VariantRow key={v.id} v={v} p={d} can={can} onSaved={p.setData} />)}
        {!d.variants.length && <div className="empty">هنوز سایزی تعریف نشده است.</div>}
      </div>
      {can && <AddVariant p={d} onSaved={p.setData} />}
    </>
  );
}

function VariantRow({ v, p, can, onSaved }: { v: Variant; p: Product; can: boolean; onSaved: (p: Product) => void }) {
  const { toast } = useAdmin();
  const [price, setPrice] = useState(digits(v.price));
  const [code, setCode] = useState(v.accountingCode ?? '');
  const [pack, setPack] = useState(v.perPack ? fa(v.perPack) : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPrice(digits(v.price)); setCode(v.accountingCode ?? ''); setPack(v.perPack ? fa(v.perPack) : ''); }, [v.price, v.accountingCode, v.perPack]);
  const label = p.axes.map(a => v.options[a.id]).filter(Boolean).join(' × ') || v.title;
  const priceChanged = toEnDigits(price).replace(/[,،\s٬]/g, '') !== (v.price ?? '');
  const metaChanged = code !== (v.accountingCode ?? '') || toEnDigits(pack) !== (v.perPack ? String(v.perPack) : '');

  const run = async (f: () => Promise<Product>, ok: string) => {
    setBusy(true);
    try { onSaved(await f()); toast(ok); } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  const savePrice = () => run(() => api<Product>(`/admin/products/variants/${v.id}/price`, { method: 'PUT', body: { amount: toEnDigits(price).replace(/[,،\s٬]/g, '') || null } }), `قیمت ${label} ثبت شد`);
  const saveMeta = () => run(() => api<Product>(`/admin/products/variants/${v.id}`, { method: 'PATCH', body: { accountingCode: code, perPack: toEnDigits(pack) || null } }), 'ذخیره شد');
  const toggle = () => run(() => api<Product>(`/admin/products/variants/${v.id}`, { method: 'PATCH', body: { isActive: !v.isActive } }), v.isActive ? 'سایز غیرفعال شد' : 'سایز فعال شد');

  return (
    <div className={`card vrow ${v.isActive ? '' : 'off'}`}>
      <div className="between">
        <b className="num">{label}</b>
        <span className="small">{v.price ? <b className="num">{rial(v.price)}</b> : <span className="st ask">استعلامی</span>}</span>
      </div>
      {can ? (
        <>
          <div className="pricebox">
            <input className="in num" dir="ltr" inputMode="numeric" placeholder="قیمت (ریال)" value={price} onChange={e => setPrice(e.target.value)}
              onBlur={() => { const n = toEnDigits(price).replace(/[,،\s٬]/g, ''); if (/^\d+$/.test(n)) setPrice(fa(n)); }} />
            <button type="button" className="btn ok-fill sm" disabled={busy || !priceChanged} onClick={savePrice}>✓</button>
          </div>
          <div className="row2">
            <label className="f"><span>کد کالا</span><input className="in num" dir="ltr" value={code} onChange={e => setCode(e.target.value)} /></label>
            <label className="f"><span>تعداد در {p.packName ?? 'بسته'}</span><input className="in num" dir="ltr" inputMode="numeric" value={pack} onChange={e => setPack(e.target.value)} /></label>
          </div>
          <div className="row">
            {metaChanged && <button type="button" className="btn sm primary" disabled={busy} onClick={saveMeta}>ذخیره</button>}
            <button type="button" className="btn sm ghost" disabled={busy} onClick={toggle}>{v.isActive ? 'غیرفعال‌کردن این سایز' : 'فعال‌کردن'}</button>
          </div>
        </>
      ) : (
        <span className="muted small num">کد {v.accountingCode ?? '—'} · {v.perPack ? `${fa(v.perPack)} در ${p.packName ?? 'بسته'}` : 'بدون بسته‌بندی'}</span>
      )}
    </div>
  );
}

function AddVariant({ p, onSaved }: { p: Product; onSaved: (p: Product) => void }) {
  const { toast } = useAdmin();
  const empty = () => ({ options: Object.fromEntries(p.axes.map(a => [a.id, ''])) as Record<string, string>, code: '', pack: '', price: '' });
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const ready = p.axes.every(a => f.options[a.id]?.trim());
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api<Product>(`/admin/products/${p.id}/variants`, { method: 'POST', body: { options: f.options, accountingCode: f.code, perPack: toEnDigits(f.pack) || null, price: toEnDigits(f.price).replace(/[,،\s٬]/g, '') } }));
      setF(empty()); toast('سایز اضافه شد');
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card pad stack">
      <h2>+ سایز جدید</h2>
      <div className="row2">
        {p.axes.map(a => <label key={a.id} className="f"><span>{a.name}</span><input className="in num" value={f.options[a.id]} onChange={e => setF({ ...f, options: { ...f.options, [a.id]: e.target.value } })} placeholder="۶۳" /></label>)}
      </div>
      <div className="row2">
        <label className="f"><span>کد کالا</span><input className="in num" dir="ltr" value={f.code} onChange={e => setF({ ...f, code: e.target.value })} /></label>
        <label className="f"><span>تعداد در {p.packName ?? 'بسته'}</span><input className="in num" dir="ltr" inputMode="numeric" value={f.pack} onChange={e => setF({ ...f, pack: e.target.value })} /></label>
      </div>
      <label className="f"><span>قیمت (ریال، خالی = استعلامی)</span><input className="in num" dir="ltr" inputMode="numeric" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></label>
      <button type="button" className="btn primary" disabled={busy || !ready} onClick={save}>افزودن سایز</button>
    </div>
  );
}

/**
 * Phone photos are often over the 5 MB limit or in a format the server does not take (HEIC). Small JPG/PNG/WebP
 * files go as they are (keeping a transparent background); anything else is resized to 1600px and re-encoded as
 * WebP (keeps transparency), or JPEG on a white background where the browser cannot write WebP.
 */
async function fitPhoto(f: File): Promise<Blob> {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size <= 3 * 1024 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d')!;
    const blob = (type: string, q: number) => new Promise<Blob | null>(ok => c.toBlob(ok, type, q));
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const webp = await blob('image/webp', 0.9);
    if (webp && webp.type === 'image/webp') return webp;
    g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    return (await blob('image/jpeg', 0.88)) ?? f;
  } catch { return f; }
}
