import { BadRequestException, Body, Controller, Get, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { audit } from '../common/audit';

const AUDIENCES = ['sales', 'staff', 'customers', 'customer', 'city', 'category'] as const;
type Audience = typeof AUDIENCES[number];
const AUDIENCE_FA: Record<Audience, string> = { sales: 'کارشناسان فروش', staff: 'همه‌ی کارکنان', customers: 'همه‌ی مشتریان', customer: 'یک مشتری', city: 'مشتریان یک شهر', category: 'خریداران یک دسته' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Manager → bot messages: to sales staff, all staff, every customer, or the users of one customer. */
@Controller('admin/broadcasts')
@UseGuards(SessionGuard)
@Staff('ADMIN')
export class AdminBroadcastController {
  private readonly log = new Logger('Broadcast');
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  private async recipients(audience: Audience, customerId?: string, target?: string) {
    if (audience === 'city' || audience === 'category') {
      const where = audience === 'city'
        ? { isApproved: true, city: { contains: target ?? '-' } }
        : { isApproved: true, orders: { some: { items: { some: { variant: { family: { categoryId: target ?? '-' } } } } } } };
      const members = await this.prisma.customerMember.findMany({ where: { customer: where, user: { isActive: true } }, select: { user: { select: { id: true, telegramId: true } } } });
      return [...new Map(members.map(m => [m.user.id, m.user])).values()];
    }
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

  private parse(audience?: string, customerId?: string, target?: string) {
    if (!AUDIENCES.includes(audience as Audience)) throw new BadRequestException('گیرنده را انتخاب کنید');
    if ((audience === 'city' || audience === 'category') && !target?.trim()) throw new BadRequestException(audience === 'city' ? 'شهر را انتخاب کنید' : 'دسته‌ی کالا را انتخاب کنید');
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
  async count(@Query('audience') audience?: string, @Query('customerId') customerId?: string, @Query('target') target?: string) {
    return { count: (await this.recipients(this.parse(audience, customerId, target), customerId, target)).length };
  }

  /** Cities of approved customers and product categories, for the targeted audiences. */
  @Get('targets')
  async targets() {
    const [cities, cats] = await Promise.all([
      this.prisma.customer.groupBy({ by: ['city'], where: { isApproved: true, city: { not: null } }, _count: true }),
      this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    ]);
    return { cities: cities.filter(c => c.city?.trim()).map(c => ({ city: c.city!, n: c._count })).sort((a, b) => b.n - a.n), categories: cats };
  }

  /** «قیمت‌ها از … تغییر می‌کند» or «لیست قیمت جدید منتشر شد», to every customer, with the panel button. */
  @Post('price-notice')
  async priceNotice(@Session() s: SessionClaims, @Body() b: { kind?: string; when?: string; note?: string }) {
    const when = String(b?.when ?? '').trim().slice(0, 60);
    const note = String(b?.note ?? '').trim().slice(0, 600);
    let text: string;
    if (b?.kind === 'upcoming') {
      if (!when) throw new BadRequestException('تاریخ تغییر قیمت را بنویسید');
      text = `⏰ قیمت‌ها از ${when} تغییر می‌کند.\n\nتا آن روز می‌توانید با قیمت فعلی سفارش دهید؛ سفارش‌هایی که پیش از تغییر ثبت شوند با قیمت امروز پیش‌فاکتور می‌شوند.`;
    } else {
      const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
      text = `🏷 لیست قیمت جدید${list ? ` («${list.title}»)` : ''} منتشر شد.\n\nقیمت‌های روز با درصد و شرایط خودتان در پنل کاربری است.`;
    }
    if (note) text += `\n\n${note}`;
    return this.send(s, { audience: 'customers', text, withButton: true });
  }

  @Post()
  async send(@Session() s: SessionClaims, @Body() b: { audience?: string; customerId?: string; target?: string; text?: string; withButton?: boolean }) {
    const audience = this.parse(b?.audience, b?.customerId, b?.target);
    const text = String(b.text ?? '').trim();
    if (text.length < 2) throw new BadRequestException('متن پیام را بنویسید');
    if (text.length > 3500) throw new BadRequestException('پیام طولانی است (حداکثر ۳۵۰۰ حرف)');
    const to = await this.recipients(audience, b.customerId, b.target);
    if (!to.length) throw new BadRequestException('گیرنده‌ای پیدا نشد');
    const forCustomers = audience !== 'sales' && audience !== 'staff';
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
