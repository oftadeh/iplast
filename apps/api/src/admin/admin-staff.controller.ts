import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { telegramId } from '../common/validate';

/** Admins and sales-support agents, identified by numeric Telegram ID. Admin only. */
@Controller('admin/staff')
@UseGuards(SessionGuard)
@Staff('ADMIN')
export class AdminStaffController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.user.findMany({
      where: { staffRole: { not: null } }, orderBy: { createdAt: 'asc' },
      include: { _count: { select: { supportOf: true } } },
    });
  }

  @Post()
  async add(@Session() s: SessionClaims, @Body() b: { telegramId?: string; firstName?: string; role?: string }) {
    const tg = telegramId(b?.telegramId);
    const role = b.role === 'ADMIN' ? 'ADMIN' : 'SALES';
    const u = await this.prisma.user.upsert({
      where: { telegramId: tg },
      create: { telegramId: tg, firstName: b.firstName?.slice(0, 60), staffRole: role },
      update: { staffRole: role, isActive: true, ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}) },
    });
    await audit(this.prisma, s.sub, 'staff.add', 'User', u.id, null, { role });
    return u;
  }

  @Patch(':id')
  async update(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { role?: string; isActive?: boolean; firstName?: string }) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before?.staffRole) throw new NotFoundException();
    if (id === s.sub && (b.isActive === false || (b.role && b.role !== 'ADMIN'))) throw new BadRequestException('نمی‌توانید دسترسی خودتان را بردارید');
    const u = await this.prisma.user.update({
      where: { id },
      data: {
        ...(b.role ? { staffRole: b.role === 'ADMIN' ? 'ADMIN' : 'SALES' } : {}),
        ...(b.isActive !== undefined ? { isActive: !!b.isActive } : {}),
        ...(b.firstName ? { firstName: b.firstName.slice(0, 60) } : {}),
      },
    });
    await audit(this.prisma, s.sub, 'staff.update', 'User', id, before, u);
    return u;
  }
}
