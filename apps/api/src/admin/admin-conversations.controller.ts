import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { req } from '../common/validate';
import { audit } from '../common/audit';
import { SalesAgentService } from '../assistant/sales-agent.service';

/** Customer messages sent to the bot (text, voice, photo, PDF), readable and answerable from the admin panel too. */
@Controller('admin/conversations')
@UseGuards(SessionGuard)
@Staff()
export class AdminConversationsController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly agent: SalesAgentService) {}

  @Get()
  async list(@Session() s: SessionClaims, @Query('mine') mine?: string, @Query('open') open?: string, @Query('mode') mode?: string) {
    const convs = await this.prisma.conversation.findMany({
      where: {
        ...(mine === '1' ? { assigneeId: s.sub } : {}), ...(open === '0' ? { isOpen: false } : open === '1' ? { isOpen: true } : {}),
        ...(mode === 'human' ? { handoffAt: { not: null }, isOpen: true } : mode === 'ai' ? { handoffAt: null } : {}),
      },
      orderBy: { updatedAt: 'desc' }, take: 100,
      include: { customer: { select: { id: true, name: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const users = await this.prisma.user.findMany({ where: { telegramId: { in: convs.map(c => c.userTelegramId) } }, select: { telegramId: true, firstName: true, lastName: true, username: true } });
    const staff = await this.prisma.user.findMany({ where: { id: { in: convs.map(c => c.assigneeId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true } });
    return convs.map(c => ({
      ...c, last: c.messages[0] ?? null, messages: undefined,
      user: users.find(u => u.telegramId === c.userTelegramId) ?? null,
      assignee: staff.find(x => x.id === c.assigneeId) ?? null,
    }));
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id }, include: { customer: { select: { id: true, name: true } }, messages: { orderBy: { createdAt: 'asc' }, take: 500 } } });
    if (!c) throw new NotFoundException();
    const user = await this.prisma.user.findUnique({ where: { telegramId: c.userTelegramId }, select: { firstName: true, lastName: true, username: true } });
    const authors = await this.prisma.user.findMany({ where: { id: { in: c.messages.map(m => m.byUserId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true } });
    return { ...c, user, messages: c.messages.map(m => ({ ...m, by: authors.find(a => a.id === m.byUserId)?.firstName ?? null })) };
  }

  /** Text answer from the panel; delivered through the bot. */
  @Post(':id/reply')
  async reply(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { text?: string }) {
    const text = req(b?.text, 'متن پاسخ خالی است').trim().slice(0, 3500);
    const c = await this.prisma.conversation.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    const ok = await this.tg.send(c.userTelegramId, text);
    if (!ok) throw new BadRequestException('ارسال به تلگرام ناموفق بود');
    await this.prisma.message.create({ data: { conversationId: id, direction: 'OUT', kind: 'TEXT', text, byUserId: s.sub } });
    // a person answered: the AI agent steps back until someone hands the chat back to it
    await this.prisma.conversation.update({ where: { id }, data: { assigneeId: c.assigneeId ?? s.sub, isOpen: true, handoffAt: c.handoffAt ?? new Date(), handoffReason: c.handoffReason ?? 'کارشناس وارد گفتگو شد' } });
    return { ok: true };
  }

  /** Hand the chat back to the AI sales agent. */
  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    if (!(await this.prisma.conversation.findUnique({ where: { id } }))) throw new NotFoundException();
    await this.agent.resume(id);
    return { ok: true };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() b: { isOpen?: boolean; assigneeId?: string | null }) {
    if (!(await this.prisma.conversation.findUnique({ where: { id } }))) throw new NotFoundException();
    return this.prisma.conversation.update({
      where: { id },
      data: { ...(b.isOpen !== undefined ? { isOpen: !!b.isOpen } : {}), ...(b.assigneeId !== undefined ? { assigneeId: b.assigneeId || null } : {}) },
    });
  }

  /** Deletes a chat and its messages for good (test chats, or a customer who asks). Managers only. */
  @Delete(':id')
  @Staff('ADMIN')
  async remove(@Session() s: SessionClaims, @Param('id') id: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id }, include: { _count: { select: { messages: true } } } });
    if (!c) throw new NotFoundException();
    await this.prisma.conversation.delete({ where: { id } });
    // the AI agent's unfinished draft for this person goes too, so a fresh chat starts clean
    const u = await this.prisma.user.findUnique({ where: { telegramId: c.userTelegramId }, select: { id: true } });
    if (u) await this.prisma.assistantDraft.deleteMany({ where: { userId: u.id, usedAt: null } });
    await audit(this.prisma, s.sub, 'conversation.delete', 'Conversation', id, { messages: c._count.messages, userTelegramId: String(c.userTelegramId) }, null);
    return { ok: true, messages: c._count.messages };
  }

  /** Streams a voice note, photo or PDF the customer sent, fetched from Telegram. */
  @Get('files/:messageId')
  async file(@Param('messageId') messageId: string, @Res() res: Response) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m?.telegramFileId) throw new NotFoundException();
    const token = process.env.BOT_TOKEN;
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(m.telegramFileId)}`).then(r => r.json()).catch(() => null) as { ok?: boolean; result?: { file_path?: string } } | null;
    if (!info?.ok || !info.result?.file_path) throw new NotFoundException('فایل در تلگرام پیدا نشد (فایل‌های بالای ۲۰ مگابایت از ربات قابل دریافت نیستند)');
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!r.ok || !r.body) throw new NotFoundException();
    const ext = info.result.file_path.split('.').pop()?.toLowerCase() ?? '';
    const type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', oga: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  }
}
