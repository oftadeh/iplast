import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { AssistantService } from '../assistant/assistant.service';

/**
 * Chat with the customer's sales agent inside the mini app. It is the same conversation as the bot chat:
 * messages sent here reach the agent in Telegram (a Reply there comes back here) and appear in the admin panel.
 * When the order assistant is on, an order-like message also gets a draft cart from the assistant.
 */
@Controller('me/chat')
@UseGuards(SessionGuard)
export class MeChatController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly ai: AssistantService) {}

  private async user(s: SessionClaims) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: s.sub },
      include: { memberships: { include: { customer: { select: { id: true, name: true, support: { select: { id: true, telegramId: true, firstName: true, lastName: true, isActive: true, staffRole: true } } } } } } },
    });
  }

  @Get()
  async get(@Session() s: SessionClaims) {
    const u = await this.user(s);
    if (u.staffRole) return { staff: true, messages: [], agent: null, ai: this.ai.enabled };
    const conv = await this.prisma.conversation.findFirst({ where: { userTelegramId: u.telegramId }, orderBy: { updatedAt: 'desc' }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 300 } } });
    const fixed = u.memberships.find(m => m.customer.support?.isActive)?.customer.support;
    const agentId = conv?.assigneeId ?? fixed?.id;
    const agent = agentId ? await this.prisma.user.findUnique({ where: { id: agentId }, select: { firstName: true, lastName: true } }) : null;
    return {
      staff: false, ai: this.ai.enabled, agent,
      messages: (conv?.messages ?? []).map(m => ({ id: m.id, direction: m.direction, kind: m.kind, text: m.text, hasFile: !!m.telegramFileId, createdAt: m.createdAt })),
    };
  }

  @Post()
  async send(@Session() s: SessionClaims, @Body() b: { text?: string; assistant?: boolean }) {
    const text = String(b?.text ?? '').trim().slice(0, 3500);
    if (!text) throw new BadRequestException('پیام خالی است');
    const u = await this.user(s);
    if (u.staffRole) throw new BadRequestException('کارکنان از پنل مدیریت ← گفتگوها پاسخ می‌دهند');
    const account = u.memberships[0]?.customer;
    let conv = await this.prisma.conversation.findFirst({ where: { userTelegramId: u.telegramId, isOpen: true } });
    if (!conv) conv = await this.prisma.conversation.create({ data: { userTelegramId: u.telegramId, customerId: account?.id } });
    const saved = await this.prisma.message.create({ data: { conversationId: conv.id, direction: 'IN', kind: 'TEXT', text } });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { isOpen: true } });

    // to the agent in Telegram, the same way the bot relays messages (a Reply there comes back to the customer)
    const agentTg = await this.pickAgent(conv.assigneeId, u.memberships.find(m => m.customer.support?.isActive)?.customer.support?.telegramId);
    if (agentTg) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');
      await this.tg.send(agentTg, `پیام از ${name}${account ? ` · ${account.name}` : ''} (از مینی‌اپ)\nبرای پاسخ، روی پیام زیر Reply بزنید یا از پنل مدیریت ← گفتگوها جواب دهید.`);
      const id = await this.tg.sendForId(agentTg, text);
      if (id) await this.prisma.message.update({ where: { id: saved.id }, data: { relayChatId: agentTg, relayMessageId: id } });
    }

    let draft: unknown = null;
    if (b?.assistant !== false && this.ai.enabled) {
      try {
        const d = await this.ai.draft(s.sub, text, 'miniapp-chat', account?.id ?? null);
        if (d.lines.length) {
          draft = d;
          await this.prisma.message.create({ data: { conversationId: conv.id, direction: 'OUT', kind: 'TEXT', text: `[دستیار]\n${d.reply}` } });
          if (agentTg) await this.tg.send(agentTg, `🤖 پیش‌نویس دستیار:\n${this.ai.chatText(d)}`);
        }
      } catch { /* the agent still has the message; the assistant is a bonus */ }
    }
    return { ok: true, draft, ...(await this.get(s)) };
  }

  /** A voice note, photo or PDF from the agent in this customer's own conversation. */
  @Get('files/:id')
  async file(@Session() s: SessionClaims, @Param('id') id: string, @Res() res: Response) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: s.sub } });
    const m = await this.prisma.message.findUnique({ where: { id }, include: { conversation: true } });
    if (!m?.telegramFileId || m.conversation.userTelegramId !== u.telegramId) throw new NotFoundException();
    const f = await this.tg.download(m.telegramFileId);
    if (!f) throw new NotFoundException('فایل در تلگرام پیدا نشد');
    res.setHeader('Content-Type', f.type); res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(f.body);
  }

  /** The assigned agent, else the customer's fixed agent, else the active sales agent with the fewest open chats. */
  private async pickAgent(assigneeId: string | null, fixedTg?: bigint): Promise<bigint | null> {
    if (assigneeId) {
      const a = await this.prisma.user.findUnique({ where: { id: assigneeId } });
      if (a?.isActive && a.staffRole) return a.telegramId;
    }
    if (fixedTg) return fixedTg;
    const agents = await this.prisma.user.findMany({ where: { staffRole: 'SALES', isActive: true }, include: { _count: { select: { supportOf: true } } } });
    const pool = agents.length ? agents : await this.prisma.user.findMany({ where: { staffRole: 'ADMIN', isActive: true }, include: { _count: { select: { supportOf: true } } } });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)].telegramId;
  }
}
