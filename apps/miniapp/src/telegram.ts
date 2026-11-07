interface TgWebApp { initData: string; ready(): void; expand(): void; colorScheme: 'light' | 'dark' }
declare global { interface Window { Telegram?: { WebApp?: TgWebApp } } }
export const tg = () => window.Telegram?.WebApp;
