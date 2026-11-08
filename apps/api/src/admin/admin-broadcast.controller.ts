import { BadRequestException, Body, Controller, Get, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { audit } from '../common/audit';

const AUDIENCES = ['sales', 'staff', 'customers', 'customer'] as const;
type Audience = typeof AUDIENCES[number];
const AUDIENCE_FA: Record<Audience, string> = { sales: 'کارشناسان فروش', staff: 'همه‌ی کارکنان', customers: 'همه‌ی مشتریان', customer: 'یک مشتری' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Manager → bot messages: to sales staff, all staff, every customer, or the users of one customer. */
@Controller('admin/broadcasts')
@UseGuards(SessionGuard)
@Staff('ADMIN')
export class AdminBroadcastController {
  private readonly log = new Logger('Broadcast');
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  private async recipients(audience: Audience, customerId?: string) {
    if (audience === 'sales' || audience === 'staff') {
      return this.prisma.user.findMany({ where: { isActive: true, staffRole: audience === 'sales' ? 'SALES' : { not: null } }, select: { id: true, telegramId: true } });
    }
    if (audience === 'customers') {
      // everyone who has opened the shop in Telegram and is not staff
      return this.prisma.user.findMany({ where: { isActive: true, staffRole: null }, select: { id: true, telegramId: true } });
    }
    const members = await this.prisma.customerMember.findMany({
      where: { customerId: customerId ?? '-' },
      select: { user: { select: { id: true, telegramId: true, isActive: true } } },
    });
    const seen = new Map<string, { id: string; telegramId: bigint }>();
    for (const m of members) if (m.user.isActive) seen.set(m.user.id, m.user);
    return [...seen.values()];
  }

  private parse(audience?: string, customerId?: string) {
    if (!AUDIENCES.includes(audience as Audience)) throw new BadRequestException('گیرنده را انتخاب کنید');
    if (audience === 'customer' && !customerId) throw new BadRequestException('مشتری را انتخاب کنید');
    return audience as Audience;
  }

  @Get()
  async list() {
    const rows = await this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
    const custs = await this.prisma.customer.findMany({ where: { id: { in: rows.map(r => r.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return rows.map(r => ({ ...r, audienceFa: r.audience === 'customer' ? custs.find(c => c.id === r.customerId)?.name ?? 'مشتری' : AUDIENCE_FA[r.audience as Audience] }));
  }

  /** How many people a message would reach, shown before sending. */
  @Get('count')
  async count(@Query('audience') audience?: string, @Query('customerId') customerId?: string) {
    return { count: (await this.recipients(this.parse(audience, customerId), customerId)).length };
  }

  @Post()
  async send(@Session() s: SessionClaims, @Body() b: { audience?: string; customerId?: string; text?: string; withButton?: boolean }) {
    const audience = this.parse(b?.audience, b?.customerId);
    const text = String(b.text ?? '').trim();
    if (text.length < 2) throw new BadRequestException('متن پیام را بنویسید');
    if (text.length > 3500) throw new BadRequestException('پیام طولانی است (حداکثر ۳۵۰۰ حرف)');
    const to = await this.recipients(audience, b.customerId);
    if (!to.length) throw new BadRequestException('گیرنده‌ای پیدا نشد');
    const forCustomers = audience === 'customers' || audience === 'customer';
    const withButton = !!b.withButton && forCustomers && !!process.env.MINIAPP_URL;
    const row = await this.prisma.broadcast.create({ data: { audience, customerId: audience === 'customer' ? b.customerId : null, text, withButton, recipients: to.length, createdById: s.sub } });
    await audit(this.prisma, s.sub, 'broadcast.send', 'Broadcast', row.id, null, { audience, customerId: b.customerId, recipients: to.length });
    const body = `${forCustomers ? '📢 پیام اصفهان پلاست' : '📢 پیام مدیریت'}\n\n${text}`;
    const kb = withButton ? { inline_keyboard: [[{ text: '📱 ورود به پنل کاربری', web_app: { url: process.env.MINIAPP_URL! } }]] } : undefined;
    // Sent in the background (Telegram allows about 30 messages a second); the panel reads the counts back.
    void (async () => {
      let sent = 0, failed = 0;
      for (const u of to) {
        (await this.tg.send(u.telegramId, body, kb)) ? sent++ : failed++;
        if ((sent + failed) % 20 === 0) await this.prisma.broadcast.update({ where: { id: row.id }, data: { sent, failed } });
        await sleep(40);
      }
      await this.prisma.broadcast.update({ where: { id: row.id }, data: { sent, failed } });
      this.log.log(`broadcast ${row.id}: ${sent} sent, ${failed} failed`);
    })().catch(e => this.log.warn(`broadcast ${row.id} stopped: ${(e as Error).message}`));
    return { id: row.id, recipients: to.length };
  }
}
