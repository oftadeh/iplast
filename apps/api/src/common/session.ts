import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, SessionClaims } from '../auth/auth.service';

export const STAFF_KEY = 'staffRoles';
/** Restricts a route to staff. With no roles given, ADMIN and SALES are allowed (not WAREHOUSE). */
export const Staff = (...roles: ('ADMIN' | 'SALES' | 'WAREHOUSE')[]) => SetMetadata(STAFF_KEY, roles.length ? roles : ['ADMIN', 'SALES']);

export const Session = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionClaims => ctx.switchToHttp().getRequest().session);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { session?: SessionClaims }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException();
    const claims = this.auth.verifyToken(header.slice(7));
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(STAFF_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles) {
      // the role is read again from the database, so a removed or changed staff member loses access at once
      const staff = await this.auth.currentStaffRole(claims.sub);
      if (!staff || !roles.includes(staff)) throw new ForbiddenException('دسترسی ندارید');
      claims.staff = staff;
    }
    req.session = claims;
    return true;
  }
}
