import { Bot, InlineKeyboard, Context } from 'grammy';
import { PrismaClient, MessageKind } from '@iplast/db';
import { Agent } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:tls';
import type { Socket } from 'node:net';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is not set');
const MINIAPP_URL = process.env.MINIAPP_URL ?? '';
const ids = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const SUPPORT = ids(process.env.SUPPORT_TELEGRAM_IDS);

const prisma = new PrismaClient();
// On a server that reaches Telegram only through a proxy, HTTPS_PROXY is set in .env.
// grammY uses its own HTTP client (node-fetch), which ignores HTTPS_PROXY, so requests go through an agent
// that opens an HTTP CONNECT tunnel to the proxy and runs TLS to Telegram inside it.
class TunnelAgent extends Agent {
  private proxy: URL;
  constructor(proxy: string) {
    super({ keepAlive: true });
    this.proxy = new URL(proxy);
  }
  createConnection(o: { host?: string; port?: number; servername?: string }, cb: (err: Error | null, s?: Socket) => void) {
    const target = `${o.host}:${o.port || 443}`;
    const req = request({ host: this.proxy.hostname, port: Number(this.proxy.port) || 80, method: 'CONNECT', path: target, headers: { host: target } });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`proxy CONNECT ${target} → ${res.statusCode}`));
      }
      cb(null, connect({ ...(o as object), socket, servername: o.servername || o.host }));
    });
    req.once('error', e => cb(e));
    req.end();
    return undefined;
  }
}
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxied = !!proxyUrl;
const bot = new Bot(token, proxied
  ? { client: { baseFetchConfig: { agent: new TunnelAgent(proxyUrl!), compress: true } } }
  : undefined);

let rr = 0;

/**
 * Sales-support agents: active staff defined in the admin panel (SALES, or ADMIN when there is no SALES agent),
 * plus any IDs in SUPPORT_TELEGRAM_IDS. Cached for a minute.
 */
let staffCache = { at: 0, agents: [] as number[], all: new Set<number>(), panel: new Set<number>() };
async function staff() {
  if (Date.now() - staffCache.at < 60_000) return staffCache;
  const rows = await prisma.user.findMany({ where: { staffRole: { not: null }, isActive: true }, select: { telegramId: true, staffRole: true }, orderBy: { createdAt: 'asc' } });
  const sales = rows.filter(r => r.staffRole === 'SALES').map(r => Number(r.telegramId));
  const admins = rows.filter(r => r.staffRole === 'ADMIN').map(r => Number(r.telegramId));
  const agents = [...new Set([...(sales.length ? sales : admins), ...SUPPORT])];
  staffCache = { at: Date.now(), agents, all: new Set([...sales, ...admins, ...SUPPORT]), panel: new Set(rows.map(r => Number(r.telegramId))) };
  return staffCache;
}

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:3000/api';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? '';

/**
 * Order assistant (OpenAI, in the API service): turns a text or voice order into a draft cart.
 * Returns null when the assistant is off or found nothing to order, so the human agent handles it alone.
 */
async function assistantDraft(from: { id: number; first_name?: string; username?: string }, text?: string, fileId?: string) {
  if (!INTERNAL_KEY || process.env.ASSISTANT_IN_BOT === '0') return null;
  try {
    const r = await fetch(`${API_INTERNAL_URL}/internal/assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify({ telegramId: String(from.id), firstName: from.first_name, username: from.username, text, fileId }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return null;
    const j = await r.json() as { enabled: boolean; draftId?: string; hasItems?: boolean; heard?: string | null; text?: string };
    return j.enabled && j.hasItems ? j : null;
  } catch (e) {
    console.error('assistant failed', e);
    return null;
  }
}

/** POST to the API's internal routes; returns the JSON body, or throws with the API's Persian message. */
async function internal<T>(path: string, body: object): Promise<T> {
  const r = await fetch(`${API_INTERNAL_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({})) as T & { message?: string };
  if (!r.ok) throw new Error(typeof j.message === 'string' ? j.message : 'خطا در ثبت');
  return j;
}

/** Customers asked for their company name before their first order: telegram id → draft id. */
const awaitingName = new Map<number, { draftId: string; at: number }>();

async function confirmDraft(ctx: Context, draftId: string, companyName?: string) {
  const from = ctx.from!;
  const r = await internal<{ needName?: boolean; orderNumber?: number }>('/internal/assistant/confirm', { telegramId: String(from.id), draftId, companyName });
  if (r.needName) {
    awaitingName.set(from.id, { draftId, at: Date.now() });
    await ctx.reply('این اولین سفارش شماست. نام فروشگاه یا شرکت‌تان را بنویسید تا سفارش ثبت شود.', { reply_markup: { force_reply: true, input_field_placeholder: 'نام فروشگاه یا شرکت' } });
    return false;
  }
  awaitingName.delete(from.id);
  return true; // the API itself tells the customer «سفارش #… ثبت شد» and sends the order to sales
}

const openAppKeyboard = () => MINIAPP_URL ? new InlineKeyboard().webApp('🛒 باز کردن فروشگاه', MINIAPP_URL) : undefined;

bot.command('start', async ctx => {
  await ctx.reply(
    'سلام! به ربات فروش اصفهان پلاست خوش آمدید.\n\n' +
    'می‌توانید سفارش را همین‌جا بنویسید، ویس بفرستید، یا عکس و PDF لیست خریدتان را ارسال کنید تا کارشناس فروش بررسی کند.\n' +
    (MINIAPP_URL ? 'برای دیدن محصولات و قیمت‌ها، فروشگاه را باز کنید.' : 'مثلاً بنویسید: «دو کارتن نری ۶۳ در ۲ و یک کارتن سه‌راه ۵۰». پیش‌نویس سفارش با قیمت روز آماده می‌شود و با یک دکمه ثبت می‌کنید.'),
    { reply_markup: openAppKeyboard() },
  );
});

bot.command('id', ctx => ctx.reply(`آیدی عددی شما: ${ctx.from?.id}`));

// Staff: the admin panel opens inside Telegram, signed in with their own Telegram account
bot.command('admin', async ctx => {
  if (!ctx.from || !(await staff()).panel.has(ctx.from.id)) return ctx.reply('این بخش فقط برای کارکنان اصفهان پلاست است.');
  if (!MINIAPP_URL) return ctx.reply('پنل مدیریت هنوز روی سرور فعال نشده است.');
  await ctx.reply('پنل مدیریت اصفهان پلاست:', { reply_markup: new InlineKeyboard().webApp('⚙️ باز کردن پنل مدیریت', `${MINIAPP_URL.replace(/\/+$/, '')}/admin/`) });
});

function kindOf(ctx: Context): MessageKind | null {
  const m = ctx.message;
  if (!m) return null;
  if (m.voice || m.audio) return 'VOICE';
  if (m.photo) return 'PHOTO';
  if (m.document) return 'DOCUMENT';
  if (m.text) return 'TEXT';
  return null;
}

async function pickSupport(customerTelegramId: number): Promise<number | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(customerTelegramId) },
    include: { memberships: { include: { customer: { include: { support: true } } } } },
  });
  const fixed = user?.memberships.find(m => m.customer.support?.isActive)?.customer.support;
  if (fixed) return Number(fixed.telegramId);
  const { agents } = await staff();
  if (!agents.length) return null;
  return agents[rr++ % agents.length];
}

// «✅ ثبت این سفارش» under an assistant draft
bot.callbackQuery(/^cd:([a-z0-9]{10,40})$/, async ctx => {
  try {
    const done = await confirmDraft(ctx, ctx.match[1]);
    await ctx.answerCallbackQuery(done ? { text: 'سفارش ثبت شد' } : {});
    if (done) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  } catch (e) {
    await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true });
  }
});

// Proforma buttons: «تأیید کارشناس» for the sales agent, «تأیید نهایی» for managers, «رد» for both
bot.callbackQuery(/^os:([a-z0-9]{10,40}):(sales_ok|final_ok|reject|prep|ship|delivered)$/, async ctx => {
  try {
    const r = await internal<{ number: number; statusFa: string }>('/internal/orders/decide', { telegramId: String(ctx.from.id), orderId: ctx.match[1], action: ctx.match[2] });
    await ctx.answerCallbackQuery({ text: `سفارش #${r.number}: ${r.statusFa}` });
    const who = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const old = ctx.callbackQuery.message?.text ?? '';
    const next = ctx.match[2] === 'prep' ? { reply_markup: new InlineKeyboard().text('🚚 ارسال شد', `os:${ctx.match[1]}:ship`) }
      : ctx.match[2] === 'ship' ? { reply_markup: new InlineKeyboard().text('✅ تحویل مشتری شد', `os:${ctx.match[1]}:delivered`) } : {};
    await ctx.editMessageText(`${old}\n\n▫️ ${r.statusFa} (${who})`, next).catch(() => {});
  } catch (e) {
    const m = (e as Error).message;
    await ctx.answerCallbackQuery({ text: m === 'Unauthorized' ? 'فقط کارکنان فروش' : m, show_alert: true });
  }
});

// Receipt photo buttons: the agent or a manager accepts or rejects a payment the customer sent
bot.callbackQuery(/^pay:([a-z0-9]{10,40}):(ok|no)$/, async ctx => {
  try {
    const r = await internal<{ statusFa: string }>('/internal/payments/review', { telegramId: String(ctx.from.id), paymentId: ctx.match[1], ok: ctx.match[2] === 'ok' });
    await ctx.answerCallbackQuery({ text: r.statusFa });
    const who = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const old = ctx.callbackQuery.message?.caption ?? '';
    await ctx.editMessageCaption({ caption: `${old}\n\n▫️ ${r.statusFa} (${who})` }).catch(() => {});
  } catch (e) {
    const m = (e as Error).message;
    await ctx.answerCallbackQuery({ text: m === 'Unauthorized' ? 'فقط کارکنان فروش' : m, show_alert: true });
  }
});

// Staff replying (Telegram "reply") to a copied customer message → the answer goes back through the bot.
bot.on('message', async (ctx, next) => {
  const from = ctx.from?.id;
  const replyTo = ctx.message.reply_to_message;
  if (!from || !replyTo || !(await staff()).all.has(from)) return next();
  const original = await prisma.message.findFirst({
    where: { relayChatId: BigInt(ctx.chat.id), relayMessageId: replyTo.message_id },
    include: { conversation: true },
  });
  if (!original) return next();
  const target = Number(original.conversation.userTelegramId);
  await ctx.copyMessage(target);
  const agent = await prisma.user.findUnique({ where: { telegramId: BigInt(from) } });
  const kind = kindOf(ctx) ?? 'TEXT';
  const m = ctx.message;
  await prisma.message.create({
    data: {
      conversationId: original.conversationId, direction: 'OUT', kind, text: m.text ?? m.caption, byUserId: agent?.id,
      telegramFileId: m.voice?.file_id ?? m.audio?.file_id ?? m.photo?.at(-1)?.file_id ?? m.document?.file_id,
    },
  });
  if (agent && !original.conversation.assigneeId) await prisma.conversation.update({ where: { id: original.conversationId }, data: { assigneeId: agent.id } });
  await ctx.reply('✓ برای مشتری ارسال شد.');
});

// Customer messages (text, voice, photo, PDF) → stored and copied to a sales-support agent.
bot.on('message', async ctx => {
  const from = ctx.from;
  const kind = kindOf(ctx);
  if (!from || !kind) return;
  const st = await staff();
  if (st.all.has(from.id)) {
    if (!ctx.message.reply_to_message) await ctx.reply('برای پاسخ به مشتری، روی پیام کپی‌شده‌ی او Reply بزنید.');
    return;
  }
  const pending = awaitingName.get(from.id);
  if (pending && Date.now() - pending.at > 30 * 60_000) awaitingName.delete(from.id);
  else if (pending && kind === 'TEXT' && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const name = ctx.message.text.trim().slice(0, 120);
    try { await confirmDraft(ctx, pending.draftId, name); } catch (e) { await ctx.reply((e as Error).message); }
    return;
  }
  const tg = BigInt(from.id);
  const user = await prisma.user.findUnique({ where: { telegramId: tg }, include: { memberships: { select: { customerId: true, customer: { select: { name: true } } }, take: 1 } } });
  let conv = await prisma.conversation.findFirst({ where: { userTelegramId: tg, isOpen: true } });
  if (!conv) conv = await prisma.conversation.create({ data: { userTelegramId: tg, customerId: user?.memberships[0]?.customerId } });
  const m = ctx.message;
  const fileId = m.voice?.file_id ?? m.audio?.file_id ?? m.photo?.at(-1)?.file_id ?? m.document?.file_id;
  const saved = await prisma.message.create({
    data: { conversationId: conv.id, direction: 'IN', kind, text: m.text ?? m.caption, telegramFileId: fileId },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { isOpen: true } }); // bumps updatedAt for the panel list
  const agent = await pickSupport(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
  const company = user?.memberships[0]?.customer.name;
  if (!agent) await ctx.reply('پیام شما ثبت شد. کارشناس فروش به‌زودی پاسخ می‌دهد.');
  else try {
    await ctx.api.sendMessage(agent, `پیام از ${name}${company ? ` · ${company}` : ''}\nبرای پاسخ، روی پیام زیر Reply بزنید.`);
    const copy = await ctx.api.copyMessage(agent, ctx.chat.id, m.message_id);
    await prisma.message.update({ where: { id: saved.id }, data: { relayChatId: BigInt(agent), relayMessageId: copy.message_id } });
    await ctx.reply('پیام شما برای کارشناس فروش ارسال شد.');
  } catch (e) {
    // the agent has not started the bot yet, or blocked it
    console.error('relay failed', agent, e);
    await ctx.reply('پیام شما ثبت شد. کارشناس فروش به‌زودی پاسخ می‌دهد.');
  }

  // The assistant drafts a cart from text or voice orders; the human agent still sees and answers everything.
  if (kind === 'TEXT' || kind === 'VOICE') {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const d = await assistantDraft(from, m.text, m.voice?.file_id ?? m.audio?.file_id);
    if (d?.text && d.draftId) {
      const heard = d.heard ? `🎙 شنیدم: «${d.heard}»\n\n` : '';
      const kb = new InlineKeyboard().text('✅ ثبت همین سفارش', `cd:${d.draftId}`);
      if (MINIAPP_URL) kb.row().webApp('🛒 ویرایش در سبد', `${MINIAPP_URL}${MINIAPP_URL.includes('?') ? '&' : '?'}draft=${d.draftId}`);
      const tip = MINIAPP_URL ? '' : '\n\nبرای تغییر، سفارش اصلاح‌شده را دوباره بفرستید.';
      await ctx.reply(heard + d.text + tip, { reply_markup: kb });
      await prisma.message.create({ data: { conversationId: conv.id, direction: 'OUT', kind: 'TEXT', text: `[دستیار]\n${heard}${d.text}` } });
      if (agent) await ctx.api.sendMessage(agent, `🤖 پیش‌نویس دستیار برای ${name}:\n${heard}${d.text}`).catch(() => {});
    }
  }
});

bot.catch(err => console.error('bot error', err.error));

async function main() {
  if (MINIAPP_URL) await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'فروشگاه', web_app: { url: MINIAPP_URL } } });
  await bot.start({ onStart: me => console.log(`@${me.username} started`) });
}
main();
