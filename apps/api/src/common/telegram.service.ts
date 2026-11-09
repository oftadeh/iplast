import { Injectable, Logger } from '@nestjs/common';

/** Sends bot messages from the API (order notifications, login codes). Failures are logged, never thrown. */
@Injectable()
export class TelegramService {
  private readonly log = new Logger('Telegram');
  private botName: string | null = process.env.BOT_USERNAME || null;

  /**
   * A Bot API call that survives a short outage: the server reaches Telegram through a proxy that sometimes drops a
   * connection. A dropped connection and 5xx are retried after 1 s and 3 s; a 429 waits for Telegram's retry_after
   * (≤10 s). A 4xx (blocked bot, bad chat id) is final, and so is a 15 s timeout (Telegram is unreachable: retrying
   * would only keep the person in the panel waiting).
   */
  private async call(url: string, init: RequestInit): Promise<Response> {
    let last: unknown;
    const tries = process.env.NODE_ENV === 'test' ? 1 : 3;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 3000));
      try {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        if (r.status === 429) {
          const j = await r.clone().json().catch(() => null) as { parameters?: { retry_after?: number } } | null;
          const wait = Math.min(j?.parameters?.retry_after ?? 3, 10);
          await new Promise(res => setTimeout(res, wait * 1000));
          last = r; continue;
        }
        if (r.status >= 500) { last = r; continue; }
        return r;
      } catch (e) {
        last = e;
        if ((e as Error).name === 'TimeoutError') break;
      }
    }
    if (last instanceof Response) return last;
    throw last;
  }

  /** The bot's @username (for t.me links), from BOT_USERNAME or Telegram's getMe. */
  async username(): Promise<string> {
    if (this.botName) return this.botName;
    const token = process.env.BOT_TOKEN;
    try {
      const j = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json()) as { ok?: boolean; result?: { username?: string } };
      if (j?.ok && j.result?.username) this.botName = j.result.username;
    } catch { /* offline: fall back below */ }
    return this.botName ?? 'iplast_sellerbot';
  }

  async send(chatId: bigint | number | string, text: string, replyMarkup?: object): Promise<boolean> {
    const token = process.env.BOT_TOKEN;
    if (!token) return false;
    try {
      const r = await this.call(`https://api.telegram.org/bot${token}/sendMessage`, {
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

  /** Like send(), but returns the sent message id (so a Reply to it in Telegram can be traced back), or null. */
  async sendForId(chatId: bigint | number | string, text: string): Promise<number | null> {
    const token = process.env.BOT_TOKEN;
    if (!token) return null;
    try {
      const r = await this.call(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text }),
      });
      const j = await r.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number } } | null;
      return j?.ok ? j.result?.message_id ?? null : null;
    } catch (e) {
      this.log.warn(`sendMessage failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Downloads a file (voice, photo, PDF) that was sent to the bot. Telegram serves files up to 20 MB. */
  async download(fileId: string): Promise<{ body: Buffer; type: string } | null> {
    const token = process.env.BOT_TOKEN;
    if (!token) return null;
    try {
      const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`).then(r => r.json()) as { ok?: boolean; result?: { file_path?: string } };
      if (!info?.ok || !info.result?.file_path) return null;
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
      if (!r.ok) return null;
      const ext = info.result.file_path.split('.').pop()?.toLowerCase() ?? '';
      const type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', oga: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
      return { body: Buffer.from(await r.arrayBuffer()), type };
    } catch (e) {
      this.log.warn(`download failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Photo with a caption (receipts, cheques). */
  async sendPhoto(chatId: bigint | number | string, photo: Buffer, filename: string, caption: string, replyMarkup?: object): Promise<boolean> {
    const token = process.env.BOT_TOKEN;
    if (!token) return false;
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('caption', caption.slice(0, 1000));
      if (replyMarkup) fd.append('reply_markup', JSON.stringify(replyMarkup));
      fd.append('photo', new Blob([photo]), filename);
      const r = await this.call(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
      if (!r.ok) this.log.warn(`sendPhoto ${r.status}`);
      return r.ok;
    } catch (e) {
      this.log.warn(`sendPhoto failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** A photo or a PDF with a caption: images go as photos, anything else as a document. */
  async sendFile(chatId: bigint | number | string, file: Buffer, filename: string, mime: string, caption: string, replyMarkup?: object): Promise<boolean> {
    if (mime.startsWith('image/')) return this.sendPhoto(chatId, file, filename, caption, replyMarkup);
    const token = process.env.BOT_TOKEN;
    if (!token) return false;
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('caption', caption.slice(0, 1000));
      if (replyMarkup) fd.append('reply_markup', JSON.stringify(replyMarkup));
      fd.append('document', new Blob([file], { type: mime }), filename);
      const r = await this.call(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
      if (!r.ok) this.log.warn(`sendDocument ${r.status}`);
      return r.ok;
    } catch (e) {
      this.log.warn(`sendDocument failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * SMS to the managers (ADMIN_SMS_NUMBERS) through Kavenegar, when KAVENEGAR_API_KEY is set.
   * Optional: without it, managers still get the Telegram message.
   */
  async sms(text: string): Promise<void> {
    const key = process.env.KAVENEGAR_API_KEY;
    const to = (process.env.ADMIN_SMS_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!key || !to.length) return;
    try {
      const body = new URLSearchParams({ receptor: to.join(','), message: text, ...(process.env.KAVENEGAR_SENDER ? { sender: process.env.KAVENEGAR_SENDER } : {}) });
      const r = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(key)}/sms/send.json`, { method: 'POST', body });
      if (!r.ok) this.log.warn(`sms ${r.status}`);
    } catch (e) {
      this.log.warn(`sms failed: ${(e as Error).message}`);
    }
  }
}
