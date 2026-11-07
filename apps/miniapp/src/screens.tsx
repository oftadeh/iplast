import { useEffect, useMemo, useState } from 'react';
import { useApp } from './App';
import { Icon, Photo } from './icons';
import { Picker } from './Picker';
import {
  ApiError, Category, Family, FamilyCard, Order, ROLE_FA, api, apiForm, fa, lineTotal, lineUnits, personName, photoUrl, short, useApi,
} from './lib';
import { BOT_USERNAME, haptic, openSupportChat } from './telegram';

const cardPhoto = (f: FamilyCard) => photoUrl(f.media[0]?.key);
const badgeCls = (b: string) => (b === 'جدید' ? 'new' : b === 'پرفروش' ? 'hot' : 'pick');

function PCard({ f, withAdd }: { f: FamilyCard; withAdd?: boolean }) {
  const { go, quickAdd } = useApp();
  return (
    <div className="pcard">
      <button type="button" className="pimg" aria-label={f.name} onClick={() => (withAdd ? quickAdd(f.slug) : go({ name: 'product', slug: f.slug }))}>
        <Photo src={cardPhoto(f)} />
        {f.badge && <span className={`tag ${badgeCls(f.badge)} flag`}>{f.badge}</span>}
        <span className="sizes num">{fa(f.sizeCount)} سایز</span>
      </button>
      {withAdd && <button type="button" className="add-mini" style={{ position: 'relative', marginTop: -50, marginInlineStart: 'auto', marginInlineEnd: 8 }} aria-label={`افزودن ${f.name}`} onClick={() => quickAdd(f.slug)}><Icon n="plus" s={18} /></button>}
      <button type="button" className="link" style={{ color: 'inherit', textAlign: 'right', fontWeight: 'inherit' }} onClick={() => go({ name: 'product', slug: f.slug })}><b>{f.name}</b></button>
      <span className="pr num">{f.minPrice ? <>از <strong>{fa(f.minPrice)}</strong> ریال</> : <span className="tag warn">استعلامی</span>}</span>
    </div>
  );
}

function Loading({ h = 160 }: { h?: number }) { return <div className="pad"><div className="skel" style={{ height: h }} /></div>; }
function Failed({ msg, retry }: { msg: string; retry: () => void }) {
  return <div className="empty">{msg}<br /><br /><button type="button" className="cta ghost" onClick={retry}>تلاش دوباره</button></div>;
}
function LoginNeeded({ what }: { what: string }) {
  return <div className="notice">برای {what}، مینی‌اپ را از داخل ربات <bdi>@{BOT_USERNAME}</bdi> در تلگرام باز کنید.</div>;
}

// ───────── home ─────────
export function HomeScreen() {
  const { go, me, aiEnabled } = useApp();
  const cats = useApi<Category[]>('/catalog/categories');
  const fams = useApi<FamilyCard[]>('/catalog/families');
  const [q, setQ] = useState('');

  const tiles = useMemo(() => {
    if (!cats.data) return [];
    const sorted = [...cats.data].sort((a, b) => (b._count.families > 0 ? 1 : 0) - (a._count.families > 0 ? 1 : 0) || a.sortOrder - b.sortOrder);
    return sorted.slice(0, 8).map((c, i) => ({ c, size: i === 0 ? 'big' : i === 5 ? 'wide' : '', photo: photoUrl(fams.data?.find(f => f.category.slug === c.slug && f.media[0])?.media[0].key) }));
  }, [cats.data, fams.data]);
  const featured = useMemo(() => (fams.data ? [...fams.data].sort((a, b) => (b.badge ? 1 : 0) - (a.badge ? 1 : 0)).filter(f => f.media[0]).slice(0, 8) : []), [fams.data]);
  const hero = fams.data?.find(f => f.slug === 'elbow' && f.media[0]) ?? fams.data?.find(f => f.media[0]);
  const hasList = fams.data?.some(f => f.minPrice);

  return (
    <>
      <section className="hero">
        <p className="hi">{me?.firstName ? `سلام ${me.firstName}، خوش آمدید` : 'سلام، خوش آمدید'}</p>
        <h1>اصفهان پلاست، <em>هرآنچه</em> می‌خواهید</h1>
        {hero && <img className="photo hero-photo" src={photoUrl(hero.media[0].key)!} alt="" />}
        <div className="row">
          <button type="button" className="pill white" onClick={() => go({ name: 'catalog' })}>مشاهده محصولات</button>
          <button type="button" className="pill glass" onClick={() => (aiEnabled ? go({ name: 'assistant' }) : openSupportChat())}><Icon n="mic" s={16} /> سفارش سریع</button>
        </div>
        {hasList && <span className="stamp"><i />لیست قیمت فعال است</span>}
      </section>
      <form className="searchwrap" onSubmit={e => { e.preventDefault(); if (q.trim()) go({ name: 'catalog', q: q.trim() }); }}>
        <label className="search"><Icon n="search" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="نری، فیلتر دیسکی، نیوفیت…" aria-label="جست‌وجو" enterKeyHint="search" /><span className="kbd">مترادف‌ها را می‌فهمد</span></label>
      </form>
      {me?.staffRole && (
        <a className="staff-entry" href="/admin/">
          <Icon n="grid" s={18} /><span><b>پنل مدیریت</b><small>سفارش‌ها، مشتریان، لیست قیمت{me.staffRole === 'ADMIN' ? '، کارشناسان' : ''}</small></span><Icon n="arrow" s={16} />
        </a>
      )}
      <div className="quick">
        <button type="button" onClick={() => go({ name: 'orders' })}><span className="i"><Icon n="truck" s={15} /></span>پیگیری سفارش</button>
        <button type="button" onClick={() => go({ name: 'cart' })}><span className="i"><Icon n="cart" s={15} /></span>سبد سفارش</button>
        <button type="button" onClick={openSupportChat}><span className="i"><Icon n="chat" s={15} /></span>پیام به کارشناس فروش</button>
      </div>

      <div className="sec"><h2>دسته‌بندی‌ها</h2><button type="button" onClick={() => go({ name: 'catalog' })}>همه</button></div>
      {cats.error ? <Failed msg="اتصال به سرور برقرار نشد." retry={cats.reload} /> : !cats.data ? <Loading h={250} /> : (
        <div className="bento">
          {tiles.map(({ c, size, photo }) => (
            <button key={c.id} type="button" className={`tile ${size} ${c._count.families ? '' : 'soon'}`} onClick={() => go({ name: 'catalog', cat: c.slug })}>
              <b>{c.name}</b><small className="num">{c._count.families ? `${fa(c._count.families)} خانواده محصول` : 'به‌زودی'}</small>
              <span className="go"><Icon n="arrow" s={14} /></span>
              <Photo src={photo} />
            </button>
          ))}
        </div>
      )}

      {featured.length > 0 && <>
        <div className="sec"><h2>منتخب و جدید</h2><button type="button" onClick={() => go({ name: 'catalog' })}>بیشتر</button></div>
        <div className="rail-x">{featured.map(f => <PCard key={f.id} f={f} />)}</div>
      </>}

      <section className="factory">
        <h3>سفارش بدون باز کردن مینی‌اپ</h3>
        <p>در همین ربات متن، پیام صوتی، عکس یا فایل PDF سفارش را بفرستید؛ مستقیم به کارشناس فروش شما می‌رسد و پاسخ همان‌جا می‌آید.</p>
        <button type="button" className="pill white" style={{ position: 'relative' }} onClick={openSupportChat}><Icon n="chat" s={16} /> رفتن به گفتگو</button>
      </section>
    </>
  );
}

// ───────── catalog ─────────
export function CatalogScreen({ cat, q }: { cat?: string; q?: string }) {
  const { go } = useApp();
  const cats = useApi<Category[]>('/catalog/categories');
  const [text, setText] = useState(q ?? '');
  const [query, setQuery] = useState(q ?? '');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const active = cat ?? cats.data?.find(c => c._count.families > 0)?.slug;
  const path = query ? `/catalog/families?q=${encodeURIComponent(query)}` : active ? `/catalog/families?category=${encodeURIComponent(active)}` : null;
  const fams = useApi<FamilyCard[]>(path);

  return (
    <>
      <div className="top"><h1>محصولات</h1>
        <label className="search"><Icon n="search" /><input value={text} onChange={e => setText(e.target.value)} placeholder="جست‌وجو در محصولات" aria-label="جست‌وجو" enterKeyHint="search" /></label>
      </div>
      <div className="chips">
        {cats.data?.map(c => (
          <button key={c.id} type="button" className="chip" aria-pressed={!query && c.slug === active} onClick={() => { setText(''); setQuery(''); go({ name: 'catalog', cat: c.slug }, true); }}>{c.name}</button>
        ))}
      </div>
      {fams.error ? <Failed msg="اتصال به سرور برقرار نشد." retry={fams.reload} /> : !fams.data ? <Loading h={420} /> : fams.data.length ? (
        <div className="grid">{fams.data.map(f => <PCard key={f.id} f={f} withAdd />)}</div>
      ) : (
        <div className="empty">{query ? 'در کاتالوگ پیدا نشد. می‌توانید در ربات برای کارشناس فروش پیام بفرستید.' : 'لیست قیمت این دسته هنوز وارد نشده است.'}</div>
      )}
    </>
  );
}

// ───────── product ─────────
export function ProductScreen({ slug }: { slug: string }) {
  const { add, go } = useApp();
  const f = useApi<Family>(`/catalog/families/${encodeURIComponent(slug)}`);
  const rel = useApi<FamilyCard[]>(f.data ? `/catalog/families?category=${encodeURIComponent(f.data.category.slug)}` : null);
  if (f.error) return <Failed msg="این محصول پیدا نشد." retry={f.reload} />;
  if (!f.data) return <><div className="skel" style={{ height: 330, borderRadius: '0 0 36px 36px' }} /><Loading h={300} /></>;
  const p = f.data;
  const img = photoUrl((p.media as { key: string; isPrimary?: boolean }[]).find(m => m.isPrimary)?.key ?? p.media[0]?.key);
  const others = rel.data?.filter(x => x.slug !== slug).slice(0, 6) ?? [];
  return (
    <>
      <div className="pd-hero"><Photo src={img} />{!img && <span className="cap">عکس این محصول به‌زودی اضافه می‌شود</span>}</div>
      <div className="pad" style={{ display: 'grid', gap: 18 }}>
        <div className="pd-title"><span className="crumb">{p.category.name}{p.brand ? ` · ${p.brand.name}` : ''}{p.model ? ` · ${p.model}` : ''}</span><h1>{p.name}</h1></div>
        {p.description && <p style={{ margin: 0, color: 'var(--muted)' }}>{p.description}</p>}
        <Picker f={p} onAdd={l => { add(l); }} />
        {!!p.specs?.length && <div className="stats">{p.specs.map(([a, b]) => <div key={a}><span>{a}</span><b>{b}</b></div>)}</div>}
        <button type="button" className="cta ghost" onClick={() => go({ name: 'cart' })}><Icon n="cart" s={18} />&nbsp; مشاهده سبد</button>
      </div>
      {others.length > 0 && <><div className="sec"><h2>مرتبط</h2></div><div className="rail-x">{others.map(r => <PCard key={r.id} f={r} />)}</div></>}
    </>
  );
}

// ───────── cart ─────────
export function CartScreen() {
  const { cart, setCart, go, me, authed, reloadMe, toast } = useApp();
  const accounts = me?.accounts.filter(a => a.role !== 'VIEWER') ?? [];
  const [acct, setAcct] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newCity, setNewCity] = useState('');
  const [note, setNote] = useState('');
  const [prices, setPrices] = useState<Record<string, string | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [idem] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()));

  useEffect(() => { if (!acct && accounts[0]) setAcct(accounts[0].customerId); }, [accounts, acct]);
  const account = accounts.find(a => a.customerId === acct);
  const idsKey = cart.map(c => c.variantId).join(',');
  // personal prices of this customer (falls back to the list price on the server)
  useEffect(() => {
    if (!authed || !cart.length) { setPrices(null); return; }
    api<Record<string, string | null>>('/me/quote', { method: 'POST', body: { variantIds: cart.map(c => c.variantId), customerId: acct || undefined } }).then(setPrices, () => setPrices(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, idsKey, acct]);

  if (!cart.length) return (<><div className="top"><h1>سبد سفارش</h1></div><div className="empty">سبد خالی است.<br /><br /><button type="button" className="cta" style={{ justifyContent: 'center' }} onClick={() => go({ name: 'catalog' })}>رفتن به محصولات</button></div></>);

  const lines = cart.map(l => ({ ...l, price: prices && l.variantId in prices ? prices[l.variantId] : l.price }));
  const total = lines.reduce((s, l) => s + (lineTotal(l) ?? 0n), 0n);
  const inq = lines.filter(l => l.price === null).length;
  const cashPct = account?.terms.cashPercent ?? 100;
  const cash = (total * BigInt(cashPct)) / 100n;
  const upd = (i: number, patch: Partial<typeof cart[number]>) => setCart(cart.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  const submit = async () => {
    setErr('');
    if (!accounts.length && !newName.trim()) { setErr('نام فروشگاه یا شرکت را وارد کنید'); return; }
    setBusy(true);
    try {
      const o = await api<{ id: string; number: number }>('/orders', {
        method: 'POST',
        body: {
          ...(accounts.length ? { customerId: acct } : { newCustomer: { name: newName.trim(), city: newCity.trim() || undefined } }),
          items: cart.map(l => ({ variantId: l.variantId, quantity: lineUnits(l), ...(l.mode === 'pack' && l.perPack ? { packs: l.n } : {}) })),
          note: note.trim() || undefined, idempotencyKey: idem,
        },
      });
      haptic('success'); setCart([]); reloadMe(); toast(`سفارش #${fa(o.number)} ثبت شد`);
      go({ name: 'order', id: o.id }, true);
    } catch (e) {
      haptic('error'); setErr(e instanceof ApiError ? e.message : 'ثبت نشد؛ اتصال را بررسی کنید.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="top"><h1>سبد سفارش</h1></div>
      {lines.map((l, i) => (
        <div className="ci" key={l.variantId + l.mode}>
          <div className="pimg"><Photo src={l.photo} /></div>
          <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <div className="r"><b>{l.name}</b><button type="button" className="trash" aria-label="حذف" onClick={() => setCart(cart.filter((_, k) => k !== i))}><Icon n="trash" s={18} /></button></div>
            <span className="v num"><bdi>{l.label}</bdi></span>
            <div className="r">
              <div className="stepper">
                <button type="button" aria-label="افزایش" onClick={() => upd(i, { n: l.n + 1 })}><Icon n="plus" s={15} /></button>
                <input className="num" aria-label="مقدار" value={fa(l.n)} readOnly />
                <button type="button" aria-label="کاهش" onClick={() => upd(i, { n: Math.max(1, l.n - 1) })}><Icon n="minus" s={15} /></button>
              </div>
              {l.perPack && l.packName ? (
                <div className="unit"><button type="button" aria-pressed={l.mode === 'unit'} onClick={() => upd(i, { mode: 'unit' })}>{l.unitName}</button><button type="button" aria-pressed={l.mode === 'pack'} onClick={() => upd(i, { mode: 'pack' })}>{l.packName}</button></div>
              ) : <span className="conv">{l.unitName}</span>}
            </div>
            <div className="r"><span className="conv num">{l.mode === 'pack' && l.perPack ? `${fa(lineUnits(l))} ${l.unitName}` : ''}</span>
              <b className="num">{l.price !== null ? `${fa(lineTotal(l)!)} ریال` : <span className="tag warn">استعلامی</span>}</b></div>
          </div>
        </div>
      ))}

      {authed === false && <LoginNeeded what="ثبت سفارش" />}
      {authed && me && (accounts.length ? <>
        <div className="sec"><h2 style={{ fontSize: 16 }}>ثبت سفارش برای</h2></div>
        <div className="buyers">
          {accounts.map(a => (
            <label key={a.customerId}>
              <input type="radio" name="acct" checked={a.customerId === acct} onChange={() => setAcct(a.customerId)} />
              <span className="av">{a.name.slice(0, 1)}</span>
              <span><b>{a.name}</b><small>ثبت‌کننده: شما ({personName(me)}) · {ROLE_FA[a.role]}{a.isApproved ? '' : ' · در انتظار تأیید حساب'}</small></span>
            </label>
          ))}
        </div>
        <div className="sec"><h2 style={{ fontSize: 16 }}>شرایط تسویه شما</h2></div>
        <div className="split">
          <div className="sbar"><i style={{ width: `${cashPct}%` }} /></div>
          <div className="srow">
            <div><span className="dot c" /><span>نقد <b className="num">{fa(cashPct)}٪</b></span><small className="num">{total ? `${fa(cash)} ریال` : '—'}</small></div>
            <div><span className="dot q" /><span>چک <b className="num">{fa(100 - cashPct)}٪</b></span><small className="num">{total ? `${fa(total - cash)} ریال` : '—'}</small></div>
          </div>
          <p>{account?.terms.chequeDueDays.length ? `سررسید چک‌ها: ${account.terms.chequeDueDays.map(d => fa(d) + ' روزه').join('، ')}. ` : ''}این درصدها را واحد فروش برای حساب شما تعیین کرده است. مبالغ نهایی در پیش‌فاکتور می‌آید.</p>
        </div>
      </> : <>
        <div className="sec"><h2 style={{ fontSize: 16 }}>اولین سفارش شما</h2></div>
        <div className="notice">حساب مشتری شما با همین سفارش ساخته می‌شود و پس از تأیید واحد فروش، شرایط تسویه و پشتیبان اختصاصی برایتان تعیین می‌شود.</div>
        <label className="field"><span>نام فروشگاه یا شرکت</span><input value={newName} onChange={e => setNewName(e.target.value)} maxLength={120} /></label>
        <label className="field"><span>شهر</span><input value={newCity} onChange={e => setNewCity(e.target.value)} maxLength={60} /></label>
      </>)}

      <textarea className="note-in" value={note} onChange={e => setNote(e.target.value)} placeholder="توضیحات سفارش، مثلاً محل تحویل یا زمان ارسال" maxLength={1000} />
      <div className="summary">
        <div><span>اقلام قیمت‌دار</span><span className="num">{fa(lines.length - inq)} قلم</span></div>
        <div><span>اقلام استعلامی</span><span className="num">{fa(inq)} قلم</span></div>
        <div className="big"><span>جمع تقریبی</span><b className="num">{fa(total)} <small style={{ fontSize: 12, fontWeight: 600 }}>ریال</small></b></div>
        <p>قیمت نهایی، تخفیف و موجودی را کارشناس فروش در پیش‌فاکتور تأیید می‌کند.</p>
      </div>
      {err && <div className="notice warn">{err}</div>}
      <div className="actionbar">
        <button type="button" className="back" aria-label="بازگشت" onClick={() => go({ name: 'catalog' })}><Icon n="back" /></button>
        <button type="button" className={`go ${total === 0n ? 'inq' : ''}`} disabled={busy || !authed} onClick={submit}>
          <span>{busy ? 'در حال ثبت…' : total === 0n ? 'ارسال درخواست استعلام' : 'ثبت سفارش'}</span><small className="num">{total ? `${short(total)} ریال` : `${fa(lines.length)} قلم`}</small>
        </button>
      </div>
    </>
  );
}

// ───────── orders ─────────
const STEPS: [string, string][] = [['ثبت‌شده', 'از مینی‌اپ یا ربات'], ['بررسی واحد فروش', 'قیمت نهایی، موجودی، تخفیف'], ['پیش‌فاکتور', 'با اعتبار ۴۸ ساعت'], ['آماده‌سازی', 'انبار و بسته‌بندی'], ['ارسال', 'باربری و شماره بارنامه'], ['تحویل', 'تأیید دریافت']];
const STEP_OF: Record<string, number> = { SUBMITTED: 0, SALES_REVIEW: 1, NEEDS_FIX: 1, PROFORMA_SENT: 2, PROFORMA_EXPIRED: 2, CONFIRMED: 3, PREPARING: 3, SHIPPED: 4, DELIVERED: 6 };
const stClass = (s: string) => (s === 'REJECTED' || s === 'CANCELLED' ? 'no' : s === 'NEEDS_FIX' || s === 'PROFORMA_EXPIRED' ? 'ask' : s === 'DELIVERED' ? 'ok' : 'info');
const dateFa = (d: string) => new Date(d).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function OrdersScreen() {
  const { authed, go } = useApp();
  const list = useApi<Order[]>(authed ? '/orders' : null, [authed]);
  return (
    <>
      <div className="top"><h1>سفارش‌ها</h1></div>
      {authed === false && <LoginNeeded what="دیدن سفارش‌ها" />}
      {authed && (list.error ? <Failed msg={list.error} retry={list.reload} /> : !list.data ? <Loading h={200} /> : !list.data.length ? (
        <div className="empty">هنوز سفارشی ثبت نکرده‌اید.<br /><br /><button type="button" className="cta" style={{ justifyContent: 'center' }} onClick={() => go({ name: 'catalog' })}>رفتن به محصولات</button></div>
      ) : list.data.map(o => (
        <button key={o.id} type="button" className="oc" onClick={() => go({ name: 'order', id: o.id })}>
          <div className="r"><b className="num">سفارش #{fa(o.number)}</b><span className={`st ${stClass(o.status)}`}>{o.statusFa}</span></div>
          <div className="r"><small className="num">{o.customer.name} · {fa(o.items.length)} قلم · {dateFa(o.createdAt)}</small><b className="num" style={{ fontSize: 13 }}>{BigInt(o.total) ? `${short(BigInt(o.total))} ریال` : 'استعلامی'}</b></div>
          {o.placedBy && <small>ثبت‌کننده: {personName(o.placedBy)}</small>}
        </button>
      )))}
    </>
  );
}

export function OrderScreen({ id }: { id: string }) {
  const o = useApi<Order>(`/orders/${encodeURIComponent(id)}`);
  if (o.error) return <Failed msg={o.error} retry={o.reload} />;
  if (!o.data) return <Loading h={300} />;
  const d = o.data;
  const stopped = d.status === 'REJECTED' || d.status === 'CANCELLED';
  const at = STEP_OF[d.status] ?? 0;
  const pct = Math.min(1, (at + 0.5) / 6), C = 2 * Math.PI * 34;
  const cashPct = d.termsSnapshot?.cashPercent ?? 100;
  const lastComment = [...(d.events ?? [])].reverse().find(e => e.comment)?.comment;
  return (
    <>
      <div style={{ height: 16 }} />
      <section className="ostat">
        <div className="r">
          <div><p className="num">سفارش #{fa(d.number)} · {d.customer.name}</p><h2>{d.statusFa}</h2><p>{stopped ? (lastComment ?? '') : at < 6 ? STEPS[Math.min(at, 5)][1] : 'سفارش تحویل شد'}</p></div>
          <svg className="ring" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="34" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="8" />
            {!stopped && <circle cx="42" cy="42" r="34" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 42 42)" />}
            <text x="42" y="48" textAnchor="middle" fill="#fff" fontSize="17" fontWeight="900">{stopped ? '—' : `${fa(Math.min(at + 1, 6))}/${fa(6)}`}</text></svg>
        </div>
        {!stopped && <div className="bar">{STEPS.map((_, i) => <i key={i} className={i < at ? 'on' : i === at ? 'now' : ''} />)}</div>}
      </section>
      {d.status === 'NEEDS_FIX' && lastComment && <div className="notice warn">پیام واحد فروش: {lastComment}</div>}

      <div className="items">
        {d.items.map(i => (
          <div key={i.id}><span>{i.title}<small className="num">{fa(i.quantity)} عدد{i.packs ? ` (${fa(i.packs)} بسته)` : ''}</small></span>
            <b className="num">{i.unitPrice !== null ? `${fa(BigInt(i.unitPrice) * BigInt(i.quantity))}` : <span className="tag warn">استعلامی</span>}</b></div>
        ))}
      </div>
      <div className="summary">
        <div><span>نقد {fa(cashPct)}٪</span><span className="num">{d.split ? fa(d.split.cash) : '—'} ریال</span></div>
        <div><span>چک {fa(100 - cashPct)}٪</span><span className="num">{d.split ? fa(d.split.cheque) : '—'} ریال</span></div>
        <div className="big"><span>جمع تقریبی</span><b className="num">{fa(d.total)} <small style={{ fontSize: 12, fontWeight: 600 }}>ریال</small></b></div>
        {d.placedBy && <p>ثبت‌کننده: {personName(d.placedBy)} · {dateFa(d.createdAt)}</p>}
      </div>
      {!!d.events?.length && (
        <ol className="tl">
          {d.events.map((e, i) => (
            <li key={e.id} className={i === d.events!.length - 1 ? 'now' : 'done'}>
              <span className="d num">{i === d.events!.length - 1 ? fa(i + 1) : <Icon n="check" s={14} />}</span>
              <div><b>{STATUS_LABEL[e.status] ?? e.status}</b><small className="num">{dateFa(e.createdAt)}{e.comment ? ` · ${e.comment}` : ''}</small></div>
            </li>
          ))}
        </ol>
      )}
      <div className="pad"><button type="button" className="cta ghost" onClick={openSupportChat}><Icon n="chat" s={18} />&nbsp; پیام به کارشناس فروش</button></div>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'ثبت‌شده', SALES_REVIEW: 'در بررسی واحد فروش', NEEDS_FIX: 'نیاز به اصلاح', PROFORMA_SENT: 'پیش‌فاکتور صادر شد',
  PROFORMA_EXPIRED: 'پیش‌فاکتور منقضی شد', CONFIRMED: 'تأیید شد', PREPARING: 'در حال آماده‌سازی', SHIPPED: 'ارسال شد',
  DELIVERED: 'تحویل شد', REJECTED: 'رد شد', CANCELLED: 'لغو شد',
};

// ───────── quick order assistant ─────────
export interface DraftView { id: string; reply: string; unclear: string[]; lines: (CartLineLike & { quantity: number })[]; total: string; inputText: string }
type CartLineLike = import('./lib').CartLine;

export function AssistantScreen() {
  const { authed, add, setCart, cart, go, toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<({ me: string } | { d: DraftView })[]>([]);
  const [rec, setRec] = useState<MediaRecorder | null>(null);

  const ask = async (body: () => Promise<DraftView>, mine: string) => {
    setBusy(true); setChat(c => [...c, { me: mine }]);
    try { const d = await body(); setChat(c => [...c, { d }]); haptic('success'); }
    catch (e) { setChat(c => c.slice(0, -1)); toast(e instanceof ApiError ? e.message : 'دستیار پاسخ نداد'); haptic('error'); }
    finally { setBusy(false); }
  };
  const send = () => { const t = text.trim(); if (!t || busy) return; setText(''); ask(() => api<DraftView>('/assistant/order', { method: 'POST', body: { text: t } }), t); };

  const record = async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream); const chunks: Blob[] = [];
      r.ondataavailable = e => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); setRec(null);
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        const ext = (r.mimeType || '').includes('mp4') ? 'm4a' : (r.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
        ask(async () => {
          const fd = new FormData(); fd.append('file', blob, `voice.${ext}`);
          return apiForm<DraftView>('/assistant/voice', fd);
        }, '🎙 پیام صوتی');
      };
      r.start(); setRec(r); haptic();
    } catch { toast('دسترسی به میکروفون ممکن نشد؛ می‌توانید در ربات ویس بفرستید'); }
  };

  const addAll = (d: DraftView) => {
    let next = [...cart];
    for (const l of d.lines) {
      const line = { variantId: l.variantId, slug: l.slug, name: l.name, label: l.label, photo: l.photo, perPack: l.perPack, packName: l.packName, unitName: l.unitName, price: l.price, n: l.n, mode: l.mode };
      const ex = next.findIndex(c => c.variantId === line.variantId && c.mode === line.mode);
      next = ex >= 0 ? next.map((c, i) => (i === ex ? { ...c, n: c.n + line.n } : c)) : [...next, line];
    }
    setCart(next); haptic('success'); go({ name: 'cart' });
  };
  void add;

  return (
    <>
      <div className="ai-top"><div className="ai-orb"><Icon n="mic" s={30} /></div><h1>سفارش را بنویسید یا بگویید</h1><p>همان‌طور که پشت تلفن می‌گویید. اقلام فقط از کاتالوگ و لیست قیمت انتخاب می‌شوند.</p></div>
      {authed === false && <LoginNeeded what="سفارش سریع" />}
      <div className="chat">
        {chat.map((m, i) => 'me' in m ? <div key={i} className="me">{m.me}</div> : (
          <div key={i} className="bot">
            <div className="hd"><Icon n="chat" s={14} /> دستیار سفارش</div>
            <div>{m.d.reply}</div>
            {m.d.lines.map(l => (
              <div className="it" key={l.variantId + l.mode}>
                <div className="r1"><b>{l.name} <bdi>{l.label}</bdi></b><span className={`st ${l.price ? 'ok' : 'ask'}`}>{l.price ? 'قیمت‌دار' : 'استعلامی'}</span></div>
                <span className="from num">{l.mode === 'pack' ? `${fa(l.n)} ${l.packName ?? 'بسته'} = ${fa(l.quantity)} ${l.unitName}` : `${fa(l.quantity)} ${l.unitName}`}{l.price ? ` · ${fa(BigInt(l.price) * BigInt(l.quantity))} ریال` : ''}</span>
              </div>
            ))}
            {m.d.unclear.length > 0 && <div className="notice warn" style={{ margin: '6px 0 0' }}>مشخص نشد: {m.d.unclear.join('، ')}</div>}
            {m.d.lines.length > 0 && <>
              <div className="tot"><span>جمع تقریبی</span><b className="num">{fa(m.d.total)} ریال</b></div>
              <button type="button" className="cta" style={{ marginTop: 8 }} onClick={() => addAll(m.d)}><span>افزودن به سبد</span><small className="num">{fa(m.d.lines.length)} قلم</small></button>
            </>}
          </div>
        ))}
        {busy && <div className="bot"><div className="hd"><Icon n="chat" s={14} /> دستیار سفارش</div><div className="skel" style={{ height: 18 }} /></div>}
      </div>
      {!chat.length && (
        <div className="sugg">{['دو کارتن نری ۶۳ در ۲', 'سه کارتن زانو ۵۰', 'یک کیسه رابط ۳۲ و یک کارتن درپوش ۴۰', 'فیلتر دیسکی ۳ اینچ هلیکس کوتاه'].map(s => <button key={s} type="button" className="chip" onClick={() => setText(s)}>{s}</button>)}</div>
      )}
      <div className="composer">
        <textarea rows={2} aria-label="متن سفارش" placeholder="مثلاً: دو کارتن نری ۶۳ در ۲ و یک کیسه رابط ۵۰" value={text} onChange={e => setText(e.target.value)} disabled={!authed} />
        {typeof MediaRecorder !== 'undefined' && <button type="button" className="icb" aria-label={rec ? 'پایان ضبط' : 'پیام صوتی'} disabled={!authed || busy} onClick={record} style={rec ? { background: 'var(--bad)', color: '#fff' } : undefined}><Icon n="mic" s={18} /></button>}
        <button type="button" className="icb send" aria-label="ارسال" disabled={!authed || busy || !text.trim()} onClick={send}><Icon n="send" s={18} /></button>
      </div>
    </>
  );
}
