import { BadRequestException, Body, Controller, Get, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { TelegramService } from '../common/telegram.service';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { allowedModes, salePct } from '@iplast/shared';
import { quote, saleTerms } from '../orders/pricing';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  /** Profile, the customer accounts the user belongs to (with role and default cash/cheque terms) and fellow members. */
  @Get()
  async me(@Session() s: SessionClaims) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: s.sub },
      include: {
        memberships: {
          include: {
            customer: {
              include: {
                terms: true,
                categoryDiscounts: { include: { category: { select: { slug: true, name: true } } } },
                support: { select: { firstName: true, lastName: true, username: true } },
                members: { include: { user: { select: { id: true, firstName: true, lastName: true, username: true } } } },
              },
            },
          },
        },
      },
    });
    const bonus = Number((await this.prisma.setting.findUnique({ where: { key: 'sale.appBonusPct' } }))?.value ?? 0);
    return {
      id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, staffRole: user.staffRole,
      appBonusPct: Number.isFinite(bonus) && bonus > 0 && bonus <= 20 ? bonus : 0,
      accounts: user.memberships.map(m => ({
        customerId: m.customerId, code: m.customer.code, role: m.role, name: m.customer.name, isApproved: m.customer.isApproved,
        sale: this.sale(m.customer.terms, m.customer.categoryDiscounts),
        support: m.customer.support,
        members: m.customer.members.map(x => ({ ...x.user, role: x.role })),
      })),
    };
  }

  /** My requests to join customer accounts (latest first). */
  @Get('joins')
  joins(@Session() s: SessionClaims) {
    return this.prisma.joinRequest.findMany({ where: { userId: s.sub }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, role: true, createdAt: true, customer: { select: { name: true, code: true } } } });
  }

  /**
   * Ask to join a customer account (a shop with several buyers) by its «کد مشتری». The managers and the customer's
   * sales agent hear about it in Telegram; a manager approves it in the panel.
   */
  @Post('join')
  async join(@Session() s: SessionClaims, @Body() b: { code?: string | number; note?: string; role?: string }) {
    const code = Number(String(b?.code ?? '').trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
    if (!Number.isInteger(code) || code < 1) throw new BadRequestException('کد مشتری را درست وارد کنید');
    const c = await this.prisma.customer.findUnique({ where: { code }, include: { support: true } });
    if (!c) throw new NotFoundException('مشتری‌ای با این کد پیدا نشد');
    if (await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: c.id, userId: s.sub } } })) throw new BadRequestException('شما عضو همین مجموعه هستید');
    const pending = await this.prisma.joinRequest.findFirst({ where: { userId: s.sub, customerId: c.id, status: 'PENDING' } });
    if (pending) return { id: pending.id, status: pending.status, customer: { name: c.name, code: c.code } };
    const role = b?.role === 'VIEWER' ? 'VIEWER' : 'BUYER';
    const r = await this.prisma.joinRequest.create({ data: { userId: s.sub, customerId: c.id, role, note: b?.note?.trim().slice(0, 300) || null } });
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: s.sub } });
    const who = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'کاربر';
    const admin = process.env.ADMIN_URL || (process.env.MINIAPP_URL ? `${process.env.MINIAPP_URL.replace(/\/$/, '')}/admin/` : '');
    const text = `🙋 درخواست عضویت\n${who}${u.username ? ` (@${u.username})` : ''} · آیدی ${u.telegramId}\nمی‌خواهد به «${c.name}» (کد ${c.code}) بپیوندد، به‌عنوان ${role === 'VIEWER' ? 'فقط مشاهده' : 'کارشناس خرید'}.${r.note ? `\nتوضیح: ${r.note}` : ''}\n\nدر پنل مدیریت ← مشتریان ← درخواست‌های عضویت تأیید یا رد کنید.`;
    const kb = admin ? { inline_keyboard: [[{ text: '⚙️ بررسی در پنل مدیریت', web_app: { url: `${admin}#customers/joins` } }]] } : undefined;
    const to = await this.prisma.user.findMany({ where: { isActive: true, OR: [{ staffRole: 'ADMIN' }, ...(c.supportId ? [{ id: c.supportId }] : [])] } });
    for (const t of to) await this.tg.send(t.telegramId, text, kb);
    return { id: r.id, status: r.status, customer: { name: c.name, code: c.code } };
  }

  /**
   * The customer's two ways to buy, set by the sales manager: «نقدی» % and «مدت‌دار» % off the list price (with the
   * months), and the product categories where they differ (by category slug, both values resolved).
   */
  private sale(t: { cashDiscountPct: { toString(): string }; termDiscountPct: { toString(): string }; termMonths: number; allowCash: boolean; allowTerm: boolean } | null, cats: { categoryId: string; cashPct: { toString(): string } | null; termPct: { toString(): string } | null; category: { slug: string; name: string } }[]) {
    const terms = {
      cashPct: Number(t?.cashDiscountPct.toString() ?? 0), termPct: Number(t?.termDiscountPct.toString() ?? 0), termMonths: t?.termMonths ?? 3,
      allowCash: t?.allowCash ?? true, allowTerm: t?.allowTerm ?? true,
      categories: Object.fromEntries(cats.map(c => [c.categoryId, { cash: c.cashPct === null ? null : Number(c.cashPct.toString()), term: c.termPct === null ? null : Number(c.termPct.toString()) }])),
    };
    return {
      modes: allowedModes(terms), cashPct: terms.cashPct, termPct: terms.termPct, termMonths: terms.termMonths,
      categories: Object.fromEntries(cats.map(c => [c.category.slug, { name: c.category.name, cash: salePct(terms, 'CASH', c.categoryId), term: salePct(terms, 'TERM', c.categoryId) }])),
    };
  }

  /** Prices of the given sizes for this customer: list, cash and term (personal prices win over the percentages). */
  @Post('quote')
  async quote(@Session() s: SessionClaims, @Body() body: { variantIds?: string[]; customerId?: string }) {
    const ids = Array.isArray(body?.variantIds) ? body.variantIds.slice(0, 300) : [];
    let customerId: string | null = null;
    if (body?.customerId) {
      const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: body.customerId, userId: s.sub } } });
      if (m) customerId = body.customerId;
    } else {
      // no account named: the user's only ordering account
      const ms = await this.prisma.customerMember.findMany({ where: { userId: s.sub, role: { in: ['OWNER', 'BUYER'] } }, take: 2 });
      if (ms.length === 1) customerId = ms[0].customerId;
    }
    const t = await saleTerms(this.prisma, customerId);
    const [cash, term] = await Promise.all([quote(this.prisma, ids, customerId, 'CASH', t), quote(this.prisma, ids, customerId, 'TERM', t)]);
    return Object.fromEntries([...cash.entries()].map(([k, v]) => [k, { list: v.listPrice?.toString() ?? null, cash: v.unitPrice?.toString() ?? null, term: term.get(k)?.unitPrice?.toString() ?? null }]));
  }
}
