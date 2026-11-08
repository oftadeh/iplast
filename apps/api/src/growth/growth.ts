import { BadRequestException, Body, Controller, Get, Headers, Injectable, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { formatRial } from '@iplast/shared';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { OrdersService } from '../orders/orders.service';
import { audit } from '../common/audit';
import { checkKey, tgId } from '../assistant/assistant.controller';

const secret = () => { const s = process.env.JWT_SECRET; if (!s) throw new Error('JWT_SECRET'); return s; };
const fa = (v: unknown) => String(v ?? '').trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٫/]/, '.');

/** A staff member's invite code, made the first time it is asked for. */
async function codeOf(prisma: PrismaService, userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { refCode: true } });
  if (u.refCode) return u.refCode;
  for (;;) {
    const code = randomBytes(5).toString('hex');
    try { return (await prisma.user.update({ where: { id: userId }, data: { refCode: code } })).refCode!; } catch { /* taken: try another */ }
  }
}

/**
 * Bringing customers into the app: each staff member's invite link (t.me/<bot>?start=ref_<code>), the extra
 * discount for orders placed in the app, and the intro video the bot sends new customers.
 */
@Controller('admin/growth')
@UseGuards(SessionGuard)
@Staff('ADMIN', 'SALES')
export class AdminGrowthController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly orders: OrdersService) {}

  @Get()
  async get(@Session() s: SessionClaims) {
    const bot = await this.tg.username();
    const link = (code: string) => `https://t.me/${bot}?start=ref_${code}`;
    const staff = await this.prisma.user.findMany({
      where: { staffRole: { in: ['ADMIN', 'SALES'] }, isActive: true, ...(s.staff === 'ADMIN' ? {} : { id: s.sub }) },
      select: { id: true, firstName: true, lastName: true, staffRole: true, refCode: true, _count: { select: { referrals: true, supportOf: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const rows = [];
    for (const u of staff) rows.push({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'بی‌نام', role: u.staffRole, link: link(u.refCode ?? (await codeOf(this.prisma, u.id))), joined: u._count.referrals, customers: u._count.supportOf, me: u.id === s.sub });
    const intro = await this.prisma.setting.findUnique({ where: { key: 'bot.introVideo' } });
    const introState = intro?.value === 'off' ? 'off' : intro ? 'custom' : 'default';
    return { bot, botLink: `https://t.me/${bot}`, appBonusPct: await this.orders.appBonusPct(), intro: introState, staff: rows };
  }

  @Put()
  @Staff('ADMIN')
  async set(@Session() s: SessionClaims, @Body() b: { appBonusPct?: string | number; clearIntro?: boolean; introDefault?: boolean }) {
    if (b.appBonusPct !== undefined) {
      const n = Number(fa(b.appBonusPct) || 0);
      if (!Number.isFinite(n) || n < 0 || n > 20) throw new BadRequestException('تخفیف سفارش از اپ باید بین ۰ تا ۲۰ درصد باشد');
      const v = Math.round(n * 100) / 100;
      await this.prisma.setting.upsert({ where: { key: 'sale.appBonusPct' }, update: { value: v }, create: { key: 'sale.appBonusPct', value: v } });
      await audit(this.prisma, s.sub, 'setting.appBonus', 'Setting', 'sale.appBonusPct', null, { value: v });
    }
    if (b.clearIntro) await this.prisma.setting.upsert({ where: { key: 'bot.introVideo' }, update: { value: 'off' }, create: { key: 'bot.introVideo', value: 'off' } });
    if (b.introDefault) await this.prisma.setting.deleteMany({ where: { key: 'bot.introVideo' } });
    return this.get(s);
  }
}

/** The bot reports a /start ref_<code>: the newcomer is linked to that staff member, who becomes their agent. */
@Controller('internal/referral')
export class InternalReferralController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  @Post()
  async join(@Headers('x-internal-key') key: string | undefined, @Body() b: { telegramId?: string; code?: string; firstName?: string; lastName?: string; username?: string }) {
    checkKey(key);
    const ref = await this.prisma.user.findUnique({ where: { refCode: String(b.code ?? '-') } });
    if (!ref?.isActive || !ref.staffRole) return { ok: false };
    const t = tgId(b.telegramId);
    const u = await this.prisma.user.upsert({ where: { telegramId: t }, create: { telegramId: t, firstName: b.firstName, lastName: b.lastName, username: b.username, referredById: ref.id }, update: {} });
    if (u.staffRole || u.id === ref.id) return { ok: false };
    let isNew = false;
    if (!u.referredById) { await this.prisma.user.update({ where: { id: u.id }, data: { referredById: ref.id } }); isNew = true; }
    else isNew = u.referredById === ref.id && Date.now() - u.createdAt.getTime() < 60_000;
    // an existing customer with no agent yet gets this one
    const ms = await this.prisma.customerMember.findMany({ where: { userId: u.id }, select: { customerId: true } });
    await this.prisma.customer.updateMany({ where: { id: { in: ms.map(m => m.customerId) }, supportId: null }, data: { supportId: ref.id } });
    if (isNew) {
      const who = [b.firstName, b.lastName].filter(Boolean).join(' ') + (b.username ? ` (@${b.username})` : '');
      await this.tg.send(ref.telegramId, `🎉 ${who || 'یک کاربر'} با لینک دعوت شما وارد ربات شد. با اولین سفارش، مشتری شما ثبت می‌شود.`);
    }
    return { ok: true, agent: [ref.firstName, ref.lastName].filter(Boolean).join(' ') || null };
  }
}

/** A read-only link to one proforma (for the customer's accountant), valid for 14 days. */
@Controller()
export class ShareController {
  constructor(private readonly orders: OrdersService, private readonly prisma: PrismaService) {}

  @Post('orders/:id/share')
  @UseGuards(SessionGuard)
  async share(@Session() s: SessionClaims, @Param('id') id: string) {
    await this.orders.get(s.sub, id, !!s.staff); // checks the user may see it
    const token = jwt.sign({ o: id, k: 'pf' }, secret(), { expiresIn: '14d' });
    const base = (process.env.MINIAPP_URL ?? '').replace(/\/+$/, '');
    return { url: `${base}/?doc=${token}`, expiresDays: 14 };
  }

  @Get('public/proforma/:token')
  async view(@Param('token') token: string) {
    let id: string;
    try { const c = jwt.verify(token, secret()) as { o?: string; k?: string }; if (c.k !== 'pf' || !c.o) throw new Error(); id = c.o; }
    catch { throw new NotFoundException('لینک پیش‌فاکتور نامعتبر است یا منقضی شده است'); }
    const o = await this.orders.get('-', id, true);
    // only what the document shows
    const { events: _e, documents: _d, shipments: _s, ...doc } = o as typeof o & { events?: unknown; documents?: unknown; shipments?: unknown };
    return doc;
  }
}

/** Saturday morning (Tehran) the managers get last week in one message: sales, orders, money, agents. */
@Injectable()
export class WeeklyReport {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, orders: OrdersService) {
    orders.ticks.push(async () => { await this.run(); });
  }

  async run(now = new Date(), force = false) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now).map(p => [p.type, p.value]));
    if (!force && (parts.weekday !== 'Sat' || Number(parts.hour) < 9 || Number(parts.hour) >= 13)) return;
    const key = 'report.weekly', stamp = now.toISOString().slice(0, 10);
    if (!force && (await this.prisma.setting.findUnique({ where: { key } }))?.value === stamp) return;
    const p = this.prisma, week = new Date(now.getTime() - 7 * 864e5), next = new Date(now.getTime() + 7 * 864e5);
    const [inv, prev, orders, delivered, newCust, chequesDue, issued, paid, byAgent, agents] = await Promise.all([
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: week } }, _sum: { total: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED', issuedAt: { gte: new Date(week.getTime() - 7 * 864e5), lt: week } }, _sum: { total: true } }),
      p.order.count({ where: { createdAt: { gte: week } } }),
      p.order.count({ where: { status: 'DELIVERED', updatedAt: { gte: week } } }),
      p.customer.count({ where: { createdAt: { gte: week } } }),
      p.payment.aggregate({ where: { method: 'CHEQUE', status: 'PENDING', dueDate: { lte: next } }, _sum: { amount: true }, _count: true }),
      p.invoice.aggregate({ where: { status: 'ISSUED' }, _sum: { total: true } }),
      p.payment.aggregate({ where: { status: 'CLEARED' }, _sum: { amount: true } }),
      p.invoice.findMany({ where: { status: 'ISSUED', issuedAt: { gte: week } }, select: { total: true, customer: { select: { supportId: true } } } }),
      p.user.findMany({ where: { staffRole: 'SALES', isActive: true }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const sum = new Map<string, bigint>();
    for (const i of byAgent) if (i.customer.supportId) sum.set(i.customer.supportId, (sum.get(i.customer.supportId) ?? 0n) + i.total);
    const agentLines = agents.map(a => ({ n: [a.firstName, a.lastName].filter(Boolean).join(' ') || 'بی‌نام', v: sum.get(a.id) ?? 0n })).sort((a, b) => (b.v > a.v ? 1 : -1)).slice(0, 5).map(a => `• ${a.n}: ${formatRial(a.v)}`);
    const s = inv._sum.total ?? 0n, ps = prev._sum.total ?? 0n;
    const change = ps > 0n ? ` (${s >= ps ? '▲' : '▼'} ${Math.abs(Number(((s - ps) * 100n) / ps))}٪)` : '';
    const text = [
      '📊 گزارش هفتگی اصفهان پلاست',
      '',
      `فروش هفته: ${formatRial(s)}${change} در ${inv._count} فاکتور`,
      `سفارش جدید: ${orders} · تحویل‌شده: ${delivered} · مشتری جدید: ${newCust}`,
      `طلب از مشتریان: ${formatRial((issued._sum.total ?? 0n) - (paid._sum.amount ?? 0n))}`,
      `چک‌های سررسید هفته‌ی آینده: ${chequesDue._count} فقره، ${formatRial(chequesDue._sum.amount ?? 0n)}`,
      ...(agentLines.length ? ['', 'فروش کارشناسان:', ...agentLines] : []),
    ].join('\n');
    const admin = (process.env.MINIAPP_URL ?? '').replace(/\/+$/, '');
    const kb = admin ? { inline_keyboard: [[{ text: '⚙️ پنل مدیریت', web_app: { url: `${admin}/admin/` } }]] } : undefined;
    for (const a of await p.user.findMany({ where: { staffRole: 'ADMIN', isActive: true } })) await this.tg.send(a.telegramId, text, kb);
    await p.setting.upsert({ where: { key }, update: { value: stamp }, create: { key, value: stamp } });
    return text;
  }
}
