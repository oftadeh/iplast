import { BadRequestException, Body, Controller, Get, Headers, Param, Post, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { timingSafeEqual } from 'node:crypto';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService, STATUS_FA } from '../orders/orders.service';
import { audit } from '../common/audit';
import { AssistantService } from './assistant.service';

function checkKey(key: string | undefined) {
  const want = process.env.INTERNAL_KEY ?? '';
  if (!want || !key || key.length !== want.length || !timingSafeEqual(Buffer.from(key), Buffer.from(want))) throw new UnauthorizedException();
}
const tgId = (v: unknown) => { if (!/^\d{4,15}$/.test(String(v ?? ''))) throw new BadRequestException(); return BigInt(String(v)); };

/** The customer's default account (for personal prices), if they belong to exactly one or pass one they belong to. */
async function accountOf(prisma: PrismaService, userId: string, customerId?: string) {
  const ms = await prisma.customerMember.findMany({ where: { userId } });
  if (customerId) return ms.some(m => m.customerId === customerId) ? customerId : null;
  return ms[0]?.customerId ?? null;
}

@Controller('assistant')
export class AssistantController {
  constructor(private readonly ai: AssistantService, private readonly prisma: PrismaService) {}

  @Get('status') status() { return { enabled: this.ai.enabled }; }

  /** Free-text order («دو کارتن نری ۶۳ در ۲») → draft cart. */
  @Post('order')
  @UseGuards(SessionGuard)
  async order(@Session() s: SessionClaims, @Body() b: { text?: string; customerId?: string }) {
    return this.ai.draft(s.sub, String(b?.text ?? ''), 'miniapp', await accountOf(this.prisma, s.sub, b?.customerId));
  }

  /** Recorded voice → text → draft cart. */
  @Post('voice')
  @UseGuards(SessionGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async voice(@Session() s: SessionClaims, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('فایل صوتی نرسید');
    const text = await this.ai.transcribe(file.buffer, file.originalname || 'voice.webm');
    return this.ai.draft(s.sub, text, 'miniapp-voice', await accountOf(this.prisma, s.sub));
  }

  @Get('drafts/:id')
  @UseGuards(SessionGuard)
  async draft(@Session() s: SessionClaims, @Param('id') id: string) {
    const v = await this.ai.view(id, s.sub, await accountOf(this.prisma, s.sub));
    await this.prisma.assistantDraft.update({ where: { id }, data: { usedAt: new Date() } });
    return v;
  }
}

/** Called only by the bot container, with the shared INTERNAL_KEY; never exposed by Caddy (see Caddyfile). */
@Controller('internal/assistant')
export class InternalAssistantController {
  constructor(private readonly ai: AssistantService, private readonly prisma: PrismaService, private readonly orders: OrdersService) {}

  @Post()
  async fromBot(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; firstName?: string; username?: string; text?: string; fileId?: string }) {
    checkKey(key);
    if (!this.ai.enabled) return { enabled: false };
    const tg = tgId(b.telegramId);
    const user = await this.prisma.user.upsert({ where: { telegramId: tg }, create: { telegramId: tg, firstName: b.firstName, username: b.username }, update: {} });
    let text = String(b.text ?? '');
    let heard: string | null = null;
    if (b.fileId) {
      const f = await this.ai.telegramFile(b.fileId);
      text = heard = await this.ai.transcribe(f.buf, f.name.endsWith('.oga') ? f.name.replace(/\.oga$/, '.ogg') : f.name);
    }
    const v = await this.ai.draft(user.id, text, b.fileId ? 'bot-voice' : 'bot-text', await accountOf(this.prisma, user.id));
    return { enabled: true, draftId: v.id, hasItems: v.lines.length > 0, heard, text: this.ai.chatText(v) };
  }

  /**
   * «✅ ثبت سفارش» under an assistant draft in the bot chat: places the draft as an order.
   * The first order of a new customer needs a company name; the bot asks for it and calls again.
   */
  @Post('confirm')
  async confirm(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; draftId?: string; companyName?: string; note?: string }) {
    checkKey(key);
    const user = await this.prisma.user.findUnique({ where: { telegramId: tgId(b.telegramId) } });
    const d = b.draftId ? await this.prisma.assistantDraft.findUnique({ where: { id: String(b.draftId) } }) : null;
    if (!user || !d || d.userId !== user.id) throw new BadRequestException('پیش‌نویس پیدا نشد');
    const ms = await this.prisma.customerMember.findMany({ where: { userId: user.id, role: { in: ['OWNER', 'BUYER'] } } });
    const others = ms.length ? 0 : await this.prisma.customerMember.count({ where: { userId: user.id } });
    if (!ms.length && others) throw new BadRequestException('دسترسی ثبت سفارش برای حساب شما فعال نیست؛ با مدیر حساب شرکت هماهنگ کنید');
    const name = b.companyName?.trim();
    if (!ms.length && !name) return { needName: true };
    const items = (d.items as unknown as { variantId: string; quantity: number; packs: number | null }[]).map(i => ({ variantId: i.variantId, quantity: i.quantity, ...(i.packs ? { packs: i.packs } : {}) }));
    const o = await this.orders.create(user.id, {
      customerId: ms[0]?.customerId, newCustomer: ms.length ? undefined : { name }, items, idempotencyKey: `draft:${d.id}`,
      note: [b.note?.trim(), `سفارش از ربات: «${d.inputText.slice(0, 300)}»`].filter(Boolean).join('\n'),
    }, 'bot');
    await this.prisma.assistantDraft.update({ where: { id: d.id }, data: { usedAt: new Date() } });
    return { orderNumber: o.number, status: o.statusFa };
  }
}

/** Order status buttons under the new-order message that staff get in the bot. */
@Controller('internal/orders')
export class InternalOrdersController {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrdersService) {}

  @Post('status')
  async status(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; orderId?: string; status?: string }) {
    checkKey(key);
    const tg = tgId(b.telegramId);
    const support = (process.env.SUPPORT_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).includes(String(tg));
    const staff = await this.prisma.user.findUnique({ where: { telegramId: tg } });
    if (!staff?.isActive || (!staff.staffRole && !support)) throw new UnauthorizedException();
    const status = b.status as keyof typeof STATUS_FA;
    if (!['CONFIRMED', 'SALES_REVIEW', 'REJECTED'].includes(String(status))) throw new BadRequestException('وضعیت نامعتبر است');
    const r = await this.orders.setStatus(staff.id, String(b.orderId), status);
    await audit(this.prisma, staff.id, 'order.status', 'Order', String(b.orderId), { status: r.before }, { status, via: 'bot' });
    return { number: r.number, statusFa: STATUS_FA[status] };
  }
}
