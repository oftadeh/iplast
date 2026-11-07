import { Bot, InlineKeyboard, Context } from 'grammy';
import { PrismaClient, MessageKind } from '@iplast/db';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is not set');
const MINIAPP_URL = process.env.MINIAPP_URL ?? '';
const ids = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const SUPPORT = ids(process.env.SUPPORT_TELEGRAM_IDS);

const prisma = new PrismaClient();
const bot = new Bot(token);

let rr = 0;

/**
 * Sales-support agents: active staff defined in the admin panel (SALES, or ADMIN when there is no SALES agent),
 * plus any IDs in SUPPORT_TELEGRAM_IDS. Cached for a minute.
 */
let staffCache = { at: 0, agents: [] as number[], all: new Set<number>() };
async function staff() {
  if (Date.now() - staffCache.at < 60_000) return staffCache;
  const rows = await prisma.user.findMany({ where: { staffRole: { not: null }, isActive: true }, select: { telegramId: true, staffRole: true }, orderBy: { createdAt: 'asc' } });
  const sales = rows.filter(r => r.staffRole === 'SALES').map(r => Number(r.telegramId));
  const admins = rows.filter(r => r.staffRole === 'ADMIN').map(r => Number(r.telegramId));
  const agents = [...new Set([...(sales.length ? sales : admins), ...SUPPORT])];
  staffCache = { at: Date.now(), agents, all: new Set([...sales, ...admins, ...SUPPORT]) };
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

const openAppKeyboard = () => MINIAPP_URL ? new InlineKeyboard().webApp('🛒 باز کردن فروشگاه', MINIAPP_URL) : undefined;

bot.command('start', async ctx => {
  await ctx.reply(
    'سلام! به ربات فروش اصفهان پلاست خوش آمدید.\n\n' +
    'می‌توانید سفارش را همین‌جا بنویسید، ویس بفرستید، یا عکس و PDF لیست خریدتان را ارسال کنید تا کارشناس فروش بررسی کند.\n' +
    'برای دیدن محصولات و قیمت‌ها، فروشگاه را باز کنید.',
    { reply_markup: openAppKeyboard() },
  );
});

bot.command('id', ctx => ctx.reply(`آیدی عددی شما: ${ctx.from?.id}`));

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
      const kb = MINIAPP_URL ? new InlineKeyboard().webApp('🛒 بررسی و ثبت در سبد', `${MINIAPP_URL}${MINIAPP_URL.includes('?') ? '&' : '?'}draft=${d.draftId}`) : undefined;
      await ctx.reply(heard + d.text, { reply_markup: kb });
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
