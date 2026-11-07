import { Bot, InlineKeyboard, Context } from 'grammy';
import { PrismaClient, MessageKind } from '@iplast/db';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is not set');
const MINIAPP_URL = process.env.MINIAPP_URL ?? '';
const ids = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const SUPPORT = ids(process.env.SUPPORT_TELEGRAM_IDS);

const prisma = new PrismaClient();
const bot = new Bot(token);

// Which customer chat a forwarded copy in a support chat belongs to: support message id -> customer chat id.
const relay = new Map<string, number>();
let rr = 0;

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
  if (!SUPPORT.length) return null;
  return SUPPORT[rr++ % SUPPORT.length];
}

// Staff replying (Telegram "reply") to a forwarded customer message → answer goes back through the bot.
bot.on('message', async (ctx, next) => {
  const from = ctx.from?.id;
  const replyTo = ctx.message.reply_to_message;
  if (!from || !SUPPORT.includes(from) || !replyTo) return next();
  const target = relay.get(`${ctx.chat.id}:${replyTo.message_id}`);
  if (!target) return next();
  await ctx.copyMessage(target);
  await ctx.reply('✓ برای مشتری ارسال شد.');
});

// Customer messages (text, voice, photo, PDF) → stored and forwarded to a sales-support agent.
bot.on('message', async ctx => {
  const from = ctx.from;
  const kind = kindOf(ctx);
  if (!from || !kind || SUPPORT.includes(from.id)) return;
  const tg = BigInt(from.id);
  let conv = await prisma.conversation.findFirst({ where: { userTelegramId: tg, isOpen: true } });
  if (!conv) conv = await prisma.conversation.create({ data: { userTelegramId: tg } });
  const m = ctx.message;
  const fileId = m.voice?.file_id ?? m.audio?.file_id ?? m.photo?.at(-1)?.file_id ?? m.document?.file_id;
  await prisma.message.create({
    data: { conversationId: conv.id, direction: 'IN', kind, text: m.text ?? m.caption, telegramFileId: fileId },
  });
  const agent = await pickSupport(from.id);
  if (!agent) {
    await ctx.reply('پیام شما ثبت شد. کارشناس فروش به‌زودی پاسخ می‌دهد.');
    return;
  }
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
  await ctx.api.sendMessage(agent, `پیام از ${name}\nبرای پاسخ، روی پیام زیر Reply بزنید.`);
  const copy = await ctx.api.copyMessage(agent, ctx.chat.id, m.message_id);
  relay.set(`${agent}:${copy.message_id}`, ctx.chat.id);
  await ctx.reply('پیام شما برای کارشناس فروش ارسال شد.');
});

bot.catch(err => console.error('bot error', err.error));

async function main() {
  if (MINIAPP_URL) await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'فروشگاه', web_app: { url: MINIAPP_URL } } });
  await bot.start({ onStart: me => console.log(`@${me.username} started`) });
}
main();
