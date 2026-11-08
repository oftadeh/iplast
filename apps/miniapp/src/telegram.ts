interface TgButton { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
interface TgWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close(): void;
  openTelegramLink?(url: string): void;
  onEvent?(e: string, cb: () => void): void;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  BackButton?: TgButton;
  platform?: string;
  isVersionAtLeast?(v: string): boolean;
  requestFullscreen?(): void;
  disableVerticalSwipes?(): void;
  lockOrientation?(): void;
  isExpanded?: boolean;
  HapticFeedback?: { impactOccurred(s: 'light' | 'medium'): void; notificationOccurred(s: 'success' | 'error'): void };
  initDataUnsafe?: { user?: { first_name?: string } };
}
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }

export const tg = () => window.Telegram?.WebApp;
export const haptic = (k: 'light' | 'success' | 'error' = 'light') => {
  try {
    const h = tg()?.HapticFeedback;
    if (!h) return;
    if (k === 'light') h.impactOccurred('light'); else h.notificationOccurred(k);
  } catch { /* old clients */ }
};

export const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME as string | undefined) ?? 'iplast_sellerbot';

/** Back to the bot chat, where text, voice, photos and PDFs go straight to sales support. */
export function openSupportChat() {
  const app = tg();
  const url = `https://t.me/${BOT_USERNAME}`;
  if (app?.openTelegramLink) app.openTelegramLink(url); else window.open(url, '_blank');
}

/**
 * Full-screen app inside Telegram: on phones it takes the whole screen (Bot API 8.0 requestFullscreen),
 * and swiping down inside the page scrolls it instead of minimising or closing the mini app (7.7).
 * Telegram publishes the area its own buttons cover as --tg-safe-area-inset-* / --tg-content-safe-area-inset-*,
 * which styles.css keeps clear.
 */
export function setupTelegram() {
  const app = tg();
  if (!app) return;
  app.ready(); app.expand();
  const at = (v: string) => { try { return !!app.isVersionAtLeast?.(v); } catch { return false; } };
  const phone = ['ios', 'android', 'android_x'].includes(app.platform ?? '');
  try { if (at('7.7')) app.disableVerticalSwipes?.(); } catch { /* old client */ }
  try { if (phone && at('8.0')) { app.requestFullscreen?.(); app.lockOrientation?.(); } } catch { /* old client */ }
  document.documentElement.classList.add('in-tg');
}
