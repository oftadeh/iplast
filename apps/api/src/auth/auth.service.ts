import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { verifyInitData } from '@iplast/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface SessionClaims { sub: string; tg: string; staff: string | null }

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

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
    const admins = (process.env.ADMIN_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const user = await this.prisma.user.upsert({
      where: { telegramId: BigInt(u.id) },
      create: { telegramId: BigInt(u.id), username: u.username, firstName: u.first_name, lastName: u.last_name, staffRole: admins.includes(String(u.id)) ? 'ADMIN' : null },
      update: { username: u.username, firstName: u.first_name, lastName: u.last_name, lastSeenAt: new Date() },
    });
    const claims: SessionClaims = { sub: user.id, tg: String(u.id), staff: user.staffRole };
    const token = jwt.sign(claims, this.env('JWT_SECRET'), { expiresIn: '2h' });
    return { token, user: { id: user.id, firstName: user.firstName, staffRole: user.staffRole } };
  }

  verifyToken(token: string): SessionClaims {
    try { return jwt.verify(token, this.env('JWT_SECRET')) as SessionClaims; }
    catch { throw new UnauthorizedException(); }
  }
}
