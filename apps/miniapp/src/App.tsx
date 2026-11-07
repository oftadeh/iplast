import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { CartLine, Family, Me, api, loadCart, login, saveCart } from './lib';
import { haptic, openSupportChat, tg } from './telegram';
import { Picker } from './Picker';
import { CartScreen, CatalogScreen, HomeScreen, OrderScreen, OrdersScreen, ProductScreen } from './screens';

export type Route =
  | { name: 'home' } | { name: 'catalog'; cat?: string; q?: string } | { name: 'product'; slug: string }
  | { name: 'cart' } | { name: 'orders' } | { name: 'order'; id: string };

interface Ctx {
  route: Route; go: (r: Route, replace?: boolean) => void; back: () => void;
  cart: CartLine[]; setCart: (c: CartLine[]) => void; add: (l: CartLine) => void;
  me: Me | null; authed: boolean | null; reloadMe: () => void;
  quickAdd: (slug: string) => void; toast: (t: string) => void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];
  const [cart, setCartState] = useState<CartLine[]>(loadCart);
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState<{ slug: string; f: Family | null } | null>(null);
  const [toastText, setToastText] = useState('');
  const toastTimer = useRef<number>();
  const scroller = useRef<HTMLDivElement>(null);

  const toast = useCallback((t: string) => {
    setToastText(t); window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(''), 2200);
  }, []);
  const setCart = (c: CartLine[]) => { setCartState(c); saveCart(c); };
  const add = (l: CartLine) => {
    const ex = cart.findIndex(c => c.variantId === l.variantId && c.mode === l.mode);
    setCart(ex >= 0 ? cart.map((c, i) => (i === ex ? { ...c, n: c.n + l.n } : c)) : [...cart, l]);
    haptic('success'); toast('به سبد اضافه شد');
  };
  const go = (r: Route, replace = false) => { setSheet(null); setStack(s => (replace ? [...s.slice(0, -1), r] : [...s, r])); };
  const back = () => { setSheet(null); setStack(s => (s.length > 1 ? s.slice(0, -1) : s)); };
  const tab = (r: Route) => { setSheet(null); setStack(r.name === 'home' ? [r] : [{ name: 'home' }, r]); };

  const reloadMe = useCallback(() => { api<Me>('/me').then(setMe, () => setMe(null)); }, []);
  useEffect(() => {
    const app = tg();
    app?.ready(); app?.expand();
    const apply = () => { document.documentElement.dataset.theme = app?.colorScheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); };
    apply(); app?.onEvent?.('themeChanged', apply);
    login().then(ok => { setAuthed(ok); if (ok) reloadMe(); });
  }, [reloadMe]);

  // Telegram's own back button follows our stack
  useEffect(() => {
    const b = tg()?.BackButton; if (!b) return;
    const h = () => back();
    if (stack.length > 1 || sheet) b.show(); else b.hide();
    b.onClick(h); return () => b.offClick(h);
  }, [stack.length, sheet]);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [route]);

  const quickAdd = (slug: string) => {
    setSheet({ slug, f: null }); haptic();
    api<Family>(`/catalog/families/${encodeURIComponent(slug)}`).then(f => setSheet(s => (s?.slug === slug ? { slug, f } : s)), () => { setSheet(null); toast('بارگذاری نشد'); });
  };

  const count = cart.length;
  const navItems: [Route, string, string][] = [[{ name: 'home' }, 'home', 'خانه'], [{ name: 'catalog' }, 'grid', 'محصولات']];
  const navItems2: [Route, string, string][] = [[{ name: 'orders' }, 'box', 'سفارش‌ها']];
  const isTab = (n: string) => route.name === n || (n === 'orders' && route.name === 'order') || (n === 'catalog' && route.name === 'product');

  const ctx: Ctx = { route, go, back, cart, setCart, add, me, authed, reloadMe, quickAdd, toast };
  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <div className="scroll" ref={scroller}>
          <div className="view">
            {route.name === 'home' && <HomeScreen />}
            {route.name === 'catalog' && <CatalogScreen cat={route.cat} q={route.q} />}
            {route.name === 'product' && <ProductScreen slug={route.slug} />}
            {route.name === 'cart' && <CartScreen />}
            {route.name === 'orders' && <OrdersScreen />}
            {route.name === 'order' && <OrderScreen id={route.id} />}
          </div>
        </div>

        <nav className="nav" aria-label="بخش‌ها" hidden={route.name === 'cart'}>
          {navItems.map(([r, i, l]) => <button key={l} type="button" aria-current={isTab(r.name) ? 'page' : undefined} onClick={() => tab(r)}><Icon n={i} /><span className="lb">{l}</span></button>)}
          <button type="button" className="orb" aria-label={`سبد سفارش، ${count} قلم`} onClick={() => tab({ name: 'cart' })}>
            <Icon n="cart" s={22} />{count > 0 && <span className="cnt num">{count.toLocaleString('fa-IR')}</span>}
          </button>
          {navItems2.map(([r, i, l]) => <button key={l} type="button" aria-current={isTab(r.name) ? 'page' : undefined} onClick={() => tab(r)}><Icon n={i} /><span className="lb">{l}</span></button>)}
          <button type="button" onClick={openSupportChat}><Icon n="chat" /><span className="lb">پشتیبانی</span></button>
        </nav>

        <div className={`scrim ${sheet ? 'on' : ''}`} onClick={() => setSheet(null)} />
        <div className={`sheet ${sheet ? 'on' : ''}`} role="dialog" aria-modal="true" aria-label="انتخاب سایز">
          <div className="grab" />
          {sheet && <button type="button" className="close" aria-label="بستن" onClick={() => setSheet(null)}><Icon n="close" s={16} /></button>}
          {sheet && !sheet.f && <div className="skel" style={{ height: 260 }} />}
          {sheet?.f && (
            <>
              <div className="sh-head">
                <div className="pimg">{sheet.f.media[0] ? <img className="photo" src={'/' + sheet.f.media[0].key} alt="" /> : <Icon n="pipe" className="noimg" />}</div>
                <div><h3>{sheet.f.name}</h3><div className="meta num">{sheet.f.category.name}{sheet.f.brand ? ` · ${sheet.f.brand.name}` : ''} · {sheet.f.variants.length.toLocaleString('fa-IR')} سایز</div>
                  <button type="button" className="link" onClick={() => go({ name: 'product', slug: sheet.slug })}>جزئیات محصول</button></div>
              </div>
              <Picker key={sheet.slug} f={sheet.f} onAdd={l => { add(l); setSheet(null); }} />
            </>
          )}
        </div>
        <div className={`toast ${toastText ? 'show' : ''}`} role="status">{toastText}</div>
      </div>
    </AppCtx.Provider>
  );
}
