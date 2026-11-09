import { useMemo, useState } from 'react';
import { useApp } from './App';
import { Icon } from './icons';
import { CartLine, Family, Sale, Variant, bestOffer, fa, lineUnits, offerText, payModeFa, photoUrl, salePrices, short, withPct } from './lib';

const valueOf = (f: Family, v: Variant, i: number) => v.options.find(o => o.axisId === f.axes[i].id)?.value ?? '';
export const variantLabel = (f: Family, v: Variant) =>
  f.axes.length ? f.axes.map((_, i) => valueOf(f, v, i)).filter(Boolean).join(' × ') : v.title;
const packWord = (f: Family) => f.packName ?? 'بسته';

/** Size/option picker with price, quantity (unit or pack) and the add button. Used by the product page and the quick-add sheet. */
export function Picker({ f, onAdd, sale }: { f: Family; onAdd: (line: CartLine) => void; sale?: Sale }) {
  const first = f.variants.find(v => v.price !== null) ?? f.variants[0];
  const [sel, setSel] = useState<string[]>(() => (first ? f.axes.map((_, i) => valueOf(f, first, i)) : []));
  const [byTitle, setByTitle] = useState(first?.id);
  const [n, setN] = useState(1);
  // the factory sells full cartons / bags: a size with a pack is ordered by the pack unless the customer picks units
  const [modeRaw, setMode] = useState<'unit' | 'pack'>('pack');
  const offers = useApp().offers.filter(o => o.familyId === f.id);

  const matches = (v: Variant, upto: number) => sel.slice(0, upto).every((p, k) => valueOf(f, v, k) === p);
  const variant = useMemo(() => {
    if (!f.axes.length) return f.variants.find(v => v.id === byTitle) ?? f.variants[0];
    return f.variants.find(v => matches(v, f.axes.length)) ?? f.variants.find(v => valueOf(f, v, 0) === sel[0]) ?? f.variants[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, byTitle, f]);
  if (!variant) return <div className="empty">برای این محصول هنوز سایزی ثبت نشده است.</div>;

  const canPack = !!variant.perPack;
  const packOnly = canPack && !!f.packOnly;
  const mode = packOnly ? 'pack' : canPack ? modeRaw : 'unit';
  const units = lineUnits({ n, mode, perPack: variant.perPack });
  const packsNow = variant.perPack ? Math.floor(units / variant.perPack) : units;
  const list = variant.price === null ? null : BigInt(variant.price);
  // the customer's own prices: نقدی and مدت‌دار (or the list price when they have no terms yet), with a «تخفیف ویژه» when it applies
  const prices = list === null ? [] : salePrices(sale, f.category.slug, list).map(x => {
    const sp = bestOffer(offers, x.mode, x.pct, packsNow);
    return sp.best ? { ...x, pct: sp.best.pct, price: withPct(list, sp.best.pct), special: sp.best.pct - x.pct, next: sp.next } : { ...x, special: 0, next: sp.next };
  });
  const price = variant.soldOut ? null : prices[0]?.price ?? null;

  const pick = (i: number, val: string) => {
    const next = [...sel.slice(0, i), val];
    // keep later choices if still valid, otherwise take the first available
    for (let k = i + 1; k < f.axes.length; k++) {
      const opts = valuesAt(k, next);
      next.push(opts.includes(sel[k]) ? sel[k] : opts[0]);
    }
    setSel(next);
  };
  const valuesAt = (i: number, prefix: string[]) => {
    const out: string[] = [];
    for (const v of f.variants) if (prefix.every((p, k) => valueOf(f, v, k) === p)) { const x = valueOf(f, v, i); if (x && !out.includes(x)) out.push(x); }
    return out;
  };

  return (
    <>
      {f.axes.map((a, i) => {
        const vals = valuesAt(i, sel.slice(0, i));
        return (
          <div className="opt" key={a.id}>
            <div className="lb">{a.name}{a.unit ? ` (${a.unit})` : ''}<span>{fa(vals.length)} گزینه</span></div>
            <div className="sizes-g">
              {vals.map(val => {
                const priced = f.variants.some(v => valueOf(f, v, i) === val && matches(v, i) && v.price !== null && !v.soldOut);
                return (
                  <button key={val} type="button" className={`sz num ${priced ? '' : 'na'}`} aria-pressed={sel[i] === val} onClick={() => pick(i, val)}>
                    <bdi dir="ltr">{val}</bdi>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {!f.axes.length && f.variants.length > 1 && (
        <div className="opt"><div className="lb">مدل<span>{fa(f.variants.length)} گزینه</span></div>
          <div className="opts">{f.variants.map(v => <button key={v.id} type="button" className={`sz ${v.price === null ? 'na' : ''}`} aria-pressed={v.id === variant.id} onClick={() => setByTitle(v.id)}>{v.title}</button>)}</div>
        </div>
      )}

      {offers.length > 0 && (
        <div className="special-box">
          <b>⭐ تخفیف ویژه</b>
          {offers.map(o => <span key={o.id} className="num">{offerText(o)}{o.note ? ` · ${o.note}` : ''}</span>)}
        </div>
      )}
      {variant.soldOut ? (
        <div className="pricebox"><div><div className="inq">ناموجود</div><div className="u">این سایز فعلاً موجود نیست؛ برای زمان تأمین به کارشناس فروش پیام بدهید.</div></div></div>
      ) : price === null ? (
        <div className="pricebox"><div><div className="inq">قیمت استعلامی</div><div className="u">این سایز در لیست قیمت فعلی قیمت ندارد؛ کارشناس فروش اعلام می‌کند.</div></div></div>
      ) : (
        <div className="pricebox modes2">
          {list !== null && prices.some(x => x.pct > 0) && <div className="listp num">قیمت لیست <s>{fa(list)}</s> ریال برای هر {f.unitName}</div>}
          {prices.map(x => (
            <div key={x.mode} className="pmode">
              <div><span className="mname">{sale ? payModeFa(x.mode, x.mode === 'TERM' ? sale.termMonths : null) : `ریال برای هر ${f.unitName}`}{x.pct > 0 && <b className="mypct num"> {fa(x.pct)}٪ تخفیف</b>}{x.special > 0 && <span className="sp-tag num">ویژه +{fa(+x.special.toFixed(2))}٪</span>}</span><div className="p num">{fa(x.price)}</div>
                {x.next && <div className="u num">از {fa(x.next.offer.minPacks!)} {x.next.offer.packName} به بالا: {fa(x.next.pct)}٪ تخفیف</div>}</div>
              {units > 1 && <div style={{ textAlign: 'left' }}><div className="u">جمع</div><b className="num">{short(x.price * BigInt(units))}</b></div>}
            </div>
          ))}
          {!sale && f.priceList && <div className="u">{f.priceList.title}</div>}
        </div>
      )}

      <div className="qrow">
        <div className="stepper">
          <button type="button" aria-label="افزایش" onClick={() => setN(n + 1)}><Icon n="plus" s={18} /></button>
          <input className="num" inputMode="numeric" aria-label="مقدار" value={fa(n)}
            onChange={e => { const d = +e.target.value.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/\D/g, ''); setN(Math.max(1, Math.min(100000, d || 1))); }} />
          <button type="button" aria-label="کاهش" onClick={() => setN(Math.max(1, n - 1))}><Icon n="minus" s={18} /></button>
        </div>
        {packOnly ? <span className="conv">{packWord(f)}</span> : canPack ? (
          <div className="unit" role="group" aria-label="واحد">
            <button type="button" aria-pressed={mode === 'pack'} onClick={() => setMode('pack')}>{packWord(f)}</button>
            <button type="button" aria-pressed={mode === 'unit'} onClick={() => setMode('unit')}>{f.unitName}</button>
          </div>
        ) : <span className="conv">{f.unitName}</span>}
      </div>
      {canPack && <span className="conv num">{mode === 'pack' ? `${fa(n)} ${packWord(f)} = ${fa(units)} ${f.unitName}` : `هر ${packWord(f)} ${fa(variant.perPack!)} ${f.unitName}`}{packOnly ? ` · فقط ${packWord(f)} کامل` : ''}</span>}

      <button type="button" className={`cta ${price === null ? 'inq' : ''}`} disabled={variant.soldOut} onClick={() => onAdd({
        variantId: variant.id, slug: f.slug, name: f.name, label: variantLabel(f, variant), photo: photoUrl(f.media.find(m => (m as { isPrimary?: boolean }).isPrimary)?.key ?? f.media[0]?.key),
        perPack: variant.perPack, packName: f.packName ?? (variant.perPack ? 'بسته' : null), unitName: f.unitName, price: price === null ? null : String(price), n, mode, packOnly,
      })}>
        <span>{variant.soldOut ? 'ناموجود' : price === null ? 'افزودن برای استعلام' : 'افزودن به سبد'}</span>
        <small className="num">{price === null ? `${fa(units)} ${f.unitName}` : `${short(price * BigInt(units))} ریال`}</small>
      </button>
    </>
  );
}
