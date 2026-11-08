import { BadRequestException, Body, Controller, Get, Headers, Param, Post, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { timingSafeEqual } from 'node:crypto';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService, STATUS_FA } from '../orders/orders.service';
import { audit } from '../common/audit';
import { AssistantService } from './assistant.service';
import { AccountingService } from '../accounting/accounting';
import { SalesAgentService } from './sales-agent.service';

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

  /** Buttons under the proforma messages: sales_ok, final_ok, reject. */
  @Post('decide')
  async decide(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; orderId?: string; action?: string }) {
    checkKey(key);
    const staff = await this.prisma.user.findUnique({ where: { telegramId: tgId(b.telegramId) } });
    if (!staff?.isActive || !staff.staffRole) throw new UnauthorizedException();
    if (!['sales_ok', 'final_ok', 'reject', 'prep', 'ship', 'delivered'].includes(String(b.action))) throw new BadRequestException('کار نامعتبر است');
    const before = await this.prisma.order.findUnique({ where: { id: String(b.orderId) }, select: { status: true, number: true } });
    const r = await this.orders.decide(staff.id, String(b.orderId), String(b.action));
    await audit(this.prisma, staff.id, 'order.decide', 'Order', String(b.orderId), before, { action: b.action, status: r.status, via: 'bot' });
    return { number: before?.number, status: r.status, statusFa: STATUS_FA[r.status] };
  }

  /** «تأیید پیش‌فاکتور» / «تغییر می‌خواهم» under the final proforma the customer gets. */
  @Post('customer')
  async customer(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; orderId?: string; ok?: boolean }) {
    checkKey(key);
    const u = await this.prisma.user.findUnique({ where: { telegramId: tgId(b.telegramId) } });
    if (!u) throw new UnauthorizedException();
    return this.orders.customerDecide(u.id, String(b.orderId), b.ok !== false);
  }
}

/** Buttons under a receipt photo a customer sent: the agent or a manager accepts or rejects it. */
@Controller('internal/payments')
export class InternalPaymentsController {
  constructor(private readonly prisma: PrismaService, private readonly acc: AccountingService) {}

  @Post('review')
  async review(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; paymentId?: string; ok?: boolean }) {
    checkKey(key);
    const staff = await this.prisma.user.findUnique({ where: { telegramId: tgId(b.telegramId) } });
    if (!staff?.isActive || !staff.staffRole) throw new UnauthorizedException();
    return this.acc.review(staff.id, String(b.paymentId), !!b.ok);
  }
}

/** Every customer message the bot receives goes to the AI sales agent first (bot container only, INTERNAL_KEY). */
@Controller('internal/agent')
export class InternalAgentController {
  constructor(private readonly agent: SalesAgentService, private readonly prisma: PrismaService) {}

  @Post()
  async message(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; firstName?: string; lastName?: string; username?: string; kind?: string; text?: string; fileId?: string }) {
    checkKey(key);
    const tg = tgId(b.telegramId);
    const user = await this.prisma.user.upsert({
      where: { telegramId: tg }, create: { telegramId: tg, firstName: b.firstName?.slice(0, 60), lastName: b.lastName?.slice(0, 60), username: b.username?.slice(0, 60) },
      update: { ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}), ...(b.username ? { username: b.username.slice(0, 60) } : {}) },
      include: { memberships: { include: { customer: { select: { support: { select: { id: true, telegramId: true, isActive: true } } } } } } },
    });
    const kind = (['TEXT', 'VOICE', 'PHOTO', 'DOCUMENT'] as const).find(k => k === b.kind) ?? 'TEXT';
    const t = await this.agent.handle(user.id, { kind, text: b.text?.slice(0, 3500) ?? null, fileId: b.fileId ?? null });
    let agentTg: string | null = null;
    if (t.mode === 'human') {
      const conv = await this.prisma.conversation.findUnique({ where: { id: t.conversationId } });
      const fixed = user.memberships.find(m => m.customer.support?.isActive)?.customer.support ?? null;
      const a = await this.agent.agentFor(conv?.assigneeId ?? null, fixed);
      if (a && conv && !conv.assigneeId) await this.prisma.conversation.update({ where: { id: conv.id }, data: { assigneeId: a.id } });
      agentTg = a ? String(a.telegramId) : null;
    }
    return {
      mode: t.mode, messageId: t.messageId, agentTg, reply: t.reply ?? null, heard: t.heard ?? null, handoff: t.handoff ?? null,
      orderNumber: t.orderNumber ?? null, draftId: t.draft?.id ?? null, hasItems: !!t.draft?.lines.length,
    };
  }
}
