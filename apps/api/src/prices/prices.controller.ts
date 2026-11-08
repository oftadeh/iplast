import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportMatch } from '@iplast/db';
import { Session, SessionGuard, Staff } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/audit';
import { ParsedRow, parsePriceText, pdfToText } from './pdf-parse';
import { PriceAiService } from './price-ai.service';

interface UploadedPdf { buffer: Buffer; originalname: string; size: number; mimetype: string }
const MAX_PDF = 25 * 1024 * 1024;

/**
 * Price-list updates: upload the PDF(s) → a DRAFT list with every parsed row matched to a size →
 * review the changes → an admin publishes it, and it becomes the active list for customers.
 */
/** Price list PDFs as uploaded (private; sent by the bot on request). */
export const PRICELISTS = join(process.env.UPLOAD_DIR ?? '/data/uploads', 'pricelists');

@Controller('admin/prices')
@UseGuards(SessionGuard)
@Staff()
export class PricesController {
  constructor(private readonly prisma: PrismaService, private readonly ai: PriceAiService) {}

  @Get('ai')
  aiStatus() { return { enabled: this.ai.enabled }; }

  @Get('lists')
  async lists() {
    const lists = await this.prisma.priceList.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { _count: { select: { prices: true, importRows: true } } } });
    return lists.map(l => ({ ...l, hasFile: existsSync(join(PRICELISTS, l.id)) && readdirSync(join(PRICELISTS, l.id)).some(f => f.endsWith('.pdf')) }));
  }

  /** Upload one PDF. With listId it is added to that draft (the month's list may come as several files). */
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF } }))
  async import(@Session() s: SessionClaims, @UploadedFile() file: UploadedPdf | undefined, @Query('listId') listId?: string, @Query('title') title?: string, @Query('ai') useAi?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('فایل PDF را انتخاب کنید');
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('این فایل PDF نیست');
    const ai = useAi === '1' && this.ai.enabled;
    const text = await pdfToText(file.buffer).catch(() => '');
    let rows = parsePriceText(text);
    let aiTitle: string | null = null;
    // scanned PDF or a layout the text rules do not understand: the AI reads the file itself
    if (ai && rows.length < 5) {
      try { const x = await this.ai.extract(file.buffer, file.originalname); rows = x.rows; aiTitle = x.title; }
      catch (e) { throw new BadRequestException('هوش مصنوعی هم نتوانست فایل را بخواند: ' + (e as Error).message); }
    }
    if (!rows.length) throw new BadRequestException(this.ai.enabled ? 'هیچ ردیف قیمتی در این فایل پیدا نشد.' : 'هیچ ردیف قیمتی در این فایل پیدا نشد. اگر PDF اسکن‌شده (عکس) است، نسخه‌ی متنی آن لازم است.');

    let list = listId ? await this.prisma.priceList.findUnique({ where: { id: listId } }) : null;
    if (listId && (!list || list.status !== 'DRAFT')) throw new BadRequestException('فقط به پیش‌نویس می‌شود فایل اضافه کرد');
    if (!list) {
      const guessed = guessTitle(text) ?? aiTitle;
      list = await this.prisma.priceList.create({ data: { title: (title || guessed || 'لیست قیمت جدید').slice(0, 120), sourceFile: file.originalname.slice(0, 200) } });
    } else {
      await this.prisma.priceList.update({ where: { id: list.id }, data: { sourceFile: [list.sourceFile, file.originalname].filter(Boolean).join(' + ').slice(0, 400) } });
    }
    // keep the PDF: the AI agent sends the published list to customers who ask for it
    try { const dir = join(PRICELISTS, list.id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${Date.now()}.pdf`), file.buffer); } catch { /* the import still works */ }
    const matched = await this.match(rows, list.id);
    await this.prisma.priceImportRow.createMany({ data: matched });
    const aiResult = ai ? await this.ai.matchDraft(list.id) : null;
    await audit(this.prisma, s.sub, 'price.import', 'PriceList', list.id, null, { file: file.originalname, rows: rows.length, ai: aiResult });
    return { ...(await this.summary(list.id)), ai: aiResult };
  }

  /** Lets the AI connect the rows of a draft that are still unmatched or only suggested. */
  @Post('lists/:id/ai-match')
  async aiMatch(@Param('id') id: string) {
    if (!this.ai.enabled) throw new BadRequestException('هوش مصنوعی فعال نیست (OPENAI_API_KEY)');
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list || list.status !== 'DRAFT') throw new BadRequestException('فقط پیش‌نویس');
    return this.ai.matchDraft(id);
  }

  @Get('lists/:id')
  async detail(@Param('id') id: string) {
    return this.summary(id, true);
  }

  /** Manual fix of one row: point it to a size, or to nothing (null) to leave it out. */
  @Patch('rows/:rowId')
  async resolve(@Session() s: SessionClaims, @Param('rowId') rowId: string, @Body() b: { variantId?: string | null }) {
    const row = await this.prisma.priceImportRow.findUnique({ where: { id: rowId }, include: { priceList: true } });
    if (!row) throw new NotFoundException();
    if (row.priceList.status !== 'DRAFT') throw new BadRequestException('این لیست منتشر شده و قابل تغییر نیست');
    if (b.variantId && !(await this.prisma.variant.findUnique({ where: { id: b.variantId } }))) throw new BadRequestException('سایز نامعتبر است');
    const r = await this.prisma.priceImportRow.update({
      where: { id: rowId },
      data: { variantId: b.variantId || null, match: b.variantId ? 'MATCHED' : 'UNMATCHED', resolvedBy: s.sub },
    });
    return r;
  }

  /** Sizes to choose from when fixing a row by hand. */
  @Get('variants')
  async variants(@Query('q') q?: string) {
    const t = (q ?? '').trim();
    if (t.length < 2) return [];
    return this.prisma.variant.findMany({
      where: { OR: [{ title: { contains: t } }, { accountingCode: { contains: t.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))) } }, { family: { name: { contains: t } } }] },
      take: 30, orderBy: { sku: 'asc' }, select: { id: true, sku: true, title: true, accountingCode: true, perPack: true },
    });
  }

  /** Makes the draft the active list. Sizes missing from the files keep their current price, or become «استعلامی» if asked. */
  /** The PDF the AI agent sends to customers who ask for the price list (no import, just the file). */
  @Post('lists/:id/file')
  @Staff('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF } }))
  async attachFile(@Param('id') id: string, @UploadedFile() file?: UploadedPdf) {
    if (!file || file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('یک فایل PDF بفرستید');
    if (!(await this.prisma.priceList.findUnique({ where: { id } }))) throw new NotFoundException();
    const dir = join(PRICELISTS, id);
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    writeFileSync(join(dir, `${Date.now()}.pdf`), file.buffer);
    return { ok: true };
  }

  @Post('lists/:id/publish')
  @Staff('ADMIN')
  async publish(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { missing?: 'keep' | 'inquiry'; validFrom?: string }) {
    const list = await this.prisma.priceList.findUnique({ where: { id }, include: { importRows: { where: { variantId: { not: null }, match: { in: ['MATCHED', 'AMBIGUOUS'] } }, orderBy: { id: 'asc' } } } });
    if (!list) throw new NotFoundException();
    if (list.status !== 'DRAFT') throw new BadRequestException('این لیست قبلاً منتشر شده است');
    if (!list.importRows.length) throw new BadRequestException('هیچ ردیفی به سایزی وصل نشده است');
    const active = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' }, include: { prices: true } });

    const byVariant = new Map<string, { amount: bigint | null; status: 'PRICED' | 'INQUIRY'; note: string | null }>();
    if (active && b.missing !== 'inquiry') for (const p of active.prices) byVariant.set(p.variantId, { amount: p.amount, status: p.status, note: p.note });
    if (b.missing === 'inquiry') for (const v of await this.prisma.variant.findMany({ where: { isActive: true }, select: { id: true } })) byVariant.set(v.id, { amount: null, status: 'INQUIRY', note: 'در لیست جدید نبود' });
    for (const r of list.importRows) byVariant.set(r.variantId!, { amount: r.amount, status: r.amount === null ? 'INQUIRY' : 'PRICED', note: r.amount === null ? 'استعلامی' : null });

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.price.deleteMany({ where: { priceListId: id } }),
      this.prisma.price.createMany({ data: [...byVariant].map(([variantId, p]) => ({ priceListId: id, variantId, amount: p.amount, status: p.status, note: p.note })) }),
      this.prisma.priceList.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'ARCHIVED' } }),
      this.prisma.priceList.update({ where: { id }, data: { status: 'ACTIVE', publishedAt: now, publishedBy: s.sub, validFrom: b.validFrom ? new Date(b.validFrom) : now } }),
    ]);
    await audit(this.prisma, s.sub, 'price.publish', 'PriceList', id, active ? { activeListId: active.id } : null, { prices: byVariant.size, missing: b.missing ?? 'keep' });
    return this.summary(id);
  }

  @Delete('lists/:id')
  async remove(@Session() s: SessionClaims, @Param('id') id: string) {
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException();
    if (list.status !== 'DRAFT') throw new BadRequestException('فقط پیش‌نویس حذف می‌شود');
    await this.prisma.priceList.delete({ where: { id } });
    await audit(this.prisma, s.sub, 'price.discard', 'PriceList', id, { title: list.title }, null);
    return { ok: true };
  }

  // ───────── helpers ─────────

  /**
   * Matches rows to sizes by accounting code. Codes repeat in the price list (82 duplicates, sometimes across
   * families), so a size is never given two rows, a different pack count rules a size out, and when more than one
   * size is still possible the first free one (catalog order) is suggested and the row is marked AMBIGUOUS for review.
   */
  private async match(rows: ParsedRow[], priceListId: string) {
    const variants = await this.prisma.variant.findMany({ where: { accountingCode: { not: null } }, select: { id: true, accountingCode: true, perPack: true, sku: true }, orderBy: { sku: 'asc' } });
    const byCode = new Map<string, typeof variants>();
    for (const v of variants) byCode.set(v.accountingCode!, [...(byCode.get(v.accountingCode!) ?? []), v]);
    const taken = new Set((await this.prisma.priceImportRow.findMany({ where: { priceListId, variantId: { not: null } }, select: { variantId: true } })).map(r => r.variantId!));
    // rows an admin pointed to a size by hand in an earlier import are recognised again by their text
    const learned = new Map<string, string>();
    for (const r of await this.prisma.priceImportRow.findMany({ where: { resolvedBy: { notIn: ['ai'] }, variantId: { not: null }, NOT: { priceListId } }, orderBy: { id: 'asc' }, select: { familyTitle: true, rawText: true, variantId: true } }))
      learned.set(`${r.familyTitle}|${r.rawText}`, r.variantId!);
    return rows.map(r => {
      let match: ImportMatch = 'UNMATCHED';
      let variantId: string | null = null;
      if (r.accountingCode) {
        const all = byCode.get(r.accountingCode) ?? [];
        const free = all.filter(v => !taken.has(v.id) && (r.perPack === null || v.perPack === null || v.perPack === r.perPack));
        if (!all.length) match = 'NEW';
        else if (free.length) {
          variantId = free[0].id;
          const sure = all.length === 1 && free.length === 1 && (r.perPack === null || r.perPack === free[0].perPack);
          match = sure ? 'MATCHED' : 'AMBIGUOUS';
          taken.add(variantId);
        }
      }
      const known = learned.get(`${r.familyTitle?.slice(0, 200) ?? null}|${r.rawText || '—'}`);
      if (!variantId && known && !taken.has(known)) { variantId = known; match = 'MATCHED'; taken.add(known); }
      return {
        priceListId, page: r.page, familyTitle: r.familyTitle?.slice(0, 200) ?? null, rawText: r.rawText || '—', accountingCode: r.accountingCode,
        perPack: r.perPack, amount: r.amount, status: r.amount === null ? 'INQUIRY' as const : 'PRICED' as const, match, variantId,
      };
    });
  }

  private async summary(id: string, withRows = false) {
    const list = await this.prisma.priceList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException();
    const groups = await this.prisma.priceImportRow.groupBy({ by: ['match'], where: { priceListId: id }, _count: true });
    const counts = Object.fromEntries(groups.map(g => [g.match, g._count]));
    if (!withRows) return { list, counts };

    const rows = await this.prisma.priceImportRow.findMany({ where: { priceListId: id }, orderBy: [{ page: 'asc' }, { id: 'asc' }] });
    const active = await this.prisma.priceList.findFirst({ where: { status: 'ACTIVE', NOT: { id } }, orderBy: { publishedAt: 'desc' } });
    const vids = rows.map(r => r.variantId).filter((x): x is string => !!x);
    const [vs, old] = await Promise.all([
      this.prisma.variant.findMany({ where: { id: { in: vids } }, select: { id: true, sku: true, title: true, perPack: true } }),
      active ? this.prisma.price.findMany({ where: { priceListId: active.id, variantId: { in: vids } } }) : Promise.resolve([]),
    ]);
    const vMap = new Map(vs.map(v => [v.id, v]));
    const oMap = new Map(old.map(p => [p.variantId, p]));
    let up = 0, down = 0, same = 0, toInquiry = 0, fromInquiry = 0;
    const out = rows.map(r => {
      const o = r.variantId ? oMap.get(r.variantId) : undefined;
      const oldAmount = o?.amount ?? null;
      if (r.variantId && o) {
        if (r.amount === null && oldAmount !== null) toInquiry++;
        else if (r.amount !== null && oldAmount === null) fromInquiry++;
        else if (r.amount !== null && oldAmount !== null) { if (r.amount > oldAmount) up++; else if (r.amount < oldAmount) down++; else same++; }
      }
      return { ...r, variant: r.variantId ? vMap.get(r.variantId) ?? null : null, oldAmount, hadOld: !!o };
    });
    const dupVariants = new Set(vids.filter((v, i) => vids.indexOf(v) !== i));
    const totalVariants = await this.prisma.variant.count({ where: { isActive: true } });
    return { list, counts, changes: { up, down, same, toInquiry, fromInquiry }, activeList: active ? { id: active.id, title: active.title } : null, missingVariants: Math.max(0, totalVariants - new Set(vids).size), duplicates: dupVariants.size, rows: out };
  }
}

function guessTitle(text: string) {
  const m = text.replace(/[‎‏‪-‮]/g, '').match(/لیست قیمت\s+([^\n|]{2,30})/);
  return m ? `لیست قیمت ${m[1].trim()}` : null;
}
