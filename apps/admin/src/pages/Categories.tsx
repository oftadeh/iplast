import { useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, fa, useApi } from '../lib';

interface Cat { id: string; slug: string; name: string; parentId: string | null; depth: number; path: string; families: number; total: number; children: number }
interface Row { id: string; name: string; isActive: boolean; categoryId: string; category: { name: string }; media: { key: string }[] }

const err = (e: unknown, f = 'ثبت نشد') => (e instanceof ApiError ? e.message : f);
const MAX_DEPTH = 3;

/**
 * «دسته‌بندی‌ها»: the catalog tree, branch → sub-branch. Managers add, rename, move, order and delete categories, and
 * move products between them; the mini app and the customers' category percents follow this tree.
 */
export function CategoriesPage() {
  const { me, toast, open } = useAdmin();
  const can = me.staffRole === 'ADMIN';
  const cats = useApi<Cat[]>('/admin/categories');
  const [sel, setSel] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<Cat[]>, ok: string) => {
    setBusy(true);
    try { cats.setData(await f()); toast(ok); return true; } catch (e) { toast(err(e)); return false; } finally { setBusy(false); }
  };
  const list = cats.data ?? [];
  const cur = list.find(c => c.id === sel) ?? null;

  return (
    <>
      <div className="head"><h1>دسته‌بندی‌ها</h1></div>
      <p className="note" style={{ margin: 0 }}>
        درخت کالاها: هر شاخه می‌تواند زیرشاخه داشته باشد (تا {fa(MAX_DEPTH)} سطح). مینی‌اپ شاخه‌های اصلی را نشان می‌دهد و با زدن هر کدام زیرشاخه‌هایش می‌آید.
        درصدی که برای مشتری روی یک شاخه بگذارید، زیرشاخه‌هایش را هم می‌گیرد. برای جابه‌جایی کالاها، یک دسته را باز کنید و کالاها را تیک بزنید.
      </p>
      {can && (
        <form className="row" onSubmit={async e => { e.preventDefault(); if (newRoot.trim() && await run(() => api<Cat[]>('/admin/categories', { method: 'POST', body: { name: newRoot } }), 'شاخه‌ی اصلی اضافه شد')) setNewRoot(''); }}>
          <input className="in" style={{ flex: 1 }} placeholder="نام شاخه‌ی اصلی جدید" value={newRoot} onChange={e => setNewRoot(e.target.value)} maxLength={60} />
          <button type="submit" className="btn primary" disabled={busy || !newRoot.trim()}>+ شاخه‌ی اصلی</button>
        </form>
      )}
      {cats.error ? <div className="err">{cats.error}</div> : !cats.data ? <div className="card pad muted">در حال بارگذاری…</div> : (
        <div className="cattree card">
          {list.map(c => (
            <CatRow key={c.id} c={c} all={list} can={can} busy={busy} open={c.id === sel} onOpen={() => setSel(c.id === sel ? null : c.id)} run={run} />
          ))}
          {!list.length && <div className="empty small">هنوز دسته‌ای نیست.</div>}
        </div>
      )}
      {cur && <CatProducts key={cur.id} cat={cur} all={list} can={can} onMoved={cats.reload} onOpenProduct={id => open('catalog/products', id)} />}
    </>
  );
}

function CatRow({ c, all, can, busy, open, onOpen, run }: { c: Cat; all: Cat[]; can: boolean; busy: boolean; open: boolean; onOpen: () => void; run: (f: () => Promise<Cat[]>, ok: string) => Promise<boolean> }) {
  const [mode, setMode] = useState<'' | 'rename' | 'child' | 'move' | 'delete'>('');
  const [name, setName] = useState(c.name);
  const [child, setChild] = useState('');
  const [parent, setParent] = useState(c.parentId ?? '');
  const [moveTo, setMoveTo] = useState('');
  const sibs = all.filter(x => x.parentId === c.parentId);
  const idx = sibs.findIndex(x => x.id === c.id);
  // where it can go: not under itself or its sub-branches, and the tree stays within MAX_DEPTH levels
  const mine = new Set([c.id, ...descendants(all, c.id)]);
  const height = Math.max(...[...mine].map(id => all.find(x => x.id === id)!.depth)) - c.depth;
  const parents = all.filter(x => !mine.has(x.id) && x.depth + 1 + height < MAX_DEPTH);
  const done = (ok: boolean) => { if (ok) setMode(''); };
  return (
    <div className={`catrow ${open ? 'sel' : ''}`} style={{ paddingInlineStart: 12 + c.depth * 22 }}>
      <div className="between">
        <button type="button" className="linkish catname" onClick={onOpen}>
          <span className="muted">{c.depth ? '└' : '▸'}</span> <b>{c.name}</b>
          <span className="muted small num"> · {fa(c.total)} کالا{c.children ? ` · ${fa(c.children)} زیرشاخه` : ''}</span>
        </button>
        {can && (
          <span className="row catact">
            <button type="button" className="btn sm ghost" title="بالا" aria-label="بالا" disabled={busy || idx <= 0} onClick={() => run(() => api<Cat[]>(`/admin/categories/${c.id}/move`, { method: 'POST', body: { dir: 'up' } }), 'جابه‌جا شد')}>↑</button>
            <button type="button" className="btn sm ghost" title="پایین" aria-label="پایین" disabled={busy || idx >= sibs.length - 1} onClick={() => run(() => api<Cat[]>(`/admin/categories/${c.id}/move`, { method: 'POST', body: { dir: 'down' } }), 'جابه‌جا شد')}>↓</button>
            <select className="in sm" value="" aria-label="کارها" onChange={e => setMode(e.target.value as typeof mode)}>
              <option value="">…</option>
              <option value="rename">تغییر نام</option>
              {c.depth + 1 < MAX_DEPTH && <option value="child">+ زیرشاخه</option>}
              <option value="move">انتقال به شاخه‌ی دیگر</option>
              <option value="delete">حذف</option>
            </select>
          </span>
        )}
      </div>
      {mode === 'rename' && (
        <form className="row" onSubmit={async e => { e.preventDefault(); done(await run(() => api<Cat[]>(`/admin/categories/${c.id}`, { method: 'PATCH', body: { name } }), 'نام عوض شد')); }}>
          <input className="in" style={{ flex: 1 }} value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus />
          <button type="submit" className="btn sm primary" disabled={busy || !name.trim()}>ذخیره</button><button type="button" className="btn sm" onClick={() => setMode('')}>انصراف</button>
        </form>
      )}
      {mode === 'child' && (
        <form className="row" onSubmit={async e => { e.preventDefault(); if (await run(() => api<Cat[]>('/admin/categories', { method: 'POST', body: { name: child, parentId: c.id } }), `زیرشاخه به «${c.name}» اضافه شد`)) { setChild(''); setMode(''); } }}>
          <input className="in" style={{ flex: 1 }} value={child} onChange={e => setChild(e.target.value)} placeholder={`زیرشاخه‌ی «${c.name}»`} maxLength={60} autoFocus />
          <button type="submit" className="btn sm primary" disabled={busy || !child.trim()}>افزودن</button><button type="button" className="btn sm" onClick={() => setMode('')}>انصراف</button>
        </form>
      )}
      {mode === 'move' && (
        <form className="row" onSubmit={async e => { e.preventDefault(); done(await run(() => api<Cat[]>(`/admin/categories/${c.id}`, { method: 'PATCH', body: { parentId: parent || null } }), 'منتقل شد')); }}>
          <select className="in" style={{ flex: 1 }} value={parent} onChange={e => setParent(e.target.value)}>
            <option value="">— شاخه‌ی اصلی (بدون والد)</option>
            {parents.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}
          </select>
          <button type="submit" className="btn sm primary" disabled={busy || (parent || null) === c.parentId}>انتقال</button><button type="button" className="btn sm" onClick={() => setMode('')}>انصراف</button>
        </form>
      )}
      {mode === 'delete' && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">
            «{c.name}» حذف شود؟{c.children ? ` زیرشاخه‌هایش به ${c.parentId ? 'شاخه‌ی بالایی' : 'شاخه‌های اصلی'} منتقل می‌شوند.` : ''}
            {c.families ? ` ${fa(c.families)} کالای آن به دسته‌ای که انتخاب می‌کنید می‌رود.` : ''} درصدهای ویژه‌ی مشتریان روی این دسته پاک می‌شود.
          </span>
          <div className="row">
            {c.families > 0 && (
              <select className="in" style={{ flex: 1 }} value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                <option value="">{c.parentId ? '— به شاخه‌ی بالایی' : 'کالاها به کدام دسته بروند؟'}</option>
                {all.filter(x => !mine.has(x.id)).map(p => <option key={p.id} value={p.id}>{p.path}</option>)}
              </select>
            )}
            <button type="button" className="btn sm danger" disabled={busy || (c.families > 0 && !c.parentId && !moveTo)} onClick={async () => done(await run(() => api<Cat[]>(`/admin/categories/${c.id}${moveTo ? `?moveTo=${moveTo}` : ''}`, { method: 'DELETE' }), 'دسته حذف شد'))}>حذف</button>
            <button type="button" className="btn sm" onClick={() => setMode('')}>انصراف</button>
          </div>
        </div>
      )}
    </div>
  );
}

function descendants(all: Cat[], id: string) {
  const out: string[] = [];
  const walk = (p: string) => { for (const c of all) if (c.parentId === p && !out.includes(c.id)) { out.push(c.id); walk(c.id); } };
  walk(id);
  return out;
}

/** The products of a category (and its sub-branches): tick some and move them to another category. */
function CatProducts({ cat, all, can, onMoved, onOpenProduct }: { cat: Cat; all: Cat[]; can: boolean; onMoved: () => void; onOpenProduct: (id: string) => void }) {
  const { toast } = useAdmin();
  const rows = useApi<Row[]>(`/admin/products?category=${cat.id}`);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const flip = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const move = async () => {
    setBusy(true);
    try {
      const r = await api<{ moved: number }>(`/admin/categories/${to}/families`, { method: 'POST', body: { familyIds: [...picked] } });
      toast(`${fa(r.moved)} کالا به «${all.find(c => c.id === to)?.name}» منتقل شد`);
      setPicked(new Set()); rows.reload(); onMoved();
    } catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="between"><h2>کالاهای «{cat.path}»</h2>{rows.data && <span className="muted small num">{fa(rows.data.length)} کالا</span>}</div>
      {can && picked.size > 0 && (
        <div className="card pad row movebar">
          <b className="num">{fa(picked.size)} انتخاب‌شده</b>
          <select className="in" style={{ flex: 1 }} value={to} onChange={e => setTo(e.target.value)}>
            <option value="">انتقال به…</option>
            {all.map(c => <option key={c.id} value={c.id}>{c.path}</option>)}
          </select>
          <button type="button" className="btn primary sm" disabled={busy || !to} onClick={move}>انتقال</button>
          <button type="button" className="btn sm ghost" onClick={() => setPicked(new Set())}>لغو انتخاب</button>
        </div>
      )}
      {rows.error ? <div className="err">{rows.error}</div> : !rows.data ? <div className="card pad muted">در حال بارگذاری…</div> : !rows.data.length ? <div className="empty small">این دسته هنوز کالایی ندارد.</div> : (
        <div className="card plist">
          {can && <label className="prow static small muted"><input type="checkbox" checked={picked.size === rows.data.length} onChange={e => setPicked(e.target.checked ? new Set(rows.data!.map(r => r.id)) : new Set())} /> انتخاب همه</label>}
          {rows.data.map(p => (
            <div key={p.id} className="prow static">
              {can && <input type="checkbox" checked={picked.has(p.id)} onChange={() => flip(p.id)} aria-label={`انتخاب ${p.name}`} />}
              <span className="thumb">{p.media[0] ? <img src={'/' + p.media[0].key} alt="" loading="lazy" /> : null}</span>
              <button type="button" className="linkish pinfo" onClick={() => onOpenProduct(p.id)}>
                <b>{p.name}</b>
                <span className="muted small">{p.category.name}</span>
              </button>
              {!p.isActive && <span className="st gray">غیرفعال</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
