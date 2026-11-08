import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { allowedModes, salePct } from '@iplast/shared';
import { quote, saleTerms } from '../orders/pricing';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

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
    return {
      id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, staffRole: user.staffRole,
      accounts: user.memberships.map(m => ({
        customerId: m.customerId, role: m.role, name: m.customer.name, isApproved: m.customer.isApproved,
        sale: this.sale(m.customer.terms, m.customer.categoryDiscounts),
        support: m.customer.support,
        members: m.customer.members.map(x => ({ ...x.user, role: x.role })),
      })),
    };
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
