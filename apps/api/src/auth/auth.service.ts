import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerIds } from '../common/owner';
import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { TelegramService } from '../common/telegram.service';
import * as jwt from 'jsonwebtoken';
import { verifyInitData } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface SessionClaims { sub: string; tg: string; staff: string | null }

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly codes = new Map<string, { code: string; expires: number; tries: number }>();

  private readonly log = new Logger('Auth');
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService) {}

  /**
   * ADMIN_TELEGRAM_IDS are the owners: always active senior managers, whatever the panel says, so they can never
   * lock themselves out (for example by adding their own ID as a sales agent). Other managers are added in the panel.
   */
  async onModuleInit() {
    // after a transfer in the panel the owner lives in the database, not in .env
    const ids = await ownerIds(this.prisma);
    void this.reportFailedMigrations(ids);
    for (const id of ids) {
      await this.prisma.user.upsert({ where: { telegramId: BigInt(id) }, create: { telegramId: BigInt(id), staffRole: 'ADMIN' }, update: { staffRole: 'ADMIN', isActive: true } });
    }
    // SUPPORT_TELEGRAM_IDS are sales agents unless they already have a role
    for (const id of (process.env.SUPPORT_TELEGRAM_IDS ?? '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x) && !ids.includes(x))) {
      const u = await this.prisma.user.upsert({ where: { telegramId: BigInt(id) }, create: { telegramId: BigInt(id), staffRole: 'SALES' }, update: {} });
      if (!u.staffRole) await this.prisma.user.update({ where: { id: u.id }, data: { staffRole: 'SALES' } });
    }
  }

  /**
   * A database update (migration) that failed on deploy: the server keeps running on the old tables, so tell the
   * senior manager in Telegram with Prisma's error, instead of the site going down silently.
   */
  private async reportFailedMigrations(ids: string[]) {
    try {
      const all = await this.prisma.$queryRawUnsafe<{ migration_name: string; logs: string | null; finished_at: Date | null; rolled_back_at: Date | null }[]>(
        'SELECT migration_name, logs, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
      );
      const failed = all.filter(r => !r.finished_at && !r.rolled_back_at);
      const done = new Set(all.filter(r => r.finished_at).map(r => r.migration_name));
      const dir = join(process.cwd(), 'prisma', 'migrations');
      const pending = existsSync(dir) ? readdirSync(dir).filter(d => /^\d{14}_/.test(d) && !done.has(d) && !failed.some(f => f.migration_name === d)) : [];
      if (!failed.length && !pending.length) return;
      // once per problem: a restart with the same failed/pending migrations does not message again
      const key = 'migration.reported';
      const sig = [...failed.map(r => r.migration_name), ...pending].join(',');
      const prev = await this.prisma.setting.findUnique({ where: { key } });
      if (prev && (prev.value as unknown) === sig) return;
      await this.prisma.setting.upsert({ where: { key }, create: { key, value: sig }, update: { value: sig } });
      const text = [
        '⚠️ به‌روزرسانی دیتابیس iPlast کامل نشد؛ این پیام را برای پشتیبان فنی بفرستید.',
        ...failed.map(r => `خطا در ${r.migration_name}:\n${(r.logs ?? '').slice(0, 1500)}`),
        ...(pending.length ? [`اجرا نشده: ${pending.join('، ')}`] : []),
      ].join('\n\n');
      for (const id of ids) await this.tg.send(id, text.slice(0, 3900));
    } catch (e) {
      this.log.warn(`migration check failed: ${(e as Error).message}`);
    }
  }

  private sign(user: { id: string; telegramId: bigint; staffRole: string | null }) {
    const claims: SessionClaims = { sub: user.id, tg: String(user.telegramId), staff: user.staffRole };
    return jwt.sign(claims, this.env('JWT_SECRET'), { expiresIn: '8h' });
  }

  private roleCache = new Map<string, { role: string | null; at: number }>();
  /** A role was changed in the panel: it applies on the next request, not after the cache expires. */
  forgetRole(userId: string) { this.roleCache.delete(userId); }
  /** The staff role as it is now in the database (cached for a few seconds). Null for inactive or non-staff users. */
  async currentStaffRole(userId: string) {
    const hit = this.roleCache.get(userId);
    if (hit && Date.now() - hit.at < 5_000) return hit.role;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { staffRole: true, isActive: true } });
    const role = u?.isActive && u.staffRole ? u.staffRole : null;
    this.roleCache.set(userId, { role, at: Date.now() });
    return role;
  }

  /** Admin panel login, step 1: a 6-digit code is sent by the bot to an active staff member. */
  async requestCode(telegramId: bigint) {
    const prev = this.codes.get(String(telegramId));
    // one code a minute: a new code would otherwise reset the 5-try limit
    if (prev && prev.expires - 4 * 60_000 > Date.now()) return { sent: true };
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    // Same answer whether or not the ID is staff, so the endpoint does not reveal who is staff.
    if (user?.staffRole && user.isActive) {
      const code = String(randomInt(100000, 1000000));
      this.codes.set(String(telegramId), { code, expires: Date.now() + 5 * 60_000, tries: 0 });
      await this.tg.send(telegramId, `کد ورود به پنل مدیریت iPlast: ${code}\nاین کد ۵ دقیقه اعتبار دارد. آن را به کسی ندهید.`);
    }
    return { sent: true };
  }

  /** Admin panel login, step 2. */
  async verifyCode(telegramId: bigint, code: string) {
    const key = String(telegramId);
    const entry = this.codes.get(key);
    if (!entry || entry.expires < Date.now() || entry.tries >= 5) { this.codes.delete(key); throw new UnauthorizedException('کد منقضی شده است'); }
    entry.tries++;
    if (entry.code !== String(code).trim()) throw new UnauthorizedException('کد اشتباه است');
    this.codes.delete(key);
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user?.staffRole || !user.isActive) throw new BadRequestException();
    return { token: this.sign(user), user: { id: user.id, firstName: user.firstName, staffRole: user.staffRole } };
  }

  private env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  /** Exchanges Mini App initData for a short-lived JWT. Roles always come from the database. */
  async loginWithInitData(initData: string) {
    const verified = verifyInitData(initData, this.env('BOT_TOKEN'));
    if (!verified) throw new UnauthorizedException('initData نامعتبر است');
    const u = verified.user;
    const user = await this.prisma.user.upsert({
      where: { telegramId: BigInt(u.id) },
      create: { telegramId: BigInt(u.id), username: u.username, firstName: u.first_name, lastName: u.last_name },
      update: { username: u.username, firstName: u.first_name, lastName: u.last_name, lastSeenAt: new Date() },
    });
    const token = this.sign(user);
    return { token, user: { id: user.id, firstName: user.firstName, staffRole: user.staffRole } };
  }

  verifyToken(token: string): SessionClaims {
    try { return jwt.verify(token, this.env('JWT_SECRET')) as SessionClaims; }
    catch { throw new UnauthorizedException(); }
  }
}
