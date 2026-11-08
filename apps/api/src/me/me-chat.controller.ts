import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SalesAgentService } from '../assistant/sales-agent.service';
import type { Response } from 'express';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { AssistantService } from '../assistant/assistant.service';

/**
 * Chat inside the mini app; the same conversation as the bot chat. The AI sales agent answers first and places
 * the proforma; once it hands the chat to a person, messages reach that sales agent in Telegram (a Reply there
 * comes back here) and everything shows in the admin panel.
 */
@Controller('me/chat')
@UseGuards(SessionGuard)
export class MeChatController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly ai: AssistantService, private readonly agent: SalesAgentService) {}

  private async user(s: SessionClaims) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: s.sub },
      include: { memberships: { include: { customer: { select: { id: true, name: true, support: { select: { id: true, telegramId: true, firstName: true, lastName: true, isActive: true, staffRole: true } } } } } } },
    });
  }

  @Get()
  async get(@Session() s: SessionClaims) {
    const u = await this.user(s);
    if (u.staffRole) return { staff: true, messages: [], agent: null, ai: this.agent.enabled, human: false };
    const conv = await this.prisma.conversation.findFirst({ where: { userTelegramId: u.telegramId }, orderBy: { updatedAt: 'desc' }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 300 } } });
    const fixed = u.memberships.find(m => m.customer.support?.isActive)?.customer.support;
    const agentId = conv?.assigneeId ?? fixed?.id;
    const agent = agentId ? await this.prisma.user.findUnique({ where: { id: agentId }, select: { firstName: true, lastName: true } }) : null;
    return {
      staff: false, ai: this.agent.enabled, agent, human: !!conv?.handoffAt && !!conv?.isOpen,
      messages: (conv?.messages ?? []).map(m => ({ id: m.id, direction: m.direction, kind: m.kind, text: m.text, hasFile: !!m.telegramFileId, createdAt: m.createdAt })),
    };
  }

  @Post()
  async send(@Session() s: SessionClaims, @Body() b: { text?: string }) {
    const text = String(b?.text ?? '').trim().slice(0, 3500);
    if (!text) throw new BadRequestException('پیام خالی است');
    return this.turn(s, { kind: 'TEXT', text });
  }

  /** A voice note recorded in the mini app: the AI agent transcribes and answers it. */
  @Post('voice')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async voice(@Session() s: SessionClaims, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('فایل صوتی نرسید');
    return this.turn(s, { kind: 'VOICE', audio: { buf: file.buffer, name: file.originalname || 'voice.webm' } });
  }

  private async turn(s: SessionClaims, input: { kind: 'TEXT' | 'VOICE'; text?: string; audio?: { buf: Buffer; name: string } }) {
    const u = await this.user(s);
    if (u.staffRole) throw new BadRequestException('کارکنان از پنل مدیریت ← گفتگوها پاسخ می‌دهند');
    const t = await this.agent.handle(s.sub, input);
    if (t.mode === 'human') {
      // a person handles this chat: pass the message on to them in Telegram (a Reply there comes back here)
      let text = input.text ?? '';
      if (input.audio) { try { text = '🎙 ' + await this.ai.transcribe(input.audio.buf, input.audio.name); } catch { text = '🎙 پیام صوتی (از مینی‌اپ؛ متنش خوانده نشد)'; } await this.prisma.message.update({ where: { id: t.messageId }, data: { text } }); }
      const conv = await this.prisma.conversation.findUnique({ where: { id: t.conversationId } });
      const fixed = u.memberships.find(m => m.customer.support?.isActive)?.customer.support ?? null;
      const a = await this.agent.agentFor(conv?.assigneeId ?? null, fixed);
      if (a) {
        if (conv && !conv.assigneeId) await this.prisma.conversation.update({ where: { id: conv.id }, data: { assigneeId: a.id } });
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');
        await this.tg.send(a.telegramId, `پیام از ${name}${u.memberships[0] ? ` · ${u.memberships[0].customer.name}` : ''} (مینی‌اپ)\nبرای پاسخ روی پیام زیر Reply بزنید.`);
        const id = await this.tg.sendForId(a.telegramId, text);
        if (id) await this.prisma.message.update({ where: { id: t.messageId }, data: { relayChatId: a.telegramId, relayMessageId: id } });
      }
    }
    return { ok: true, draft: t.draft ?? null, orderNumber: t.orderNumber ?? null, ...(await this.get(s)) };
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

}
