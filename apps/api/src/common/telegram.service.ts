import { Injectable, Logger } from '@nestjs/common';

/** Sends bot messages from the API (order notifications, login codes). Failures are logged, never thrown. */
@Injectable()
export class TelegramService {
  private readonly log = new Logger('Telegram');

  async send(chatId: bigint | number | string, text: string, replyMarkup?: object): Promise<boolean> {
    const token = process.env.BOT_TOKEN;
    if (!token) return false;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      });
      if (!r.ok) this.log.warn(`sendMessage ${r.status}`);
      return r.ok;
    } catch (e) {
      this.log.warn(`sendMessage failed: ${(e as Error).message}`);
      return false;
    }
  }
}
