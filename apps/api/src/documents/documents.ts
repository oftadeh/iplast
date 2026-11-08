import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocKind } from '@iplast/db';
import { formatRial } from '@iplast/shared';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../common/telegram.service';
import { OrdersService, STATUS_FA } from '../orders/orders.service';
import { audit } from '../common/audit';
import { rialOf } from '../common/validate';

const DOCS = join(process.env.UPLOAD_DIR ?? '/data/uploads', 'docs'); // private: served only to staff and the customer's own members
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const KINDS: DocKind[] = ['RECEIPT', 'CHEQUE', 'INVOICE', 'WAYBILL', 'CONTRACT', 'OTHER'];
export const KIND_FA: Record<DocKind, string> = { RECEIPT: 'فیش واریز', CHEQUE: 'چک', INVOICE: 'فاکتور', WAYBILL: 'بارنامه', CONTRACT: 'قرارداد', OTHER: 'سایر' };
const MAX = 10 * 1024 * 1024;
type Upload = { buffer: Buffer; mimetype: string; originalname?: string; size: number };
const clean = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const PUBLIC = { id: true, kind: true, title: true, mime: true, size: true, byCustomer: true, createdAt: true, orderId: true, paymentId: true, invoiceId: true, shipmentId: true } as const;

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly orders: OrdersService) {}

  /** Saves a photo or PDF on the customer's file, optionally tied to an order, payment, invoice or load. */
  async save(customerId: string, uploadedById: string, byCustomer: boolean, file: Upload | undefined, b: { kind?: string; title?: string; orderId?: string; paymentId?: string; invoiceId?: string; shipmentId?: string }) {
    const ext = file && EXT[file.mimetype];
    if (!file?.buffer?.length || !ext) throw new BadRequestException('فایل را انتخاب کنید (عکس JPG/PNG یا PDF)');
    if (file.size > MAX) throw new BadRequestException('حجم فایل حداکثر ۱۰ مگابایت');
    const kind = (KINDS.includes(b.kind as DocKind) ? b.kind : 'OTHER') as DocKind;
    const own = async (table: 'order' | 'payment' | 'invoice', id?: string) => {
      if (!id) return null;
      const row = await (this.prisma[table] as unknown as { findFirst(a: object): Promise<{ id: string } | null> }).findFirst({ where: { id, customerId } });
      if (!row) throw new BadRequestException('سند به این مشتری تعلق ندارد');
      return id;
    };
    let shipmentId: string | null = null;
    if (b.shipmentId) {
      const sh = await this.prisma.shipment.findFirst({ where: { id: b.shipmentId, order: { customerId } } });
      if (!sh) throw new BadRequestException('بار نامعتبر است');
      shipmentId = sh.id;
    }
    mkdirSync(DOCS, { recursive: true });
    const key = `${randomBytes(12).toString('hex')}.${ext}`;
    writeFileSync(join(DOCS, key), file.buffer);
    const d = await this.prisma.document.create({
      data: {
        customerId, kind, title: clean(b.title, 120) ?? clean(file.originalname, 120), fileKey: key, mime: file.mimetype, size: file.size,
        orderId: await own('order', b.orderId), paymentId: await own('payment', b.paymentId), invoiceId: await own('invoice', b.invoiceId), shipmentId,
        uploadedById, byCustomer,
      },
      select: PUBLIC,
    });
    await audit(this.prisma, uploadedById, 'document.add', 'Document', d.id, null, { customerId, kind, byCustomer });
    return d;
  }

  list(customerId: string) {
    return this.prisma.document.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 300, select: { ...PUBLIC, order: { select: { number: true } }, invoice: { select: { number: true } } } })
      .then(ds => ds.map(d => ({ ...d, kindFa: KIND_FA[d.kind] })));
  }

  async file(id: string, customerIds: string[] | 'staff') {
    const d = await this.prisma.document.findUnique({ where: { id } });
    if (!d || (customerIds !== 'staff' && !customerIds.includes(d.customerId))) throw new NotFoundException();
    if (!/^[a-f0-9]+\.(jpg|png|webp|pdf)$/.test(d.fileKey)) throw new NotFoundException();
    const path = join(DOCS, d.fileKey);
    if (!existsSync(path)) throw new NotFoundException();
    return { path, mime: d.mime, name: `${KIND_FA[d.kind]}-${d.id.slice(-6)}.${d.fileKey.split('.').pop()}` };
  }

  /**
   * The warehouse records a load: carrier, driver, plate, waybill number, freight and a photo/PDF of the waybill.
   * The order becomes «ارسال شد» and the customer gets the details (and the waybill) in the bot.
   */
  async ship(byUserId: string, orderId: string, b: Record<string, unknown>, file?: Upload) {
    const [u, o] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: byUserId } }),
      this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, placedBy: true } }),
    ]);
    if (!o) throw new NotFoundException();
    if (!u?.isActive || (u.staffRole !== 'ADMIN' && u.staffRole !== 'WAREHOUSE')) throw new ForbiddenException('ثبت ارسال با انبار یا مدیر است');
    if (!['CONFIRMED', 'PREPARING', 'SHIPPED'].includes(o.status)) throw new BadRequestException(`این سفارش الان «${STATUS_FA[o.status]}» است`);
    const freight = b.freight !== undefined && b.freight !== '' ? rialOf(b.freight, 'کرایه', true) : null;
    const freightBy = b.freightBy === 'customer' || b.freightBy === 'company' ? b.freightBy : null;
    const sh = await this.prisma.shipment.create({
      data: {
        orderId, createdById: byUserId, freight, freightBy,
        waybillNo: clean(b.waybillNo, 40), carrier: clean(b.carrier, 80), driverName: clean(b.driverName, 80),
        driverPhone: clean(b.driverPhone, 20), plate: clean(b.plate, 30), note: clean(b.note, 500),
      },
    });
    if (file?.buffer?.length) await this.save(o.customerId, byUserId, false, file, { kind: 'WAYBILL', orderId, shipmentId: sh.id, title: sh.waybillNo ? `بارنامه ${sh.waybillNo}` : 'بارنامه' });
    const lines = [
      sh.carrier && `باربری: ${sh.carrier}`, sh.waybillNo && `شماره بارنامه: ${sh.waybillNo}`,
      (sh.driverName || sh.driverPhone) && `راننده: ${[sh.driverName, sh.driverPhone].filter(Boolean).join(' · ')}`,
      sh.plate && `پلاک: ${sh.plate}`, sh.freight !== null && `کرایه: ${formatRial(sh.freight)}${sh.freightBy === 'customer' ? ' (پس‌کرایه، با مشتری)' : sh.freightBy === 'company' ? ' (با کارخانه)' : ''}`,
      sh.note && `توضیح: ${sh.note}`,
    ].filter(Boolean).join('\n');
    if (o.status !== 'SHIPPED') await this.orders.decide(byUserId, orderId, 'ship', lines || undefined);
    else await this.prisma.orderStatusEvent.create({ data: { orderId, status: 'SHIPPED', byUserId, comment: `بار دیگر:\n${lines}` } });
    const text = `🚚 سفارش #${o.number} (${o.customer.name}) بارگیری و ارسال شد.\n${lines}`;
    const to = new Set([String(o.placedBy.telegramId), ...(await this.prisma.customerMember.findMany({ where: { customerId: o.customerId, role: 'OWNER' }, include: { user: true } })).map(m => String(m.user.telegramId))]);
    for (const t of to) {
      if (file?.buffer?.length && EXT[file.mimetype]) await this.tg.sendFile(t, file.buffer, `waybill.${EXT[file.mimetype]}`, file.mimetype, text);
      else await this.tg.send(t, text);
    }
    return sh;
  }
}

/** Staff: documents on a customer's file, and recording a load for an order. */
@Controller('admin')
@UseGuards(SessionGuard)
@Staff('ADMIN', 'SALES', 'WAREHOUSE')
export class AdminDocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly prisma: PrismaService) {}

  @Get('customers/:id/documents') list(@Param('id') id: string) { return this.docs.list(id); }

  @Post('customers/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX } }))
  add(@Session() s: SessionClaims, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() b: Record<string, string>) {
    return this.docs.save(id, s.sub, false, file, b ?? {});
  }

  /** Attach a document to an order (its customer is taken from the order). */
  @Post('orders/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX } }))
  async addToOrder(@Session() s: SessionClaims, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() b: Record<string, string>) {
    const o = await this.prisma.order.findUnique({ where: { id }, select: { customerId: true } });
    if (!o) throw new NotFoundException();
    return this.docs.save(o.customerId, s.sub, false, file, { ...(b ?? {}), orderId: id });
  }

  @Get('documents/:id/file')
  async file(@Param('id') id: string, @Query('dl') dl: string | undefined, @Res() res: Response) {
    const f = await this.docs.file(id, 'staff');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `${dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.name)}"`);
    res.send(readFileSync(f.path));
  }

  @Post('orders/:id/shipments')
  @Staff('ADMIN', 'WAREHOUSE')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX } }))
  ship(@Session() s: SessionClaims, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() b: Record<string, unknown>) {
    return this.docs.ship(s.sub, id, b ?? {}, file);
  }
}

/** Customers: their own documents (upload a receipt, signed proforma, cheque photo as photo or PDF). */
@Controller('me/documents')
@UseGuards(SessionGuard)
export class MyDocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly prisma: PrismaService, private readonly tg: TelegramService, private readonly orders: OrdersService) {}

  private async memberOf(userId: string) {
    return (await this.prisma.customerMember.findMany({ where: { userId } })).map(m => m.customerId);
  }

  @Get()
  async list(@Session() s: SessionClaims, @Query('customerId') customerId?: string) {
    const ids = await this.memberOf(s.sub);
    const id = customerId && ids.includes(customerId) ? customerId : ids[0];
    return id ? this.docs.list(id) : [];
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX } }))
  async add(@Session() s: SessionClaims, @UploadedFile() file: Upload | undefined, @Body() b: Record<string, string>) {
    const ids = await this.memberOf(s.sub);
    const customerId = b?.customerId && ids.includes(b.customerId) ? b.customerId : ids.length === 1 ? ids[0] : null;
    if (!customerId) throw new ForbiddenException('حساب مشتری را انتخاب کنید');
    const d = await this.docs.save(customerId, s.sub, true, file, { kind: b?.kind, title: b?.title, orderId: b?.orderId });
    const c = await this.prisma.customer.findUnique({ where: { id: customerId } });
    const caption = `📎 ${KIND_FA[d.kind]} از مشتری «${c?.name ?? ''}»${d.title ? `\n${d.title}` : ''}\nدر پنل مدیریت ← مشتریان ← اسناد`;
    for (const a of await this.orders.salesAgentsOf(customerId)) await this.tg.sendFile(a.telegramId, file!.buffer, `doc.${EXT[file!.mimetype]}`, file!.mimetype, caption);
    return d;
  }

  @Get(':id/file')
  async file(@Session() s: SessionClaims, @Param('id') id: string, @Res() res: Response) {
    const f = await this.docs.file(id, await this.memberOf(s.sub));
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    res.send(readFileSync(f.path));
  }
}
