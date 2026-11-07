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
