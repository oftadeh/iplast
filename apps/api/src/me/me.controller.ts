import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { TelegramService } from '../common/telegram.service';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { allowedModes, salePct } from '@iplast/shared';
import { quote, saleTerms, specialsFor } from '../orders/pricing';
import { categoryTree } from '../catalog/tree';

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
    const tree = await categoryTree(this.prisma);
    return {
      id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, staffRole: user.staffRole,
      appBonusPct: Number.isFinite(bonus) && bonus > 0 && bonus <= 20 ? bonus : 0,
      accounts: user.memberships.map(m => ({
        customerId: m.customerId, code: m.customer.code, role: m.role, name: m.customer.name, isApproved: m.customer.isApproved,
        sale: this.sale(m.customer.terms, m.customer.categoryDiscounts, tree),
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
   * months), and the product categories where they differ (by category slug, both values resolved). A percent set on a
   * branch covers its sub-branches, so those are listed too; `own` marks the ones the manager set.
   */
  private sale(t: { cashDiscountPct: { toString(): string }; termDiscountPct: { toString(): string }; termMonths: number; allowCash: boolean; allowTerm: boolean } | null, cats: { categoryId: string; cashPct: { toString(): string } | null; termPct: { toString(): string } | null; category: { slug: string; name: string } }[], tree: Awaited<ReturnType<typeof categoryTree>>) {
    const terms = {
      cashPct: Number(t?.cashDiscountPct.toString() ?? 0), termPct: Number(t?.termDiscountPct.toString() ?? 0), termMonths: t?.termMonths ?? 3,
      allowCash: t?.allowCash ?? true, allowTerm: t?.allowTerm ?? true,
      categories: Object.fromEntries(cats.map(c => [c.categoryId, { cash: c.cashPct === null ? null : Number(c.cashPct.toString()), term: c.termPct === null ? null : Number(c.termPct.toString()) }])),
    };
    const set = new Set(cats.map(c => c.categoryId));
    const covered = tree.all.filter(c => tree.chain(c.id).some(id => set.has(id)));
    return {
      modes: allowedModes(terms), cashPct: terms.cashPct, termPct: terms.termPct, termMonths: terms.termMonths,
      categories: Object.fromEntries(covered.map(c => [c.slug, { name: tree.path(c.id), cash: salePct(terms, 'CASH', tree.chain(c.id)), term: salePct(terms, 'TERM', tree.chain(c.id)), own: set.has(c.id) }])),
    };
  }

  /** The ordering account a request means: the one named (if the user is a member), else their only ordering account. */
  private async accountOf(userId: string, asked?: string) {
    if (asked) {
      const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: asked, userId } } });
      return m ? asked : null;
    }
    const ms = await this.prisma.customerMember.findMany({ where: { userId, role: { in: ['OWNER', 'BUYER'] } }, take: 2 });
    return ms.length === 1 ? ms[0].customerId : null;
  }

  /**
   * «تخفیف ویژه»s this customer can get now (for everyone, or for this customer only), to show on product cards and
   * pages: the extra or fixed percent, the sale mode and the pack minimum.
   */
  @Get('offers')
  async offers(@Session() s: SessionClaims, @Query('customerId') asked?: string) {
    const customerId = await this.accountOf(s.sub, asked);
    const list = await specialsFor(this.prisma, customerId);
    if (!list.length) return [];
    const fams = await this.prisma.productFamily.findMany({ where: { id: { in: [...new Set(list.map(x => x.familyId))] }, isActive: true }, select: { id: true, slug: true, packName: true, unitName: true } });
    const byId = new Map(fams.map(f => [f.id, f]));
    return list.filter(x => byId.has(x.familyId)).map(x => {
      const f = byId.get(x.familyId)!;
      return { id: x.id, familyId: x.familyId, slug: f.slug, kind: x.kind, pct: Number(x.pct), payMode: x.payMode ?? null, minPacks: x.minPacks ?? null, packName: f.packName ?? f.unitName, note: x.note ?? null, endsAt: x.endsAt ?? null, personal: !!x.customerId };
    });
  }

  /**
   * Prices of the given sizes for this customer: list, cash and term (personal prices win over the percentages). With
   * `items` (size + units) a «تخفیف ویژه» with a pack minimum is counted, and the line says how far the next one is.
   */
  @Post('quote')
  async quote(@Session() s: SessionClaims, @Body() body: { variantIds?: string[]; items?: { variantId?: string; quantity?: number }[]; customerId?: string }) {
    const items = Array.isArray(body?.items) ? body.items.slice(0, 300).filter(i => typeof i?.variantId === 'string') : [];
    const ids = items.length ? [...new Set(items.map(i => i.variantId!))] : Array.isArray(body?.variantIds) ? body.variantIds.slice(0, 300) : [];
    const units: Record<string, number> = {};
    for (const i of items) units[i.variantId!] = (units[i.variantId!] ?? 0) + Math.max(0, Math.min(1_000_000, Math.floor(Number(i.quantity) || 0)));
    const customerId = await this.accountOf(s.sub, body?.customerId);
    const t = await saleTerms(this.prisma, customerId);
    const qty = items.length ? units : undefined;
    const [cash, term] = await Promise.all([quote(this.prisma, ids, customerId, 'CASH', t, qty), quote(this.prisma, ids, customerId, 'TERM', t, qty)]);
    const sp = (x?: { special: { pct: number } | null; next: { extra: number; minPacks: number; packName: string | null } | null }) => ({ special: x?.special?.pct ?? null, next: x?.next ? { extra: x.next.extra, minPacks: x.next.minPacks, packName: x.next.packName } : null });
    return Object.fromEntries([...cash.entries()].map(([k, v]) => [k, {
      list: v.listPrice?.toString() ?? null, cash: v.unitPrice?.toString() ?? null, term: term.get(k)?.unitPrice?.toString() ?? null,
      cashSpecial: sp(v), termSpecial: sp(term.get(k)), packOnly: v.packOnly, soldOut: v.stock === 0,
    }]));
  }
}
