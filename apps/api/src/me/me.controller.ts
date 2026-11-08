import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { quote } from '../orders/pricing';

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
                priceGroup: true,
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
        terms: m.customer.terms ? { cashPercent: m.customer.terms.cashPercent, chequeDueDays: m.customer.terms.chequeDueDays, cashDiscountPct: m.customer.terms.cashDiscountPct.toString(), chequeMarkupPct: m.customer.terms.chequeMarkupPct.toString() } : { cashPercent: 100, chequeDueDays: [] },
        support: m.customer.support,
        // the customer's own discount per product category (percent off the list price), and the default for the rest
        discounts: Object.fromEntries(m.customer.categoryDiscounts.filter(d => Number(d.pct) > 0).map(d => [d.category.slug, { name: d.category.name, pct: Number(d.pct) }])),
        defaultDiscount: m.customer.priceGroup ? Number(m.customer.priceGroup.discountPct) : 0,
        members: m.customer.members.map(x => ({ ...x.user, role: x.role })),
      })),
    };
  }

  /** Personal prices for the given sizes (falls back to the list price). */
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
    return Object.fromEntries([...(await quote(this.prisma, ids, customerId)).entries()].map(([k, v]) => [k, v.unitPrice]));
  }
}
