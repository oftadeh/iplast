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
interface AgentTurn { mode: 'ai' | 'human'; messageId: string; agentTg: string | null; reply: string | null; heard: string | null; handoff: string | null; orderNumber: number | null; draftId: string | null; hasItems: boolean }
/** The AI sales agent's answer to one customer message; null when the API is unreachable (then the old relay runs). */
async function agentTurn(from: { id: number; first_name?: string; last_name?: string; username?: string }, kind: string, text?: string, fileId?: string): Promise<AgentTurn | null> {
  if (!INTERNAL_KEY) return null;
  try {
    const r = await fetch(`${API_INTERNAL_URL}/internal/agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify({ telegramId: String(from.id), firstName: from.first_name, lastName: from.last_name, username: from.username, kind, text, fileId }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) { console.error('agent http', r.status); return null; }
    return await r.json() as AgentTurn;
  } catch (e) {
    console.error('agent failed', e);
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
    await ctx.reply('📝 این اولین سفارش شماست.\nنام فروشگاه یا شرکت‌تان را بنویسید تا حساب شما ساخته و سفارش ثبت شود.', { reply_markup: { force_reply: true, input_field_placeholder: 'نام فروشگاه یا شرکت' } });
    return false;
  }
  awaitingName.delete(from.id);
  return true; // the API itself tells the customer «سفارش #… ثبت شد» and sends the order to sales
}

const ADMIN_URL = MINIAPP_URL ? `${MINIAPP_URL.replace(/\/+$/, '')}/admin/` : '';
const openAppKeyboard = () => MINIAPP_URL ? new InlineKeyboard().webApp('📱 ورود به پنل کاربری', MINIAPP_URL) : undefined;

/**
 * The «menu» button beside the message box: staff get their own panel, everyone else the customer panel (the bot's
 * default). Set per chat, and reset when someone stops being staff.
 */
const menuSet = new Set<number>();
async function syncMenus() {
  if (!MINIAPP_URL) return;
  const { panel } = await staff();
  for (const id of panel) {
    if (menuSet.has(id)) continue;
    try { await bot.api.setChatMenuButton({ chat_id: id, menu_button: { type: 'web_app', text: 'پنل مدیریت', web_app: { url: ADMIN_URL } } }); menuSet.add(id); }
    catch { /* never opened the bot yet: set on their /start */ }
  }
  for (const id of [...menuSet]) {
    if (panel.has(id)) continue;
    await bot.api.setChatMenuButton({ chat_id: id, menu_button: { type: 'default' } }).catch(() => {});
    menuSet.delete(id);
  }
}

/** The extra discount for orders placed in the app (set in the admin panel), 0 when off. */
async function appBonus() {
  const v = Number((await prisma.setting.findUnique({ where: { key: 'sale.appBonusPct' } }).catch(() => null))?.value ?? 0);
  return Number.isFinite(v) && v > 0 && v <= 20 ? v : 0;
}
const faNum = (n: number | string) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]).replace('.', '٫');

/** The customer's welcome: who we are, what the bot does, and how to start. */
function welcomeText(firstName: string | undefined, agent: string | null, bonus: number) {
  return [
    `👋 ${firstName ? `${firstName} عزیز، ` : ''}به اصفهان پلاست خوش آمدید.`,
    'تأمین لوله و اتصالات پلی‌اتیلن، شیرآلات و تجهیزات آبیاری؛ فروش عمده.',
    ...(agent ? ['', `👤 کارشناس فروش شما: ${agent}`] : []),
    '',
    'در این ربات:',
    '🏷 قیمت روز هر کالا را با تخفیف و شرایط خودتان (نقدی یا مدت‌دار) می‌بینید',
    '🛒 سفارش را در پنل کاربری ثبت می‌کنید، یا همین‌جا می‌نویسید و ویس می‌دهید',
    '📄 پیش‌فاکتور رسمی را با یک دکمه تأیید می‌کنید',
    '🚚 ارسال بار، فاکتورها و سررسید چک‌ها را دنبال می‌کنید',
    ...(bonus ? ['', `🎁 سفارش از پنل کاربری ${faNum(bonus)}٪ تخفیف بیشتر دارد.`] : []),
    '',
    MINIAPP_URL ? 'برای شروع «ورود به پنل کاربری» را بزنید.' : 'برای شروع سفارش‌تان را بنویسید.',
    'یا همین حالا بنویسید، مثلاً: «۲ کارتن نری ۶۳ در ۲ و یک کارتن سه‌راه ۵۰»',
    '',
    'راهنما: /help',
  ].join('\n');
}

/** What people see on the bot's profile before they start, and the command menu. */
async function setupProfile() {
  await bot.api.setMyDescription(
    'اصفهان پلاست | فروش عمده‌ی لوله و اتصالات پلی‌اتیلن، شیرآلات و تجهیزات آبیاری\n\n' +
    '🏷 قیمت روز با تخفیف اختصاصی شما (نقدی و مدت‌دار)\n' +
    '🛒 ثبت سفارش در پنل کاربری، یا با متن، ویس و عکس لیست خرید\n' +
    '📄 پیش‌فاکتور رسمی، پیگیری ارسال بار و حساب مالی\n\n' +
    'برای شروع «Start» را بزنید.',
  ).catch(e => console.error('description', e));
  await bot.api.setMyShortDescription('سفارش عمده‌ی لوله و اتصالات اصفهان پلاست: قیمت روز با تخفیف شما، پیش‌فاکتور و پیگیری بار').catch(e => console.error('short description', e));
  await bot.api.setMyCommands([
    { command: 'start', description: 'شروع و ورود به پنل' },
    { command: 'help', description: 'راهنمای ثبت سفارش' },
    { command: 'id', description: 'آیدی عددی من' },
  ]).catch(e => console.error('commands', e));
}

bot.command('start', async ctx => {
  const isStaff = !!ctx.from && (await staff()).panel.has(ctx.from.id);
  if (isStaff && ADMIN_URL) {
    menuSet.delete(ctx.from!.id); await syncMenus().catch(() => {});
    const role = (await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) }, select: { staffRole: true } }))?.staffRole;
    const roleFa = role === 'ADMIN' ? 'مدیر ارشد' : role === 'WAREHOUSE' ? 'انبار' : 'کارشناس فروش';
    await ctx.reply(
      `👋 سلام ${ctx.from!.first_name ?? ''}، به پنل ${roleFa} اصفهان پلاست خوش آمدید.\n\n` +
      '🔔 هر کاری که منتظر شماست همین‌جا می‌رسد و با دکمه‌ی زیر همان پیام انجامش می‌دهید:\n' +
      (role === 'WAREHOUSE'
        ? '• سفارش‌های تأییدشده برای آماده‌سازی و ارسال\n• ثبت ارسال بار و تحویل به مشتری\n'
        : '• پیش‌فاکتورهای تازه برای قیمت‌گذاری و تأیید\n• پیام مشتری‌ها (با Reply جواب بدهید)\n• رسیدهای پرداخت و یادآوری سررسید چک‌ها\n' + (role === 'ADMIN' ? '• تأیید نهایی سفارش‌ها و گزارش هفتگی فروش\n' : '')) +
      '\n⚙️ پنل مدیریت: دکمه‌ی زیر، یا دکمه‌ی «پنل مدیریت» کنار جای تایپ.\n' +
      `💻 روی کامپیوتر: ${ADMIN_URL}\n(ورود با آیدی عددی تلگرام و کد یک‌بارمصرفی که همین ربات می‌فرستد)`,
      { link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().webApp('⚙️ ورود به پنل مدیریت', ADMIN_URL) },
    );
    return;
  }
  // came through a staff member's invite link: t.me/<bot>?start=ref_<code>
  const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  let agent: string | null = null;
  if (/^ref_[a-f0-9]{6,20}$/.test(payload) && ctx.from) {
    try {
      const r = await internal<{ ok: boolean; agent?: string | null }>('/internal/referral', { telegramId: String(ctx.from.id), code: payload.slice(4), firstName: ctx.from.first_name, lastName: ctx.from.last_name, username: ctx.from.username });
      if (r.ok) agent = r.agent ?? 'اصفهان پلاست';
    } catch (e) { console.error('referral', e); }
  }
  await ctx.reply(welcomeText(ctx.from?.first_name, agent, await appBonus()), { reply_markup: openAppKeyboard() });
  // the short how-to video the manager set (sent to the bot with the caption «#آموزش»)
  const intro = await prisma.setting.findUnique({ where: { key: 'bot.introVideo' } }).catch(() => null);
  if (intro && typeof intro.value === 'string') await ctx.replyWithVideo(intro.value, { caption: '🎬 آموزش کوتاه ثبت سفارش در پنل کاربری' }).catch(e => console.error('intro video', e));
});

bot.command('id', ctx => ctx.reply(`🆔 آیدی عددی تلگرام شما: ${ctx.from?.id}\nبرای عضویت در حساب شرکت، این عدد را برای کارشناس فروش یا مدیر حساب‌تان بفرستید.`));

bot.command('help', async ctx => {
  const isStaff = !!ctx.from && (await staff()).panel.has(ctx.from.id);
  await ctx.reply(isStaff
    ? '📘 راهنمای کارکنان\n\n• پیش‌فاکتور تازه: با «تأیید کارشناس» یا «رد» زیر پیام تصمیم بگیرید؛ برای قیمت‌گذاری و تغییر اقلام، پنل مدیریت ← سفارش‌ها.\n• پیام مشتری: روی پیام کپی‌شده‌ی مشتری Reply بزنید تا جواب برایش برود.\n• سفارش تلفنی: پنل مدیریت ← سفارش‌ها ← ثبت سفارش تلفنی.\n• لینک دعوت شما: پنل مدیریت ← جذب مشتری.\n\n/admin باز کردن پنل مدیریت · /id آیدی عددی شما'
    : '📘 راهنمای ثبت سفارش\n\n1️⃣ «ورود به پنل کاربری» را بزنید؛ محصولات با قیمت و تخفیف خودتان آنجاست.\n2️⃣ کالا و تعداد را به سبد اضافه کنید، نوع خرید (نقدی یا مدت‌دار) را انتخاب و ثبت کنید.\n3️⃣ کارشناس فروش پیش‌فاکتور نهایی را می‌فرستد؛ با یک دکمه تأیید کنید.\n4️⃣ ارسال بار، فاکتور و سررسید چک‌ها همین‌جا اطلاع داده می‌شود.\n\n⚡️ راه سریع‌تر: سفارش را همین‌جا بنویسید یا ویس بدهید، مثل «۲ کارتن نری ۶۳ در ۲»؛ پیش‌نویس با قیمت روز آماده می‌شود.\n📎 عکس یا PDF لیست خرید هم قبول است.\n💬 هر سؤالی دارید همین‌جا بنویسید؛ کارشناس فروش جواب می‌دهد.',
    { reply_markup: isStaff ? undefined : openAppKeyboard() });
});

// Staff: the admin panel opens inside Telegram, signed in with their own Telegram account
bot.command('admin', async ctx => {
  if (!ctx.from || !(await staff()).panel.has(ctx.from.id)) return ctx.reply('🔒 این بخش مخصوص کارکنان اصفهان پلاست است.');
  if (!MINIAPP_URL) return ctx.reply('پنل مدیریت هنوز روی سرور فعال نشده است.');
  // the admin panel is its own app, separate from the store: open it here in Telegram, or in a browser on a computer
  const adminUrl = ADMIN_URL;
  await ctx.reply(`⚙️ پنل مدیریت اصفهان پلاست\n\n💻 روی کامپیوتر: ${adminUrl}\n(ورود با آیدی عددی تلگرام و کد یک‌بارمصرفی که همین ربات می‌فرستد)`, {
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard().webApp('⚙️ باز کردن پنل مدیریت', adminUrl),
  });
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

// The customer's buttons under a final proforma: accept it, or ask the sales agent for a change
bot.callbackQuery(/^pf:([a-z0-9]{10,40}):(ok|no)$/, async ctx => {
  try {
    const ok = ctx.match[2] === 'ok';
    const r = await internal<{ number: number; statusFa: string }>('/internal/orders/customer', { telegramId: String(ctx.from.id), orderId: ctx.match[1], ok });
    await ctx.answerCallbackQuery({ text: ok ? 'تأیید شد' : 'به کارشناس فروش خبر داده شد' });
    const old = ctx.callbackQuery.message?.text ?? '';
    await ctx.editMessageText(`${old}\n\n▫️ ${ok ? 'شما تأیید کردید؛ منتظر تأیید نهایی مدیر' : 'درخواست تغییر فرستاده شد. چه تغییری لازم است؟ همین‌جا بنویسید یا ویس بدهید.'}`).catch(() => {});
  } catch (e) {
    await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true });
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
// A manager sets the intro video: send a video to the bot with «#آموزش» in the caption
bot.on('message:video', async (ctx, next) => {
  const cap = ctx.message.caption ?? '';
  if (!/#آموزش|#intro/i.test(cap) || !ctx.from) return next();
  const me = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) }, select: { staffRole: true, isActive: true } });
  if (me?.staffRole !== 'ADMIN' || !me.isActive) return next();
  await prisma.setting.upsert({ where: { key: 'bot.introVideo' }, update: { value: ctx.message.video.file_id }, create: { key: 'bot.introVideo', value: ctx.message.video.file_id } });
  await ctx.reply('✅ این ویدیو از این به بعد بعد از /start برای مشتری‌ها فرستاده می‌شود. برای حذفش از پنل ← جذب مشتری اقدام کنید.');
});

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
  // a person answered: the AI agent steps back in this chat until it is handed back from the panel
  await prisma.conversation.update({ where: { id: original.conversationId }, data: {
    ...(agent && !original.conversation.assigneeId ? { assigneeId: agent.id } : {}),
    ...(original.conversation.handoffAt ? {} : { handoffAt: new Date(), handoffReason: 'کارشناس وارد گفتگو شد' }),
  } });
  await ctx.reply('✓ برای مشتری فرستاده شد.');
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
  const m = ctx.message;
  const fileId = m.voice?.file_id ?? m.audio?.file_id ?? m.photo?.at(-1)?.file_id ?? m.document?.file_id;
  // the AI sales agent answers first; it places the proforma and hands the chat to a person when needed
  const isVoice = !!(m.voice ?? m.audio);
  if (kind === 'TEXT' || isVoice) await ctx.replyWithChatAction('typing').catch(() => {});
  const t = await agentTurn(from, kind, m.text ?? m.caption, fileId);
  if (t && t.mode === 'ai') {
    if (t.reply) {
      const heard = t.heard ? `🎙 شنیدم: «${t.heard}»\n\n` : '';
      const kb = new InlineKeyboard();
      if (t.hasItems && t.draftId) {
        kb.text('✅ ثبت همین سفارش', `cd:${t.draftId}`);
        if (MINIAPP_URL) kb.row().webApp('🛒 ویرایش در سبد', `${MINIAPP_URL}${MINIAPP_URL.includes('?') ? '&' : '?'}draft=${t.draftId}`);
      }
      await ctx.reply(heard + t.reply, t.hasItems ? { reply_markup: kb } : {});
    }
    if (t.handoff && t.agentTg === null && (kind === 'PHOTO' || kind === 'DOCUMENT')) {
      // a file goes to the person who now has the chat
      const conv = await prisma.message.findUnique({ where: { id: t.messageId }, include: { conversation: true } });
      const agentUser = conv?.conversation.assigneeId ? await prisma.user.findUnique({ where: { id: conv.conversation.assigneeId } }) : null;
      if (agentUser) {
        const copy = await ctx.api.copyMessage(Number(agentUser.telegramId), ctx.chat.id, m.message_id).catch(() => null);
        if (copy) await prisma.message.update({ where: { id: t.messageId }, data: { relayChatId: agentUser.telegramId, relayMessageId: copy.message_id } });
      }
    }
    return;
  }

  // a person has this chat (or the agent is off): copy the message to them, as before
  let savedId = t?.messageId ?? null;
  let agent = t?.agentTg ? Number(t.agentTg) : null;
  if (!t) {
    const tg = BigInt(from.id);
    const user = await prisma.user.findUnique({ where: { telegramId: tg }, include: { memberships: { select: { customerId: true }, take: 1 } } });
    let conv = await prisma.conversation.findFirst({ where: { userTelegramId: tg, isOpen: true } });
    if (!conv) conv = await prisma.conversation.create({ data: { userTelegramId: tg, customerId: user?.memberships[0]?.customerId } });
    savedId = (await prisma.message.create({ data: { conversationId: conv.id, direction: 'IN', kind, text: m.text ?? m.caption, telegramFileId: fileId } })).id;
    await prisma.conversation.update({ where: { id: conv.id }, data: { isOpen: true } });
    agent = await pickSupport(from.id);
  }
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
  if (!agent) { await ctx.reply('✅ پیام شما دریافت شد؛ کارشناس فروش به‌زودی پاسخ می‌دهد.'); return; }
  try {
    await ctx.api.sendMessage(agent, `💬 پیام تازه از ${name}\nبرای جواب، روی پیام زیر Reply بزنید.`);
    const copy = await ctx.api.copyMessage(agent, ctx.chat.id, m.message_id);
    if (savedId) await prisma.message.update({ where: { id: savedId }, data: { relayChatId: BigInt(agent), relayMessageId: copy.message_id } });
    await ctx.reply('✅ پیام شما برای کارشناس فروش فرستاده شد؛ جوابش همین‌جا می‌آید.');
  } catch (e) {
    console.error('relay failed', agent, e);
    await ctx.reply('✅ پیام شما دریافت شد؛ کارشناس فروش به‌زودی پاسخ می‌دهد.');
  }
});

bot.catch(err => console.error('bot error', err.error));

async function main() {
  if (MINIAPP_URL) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'پنل کاربری', web_app: { url: MINIAPP_URL } } });
    await syncMenus().catch(e => console.error('menu sync', e));
    setInterval(() => syncMenus().catch(() => {}), 120_000);
  }
  await setupProfile();
  await bot.start({ onStart: me => console.log(`@${me.username} started`) });
}
main();
