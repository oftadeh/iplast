import { BadRequestException, Body, Controller, Get, Headers, Param, Post, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { timingSafeEqual } from 'node:crypto';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantService } from './assistant.service';

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
  constructor(private readonly ai: AssistantService, private readonly prisma: PrismaService) {}

  @Post()
  async fromBot(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; firstName?: string; username?: string; text?: string; fileId?: string }) {
    const want = process.env.INTERNAL_KEY ?? '';
    if (!want || !key || key.length !== want.length || !timingSafeEqual(Buffer.from(key), Buffer.from(want))) throw new UnauthorizedException();
    if (!this.ai.enabled) return { enabled: false };
    if (!/^\d{4,15}$/.test(String(b.telegramId ?? ''))) throw new BadRequestException();
    const tg = BigInt(b.telegramId!);
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
}
