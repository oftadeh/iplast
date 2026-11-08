import { BadRequestException, Body, ForbiddenException, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { telegramId } from '../common/validate';
import { OWNER_KEY, ownerIds } from '../common/owner';
import { TelegramService } from '../common/telegram.service';
import { AuthService } from '../auth/auth.service';

/** Admins and sales-support agents, identified by numeric Telegram ID. Admin only. */
@Controller('admin/staff')
@UseGuards(SessionGuard)
@Staff('ADMIN')
export class AdminStaffController {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly auth: AuthService) {}

  @Get()
  async list() {
    const owners = await ownerIds(this.prisma);
    const rows = await this.prisma.user.findMany({
      where: { staffRole: { not: null } }, orderBy: { createdAt: 'asc' },
      include: { _count: { select: { supportOf: true } } },
    });
    return rows.map(u => ({ ...u, owner: owners.includes(String(u.telegramId)) }));
  }

  /**
   * Hands the senior manager role to another person (a new Telegram ID, and optionally a phone number).
   * Only the current senior manager can do it. The old one stays a manager or loses access.
   */
  @Post('owner')
  async transferOwner(@Session() s: SessionClaims, @Body() b: { telegramId?: string; firstName?: string; phone?: string; keepOld?: boolean }) {
    const owners = await ownerIds(this.prisma);
    if (!owners.includes(s.tg)) throw new ForbiddenException('فقط مدیر ارشد فعلی می‌تواند مدیریت را انتقال دهد');
    const tg = telegramId(b?.telegramId);
    if (String(tg) === s.tg) throw new BadRequestException('این آیدی خودتان است');
    const phone = b.phone ? b.phone.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^\d+]/g, '').slice(0, 20) : undefined;
    if (b.phone && (!phone || phone.replace(/\D/g, '').length < 10)) throw new BadRequestException('شماره موبایل درست نیست');
    const u = await this.prisma.user.upsert({
      where: { telegramId: tg },
      create: { telegramId: tg, firstName: b.firstName?.slice(0, 60), phone, staffRole: 'ADMIN' },
      update: { staffRole: 'ADMIN', isActive: true, ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}), ...(phone ? { phone } : {}) },
    });
    await this.prisma.setting.upsert({ where: { key: OWNER_KEY }, create: { key: OWNER_KEY, value: [String(tg)] }, update: { value: [String(tg)] } });
    if (!b.keepOld) await this.prisma.user.update({ where: { id: s.sub }, data: { isActive: false } });
    this.auth.forgetRole(u.id); this.auth.forgetRole(s.sub);
    await audit(this.prisma, s.sub, 'owner.transfer', 'User', u.id, { owners }, { owners: [String(tg)], keepOld: !!b.keepOld });
    const url = process.env.MINIAPP_URL ? `${process.env.MINIAPP_URL}/admin/` : null;
    await this.tg.send(tg, '👑 مدیریت ارشد پنل اصفهان پلاست به شما سپرده شد. از این به بعد تأیید نهایی سفارش‌ها، کارکنان و تنظیمات با شماست.', url ? { inline_keyboard: [[{ text: '🛠 پنل مدیریت', web_app: { url } }]] } : undefined);
    await this.tg.send(s.tg, b.keepOld ? '👑 مدیریت ارشد منتقل شد. شما همچنان مدیر هستید.' : '👑 مدیریت ارشد منتقل شد و دسترسی شما به پنل مدیریت برداشته شد.');
    return { ok: true, owner: u.id, keepOld: !!b.keepOld };
  }

  @Post()
  async add(@Session() s: SessionClaims, @Body() b: { telegramId?: string; firstName?: string; role?: string }) {
    const tg = telegramId(b?.telegramId);
    const role = b.role === 'ADMIN' ? 'ADMIN' : b.role === 'WAREHOUSE' ? 'WAREHOUSE' : 'SALES';
    const owners = await ownerIds(this.prisma);
    if (role !== 'ADMIN' && (String(tg) === s.tg || owners.includes(String(tg)))) throw new BadRequestException('این آیدی مدیر ارشد است و نقشش عوض نمی‌شود');
    const u = await this.prisma.user.upsert({
      where: { telegramId: tg },
      create: { telegramId: tg, firstName: b.firstName?.slice(0, 60), staffRole: role },
      update: { staffRole: role, isActive: true, ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}) },
    });
    this.auth.forgetRole(u.id);
    await audit(this.prisma, s.sub, 'staff.add', 'User', u.id, null, { role });
    return u;
  }

  @Patch(':id')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { role?: string; isActive?: boolean; firstName?: string; moveCustomersTo?: string | null }) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before?.staffRole) throw new NotFoundException();
    if (id === s.sub && (b.isActive === false || (b.role && b.role !== 'ADMIN'))) throw new BadRequestException('نمی‌توانید دسترسی خودتان را بردارید');
    if ((await ownerIds(this.prisma)).includes(String(before.telegramId)) && (b.isActive === false || (b.role && b.role !== 'ADMIN'))) throw new BadRequestException('این آیدی مدیر ارشد است؛ اول مدیریت را به شخص دیگری انتقال دهید');
    let moved = 0;
    if (b.isActive === false && b.moveCustomersTo !== undefined) {
      if (b.moveCustomersTo) {
        const to = await this.prisma.user.findUnique({ where: { id: b.moveCustomersTo } });
        if (!to?.isActive || !to.staffRole || to.id === id) throw new BadRequestException('کارشناس مقصد فعال نیست');
      }
      moved = (await this.prisma.customer.updateMany({ where: { supportId: id }, data: { supportId: b.moveCustomersTo || null } })).count;
      await this.prisma.conversation.updateMany({ where: { assigneeId: id, isOpen: true }, data: { assigneeId: b.moveCustomersTo || null } });
    }
    const u = await this.prisma.user.update({
      where: { id },
      data: {
        ...(b.role ? { staffRole: b.role === 'ADMIN' ? 'ADMIN' : b.role === 'WAREHOUSE' ? 'WAREHOUSE' : 'SALES' } : {}),
        ...(b.isActive !== undefined ? { isActive: !!b.isActive } : {}),
        ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}),
      },
    });
    this.auth.forgetRole(id);
    await audit(this.prisma, s.sub, 'staff.update', 'User', id, before, { ...u, moved });
    return { ...u, moved };
  }
}
