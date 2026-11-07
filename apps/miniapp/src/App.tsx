import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { CartLine, Family, Me, api, loadCart, login, saveCart } from './lib';
import { haptic, openSupportChat, tg } from './telegram';
import { Picker } from './Picker';
import { AssistantScreen, CartScreen, CatalogScreen, DraftView, HomeScreen, OrderScreen, OrdersScreen, ProductScreen } from './screens';

export type Route =
  | { name: 'home' } | { name: 'catalog'; cat?: string; q?: string } | { name: 'product'; slug: string }
  | { name: 'cart' } | { name: 'orders' } | { name: 'order'; id: string } | { name: 'assistant' };

interface Ctx {
  route: Route; go: (r: Route, replace?: boolean) => void; back: () => void;
  cart: CartLine[]; setCart: (c: CartLine[]) => void; add: (l: CartLine) => void;
  me: Me | null; authed: boolean | null; reloadMe: () => void;
  quickAdd: (slug: string) => void; toast: (t: string) => void; aiEnabled: boolean;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];
  const [cart, setCartState] = useState<CartLine[]>(loadCart);
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
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
    api<{ enabled: boolean }>('/assistant/status').then(r => setAiEnabled(r.enabled), () => {});
    login().then(async ok => {
      setAuthed(ok);
      if (!ok) return;
      reloadMe();
      // opened from the bot's «بررسی و ثبت در سبد» button: load the assistant's draft into the cart
      const draft = new URLSearchParams(location.search).get('draft');
      if (draft && /^[a-z0-9]{10,40}$/.test(draft)) {
        try {
          const d = await api<DraftView>(`/assistant/drafts/${draft}`);
          const cur = loadCart();
          for (const l of d.lines) {
            const line = { variantId: l.variantId, slug: l.slug, name: l.name, label: l.label, photo: l.photo, perPack: l.perPack, packName: l.packName, unitName: l.unitName, price: l.price, n: l.n, mode: l.mode };
            const ex = cur.findIndex(c => c.variantId === line.variantId && c.mode === line.mode);
            if (ex >= 0) cur[ex] = line; else cur.push(line);
          }
          setCartState(cur); saveCart(cur);
          history.replaceState(null, '', location.pathname);
          setStack([{ name: 'home' }, { name: 'cart' }]);
          toast('پیش‌نویس دستیار به سبد اضافه شد');
        } catch { toast('پیش‌نویس سفارش باز نشد'); }
      }
    });
  }, [reloadMe, toast]);

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

  const ctx: Ctx = { route, go, back, cart, setCart, add, me, authed, reloadMe, quickAdd, toast, aiEnabled };
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
            {route.name === 'assistant' && <AssistantScreen />}
          </div>
        </div>

        <nav className="nav" aria-label="بخش‌ها" hidden={route.name === 'cart' || route.name === 'assistant'}>
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
