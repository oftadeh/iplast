import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@iplast/db';
import { formatRial, splitCashCheque } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { int, req } from '../common/validate';
import { quote } from './pricing';

export interface OrderInput {
  customerId?: string;
  newCustomer?: { name?: string; city?: string };
  items?: { variantId?: string; quantity?: number; packs?: number }[];
  note?: string;
  idempotencyKey?: string;
}

export const STATUS_FA: Record<OrderStatus, string> = {
  SUBMITTED: 'ثبت‌شده', SALES_REVIEW: 'در بررسی واحد فروش', NEEDS_FIX: 'نیاز به اصلاح', PROFORMA_SENT: 'پیش‌فاکتور صادر شد',
  PROFORMA_EXPIRED: 'پیش‌فاکتور منقضی شد', CONFIRMED: 'تأیید شد', PREPARING: 'در حال آماده‌سازی', SHIPPED: 'ارسال شد',
  DELIVERED: 'تحویل شد', REJECTED: 'رد شد', CANCELLED: 'لغو شد',
};

const DEFAULT_TERMS = { cashPercent: 100, chequeDueDays: [] as number[], cashDiscountPct: '0', chequeMarkupPct: '0' };

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  /** Customer accounts the user may order for (OWNER or BUYER). */
  private async orderableCustomer(userId: string, customerId?: string) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId, role: { in: ['OWNER', 'BUYER'] } } });
    if (customerId) {
      if (!ms.some(m => m.customerId === customerId)) throw new ForbiddenException('شما عضو این حساب مشتری نیستید');
      return customerId;
    }
    return ms.length === 1 ? ms[0].customerId : null;
  }

  async create(userId: string, input: OrderInput, channel = 'miniapp') {
    const items = req(input.items, 'سبد خالی است');
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new BadRequestException('سبد خالی است');
    if (input.idempotencyKey) {
      const dup = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (dup) return this.get(userId, dup.id);
    }
    let customerId = await this.orderableCustomer(userId, input.customerId);
    if (!customerId) {
      const existing = await this.prisma.customerMember.count({ where: { userId } });
      if (existing) throw new BadRequestException('حساب مشتری را انتخاب کنید');
      const name = req(input.newCustomer?.name, 'نام فروشگاه یا شرکت را وارد کنید').trim().slice(0, 120);
      const c = await this.prisma.customer.create({
        data: { name, city: input.newCustomer?.city?.slice(0, 60), members: { create: { userId, role: 'OWNER' } } },
      });
      customerId = c.id;
    }
    const lines = items.map(i => ({ variantId: req(i.variantId, 'کالا نامعتبر است'), quantity: int(i.quantity, 'تعداد نامعتبر است', 1, 1_000_000), packs: i.packs === undefined ? null : int(i.packs, 'تعداد کارتن نامعتبر است', 1, 100_000) }));
    const q = await quote(this.prisma, lines.map(l => l.variantId), customerId);
    for (const l of lines) if (!q.has(l.variantId)) throw new BadRequestException('یکی از کالاها موجود نیست');
    const terms = await this.prisma.paymentTerms.findUnique({ where: { customerId } });
    const list = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
    const order = await this.prisma.order.create({
      data: {
        customerId, placedById: userId, channel, note: input.note?.slice(0, 1000), idempotencyKey: input.idempotencyKey,
        priceListId: list?.id,
        termsSnapshot: terms ? { cashPercent: terms.cashPercent, chequeDueDays: terms.chequeDueDays, cashDiscountPct: terms.cashDiscountPct.toString(), chequeMarkupPct: terms.chequeMarkupPct.toString() } : DEFAULT_TERMS,
        items: { create: lines.map(l => { const x = q.get(l.variantId)!; return { variantId: l.variantId, title: x.title, quantity: l.quantity, packs: l.packs, unitPrice: x.unitPrice, priceStatus: x.unitPrice === null ? 'INQUIRY' : 'PRICED' }; }) },
        events: { create: { status: 'SUBMITTED', byUserId: userId } },
      },
      include: { items: true, customer: { include: { support: true } }, placedBy: true },
    });
    await this.notifyNewOrder(order.id);
    return this.get(userId, order.id);
  }

  orderTotal(items: { quantity: number; unitPrice: bigint | null }[]) {
    return items.reduce((s, i) => s + (i.unitPrice ?? 0n) * BigInt(i.quantity), 0n);
  }

  private async notifyNewOrder(orderId: string) {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, customer: { include: { support: true } }, placedBy: true } });
    const total = this.orderTotal(o.items);
    const inq = o.items.filter(i => i.unitPrice === null).length;
    const who = [o.placedBy.firstName, o.placedBy.lastName].filter(Boolean).join(' ') || `کاربر ${o.placedBy.telegramId}`;
    const lines = o.items.slice(0, 40).map((i, n) => `${n + 1}. ${i.title} — ${i.packs ? `${i.packs} بسته (${i.quantity})` : i.quantity}${i.unitPrice === null ? ' — استعلامی' : ''}`);
    if (o.items.length > 40) lines.push(`… و ${o.items.length - 40} قلم دیگر`);
    const text = `🧾 سفارش جدید #${o.number}\nمشتری: ${o.customer.name}\nثبت‌کننده: ${who}${o.placedBy.username ? ` (@${o.placedBy.username})` : ''}\n\n${lines.join('\n')}\n\n${o.items.length} قلم${inq ? ` (${inq} استعلامی)` : ''} · جمع تقریبی: ${formatRial(total)}${o.note ? `\nتوضیح: ${o.note}` : ''}`;
    // staff can move the order on right from the chat (handled by the bot), also when there is no admin panel yet
    const kb = { inline_keyboard: [[
      { text: '✅ تأیید', callback_data: `os:${o.id}:CONFIRMED` },
      { text: '🕓 در بررسی', callback_data: `os:${o.id}:SALES_REVIEW` },
      { text: '❌ رد', callback_data: `os:${o.id}:REJECTED` },
    ]] };
    const targets = new Set<string>();
    if (o.customer.support?.isActive) targets.add(String(o.customer.support.telegramId));
    else for (const id of (process.env.SUPPORT_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)) targets.add(id);
    for (const t of targets) await this.tg.send(t, text, kb);
    await this.tg.send(o.placedBy.telegramId, `سفارش #${o.number} ثبت شد و برای واحد فروش ارسال شد. نتیجه بررسی همین‌جا اطلاع داده می‌شود.`);
  }

  /** Moves an order to a new status and tells the person who placed it, through the bot. */
  async setStatus(byUserId: string, id: string, status: OrderStatus, comment?: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { placedBy: true } });
    if (!o) throw new NotFoundException();
    await this.prisma.order.update({ where: { id }, data: { status, events: { create: { status, byUserId, comment } } } });
    await this.tg.send(o.placedBy.telegramId, `وضعیت سفارش #${o.number}: ${STATUS_FA[status]}${comment ? `\nتوضیح: ${comment}` : ''}`);
    return { before: o.status, number: o.number };
  }

  /** OWNER sees every order of the company, BUYER only their own. Staff see all. */
  async listMine(userId: string) {
    const ms = await this.prisma.customerMember.findMany({ where: { userId } });
    const owned = ms.filter(m => m.role === 'OWNER' || m.role === 'VIEWER').map(m => m.customerId);
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ placedById: userId }, { customerId: { in: owned } }] },
      orderBy: { createdAt: 'desc' }, take: 50,
      include: { items: true, customer: { select: { id: true, name: true } }, placedBy: { select: { firstName: true, lastName: true } } },
    });
    return orders.map(o => ({ ...o, total: this.orderTotal(o.items), statusFa: STATUS_FA[o.status] }));
  }

  async get(userId: string, id: string, staff = false) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } }, proformas: true, customer: { include: { terms: true } }, placedBy: { select: { id: true, firstName: true, lastName: true, username: true } } },
    });
    if (!o) throw new NotFoundException();
    if (!staff && o.placedById !== userId) {
      const m = await this.prisma.customerMember.findUnique({ where: { customerId_userId: { customerId: o.customerId, userId } } });
      if (!m || m.role === 'BUYER') throw new NotFoundException();
    }
    const total = this.orderTotal(o.items);
    const cashPercent = (o.termsSnapshot as { cashPercent?: number } | null)?.cashPercent ?? 100;
    return { ...o, total, split: splitCashCheque(total, cashPercent), statusFa: STATUS_FA[o.status] };
  }
}
