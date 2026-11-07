import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';

/**
 * Outbound proxy (servers that reach Telegram only through a VPN). The host tool infra/proxy/iplast-proxy.py
 * writes status.json into this folder and picks up request.txt, so the manager can paste a new subscription
 * when the old one expires. The saved source itself (it holds the VPN credentials) never comes back to the panel.
 */
const DIR = process.env.PROXY_DIR ?? '/data/proxy';
const LINK = /^(vless|vmess|trojan):\/\/\S+$/;

@Controller('admin/proxy')
@UseGuards(SessionGuard)
@Staff('ADMIN')
export class AdminProxyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  status() {
    const enabled = !!(process.env.HTTPS_PROXY || process.env.https_proxy);
    let status: Record<string, unknown> = {};
    try { status = JSON.parse(readFileSync(join(DIR, 'status.json'), 'utf8')); } catch { /* not set up yet */ }
    return { enabled, pending: existsSync(join(DIR, 'request.txt')), ...status };
  }

  @Post()
  async save(@Session() s: SessionClaims, @Body() b: { source?: string }) {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) throw new BadRequestException('این سرور از پراکسی استفاده نمی‌کند');
    const source = String(b.source ?? '').trim();
    const lines = source.split(/\s+/).filter(Boolean);
    const isSub = lines.length === 1 && /^https?:\/\/\S+$/.test(lines[0]);
    if (!source || source.length > 20000 || !(isSub || lines.every(l => LINK.test(l)))) {
      throw new BadRequestException('لینک اشتراک (https://…) یا کانفیگ‌های vless:// ، vmess:// یا trojan:// را وارد کنید');
    }
    writeFileSync(join(DIR, 'request.txt'), lines.join('\n') + '\n', { mode: 0o600 });
    await audit(this.prisma, s.sub, 'proxy.update', 'Proxy', 'outbound', null, { kind: isSub ? 'subscription' : 'links', count: lines.length });
    return { queued: true };
  }
}
