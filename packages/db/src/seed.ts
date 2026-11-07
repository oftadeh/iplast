/**
 * Seeds categories, the curated Aban 1405 catalog (19 families, 200 sizes) and product photos.
 * Safe to run more than once: rows are upserted by slug / sku.
 * Usage: DATABASE_URL=... node dist/seed.js
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

interface SeedVariant { o: string[]; p: number | null; q: number | null; c: string | null }
interface SeedFamily {
  id: string; name: string; cat: string; axes: string[]; variants: SeedVariant[];
  brand?: string; model?: string; unit?: string; pack?: string; badge?: string; syn?: string[]; spec?: [string, string][];
}
interface SeedPhoto { file: string; source: string; sibling?: boolean }

const CATEGORIES: [slug: string, name: string][] = [
  ['newfit', 'لوله و اتصالات نیوفیت'],
  ['threaded', 'اتصالات پیچی'],
  ['filters', 'فیلترهای دیسکی'],
  ['drip', 'اتصالات قطره‌ای'],
  ['welded', 'اتصالات جوشی'],
  ['valves', 'شیرآلات'],
  ['sprinkler', 'لوله‌ها و شیر بارانی'],
  ['pe-pipe', 'لوله‌های پلی‌اتیلن'],
  ['tape', 'نوار تیپ آبیاری'],
];

const seedDir = join(__dirname, '..', 'seed');
const load = <T>(f: string): T => JSON.parse(readFileSync(join(seedDir, f), 'utf8'));

export async function seed(prisma: PrismaClient) {
  const families = load<SeedFamily[]>('catalog-aban1405.json');
  const photos = load<Record<string, SeedPhoto>>('photos.json');

  const cats = new Map<string, string>();
  for (const [i, [slug, name]] of CATEGORIES.entries()) {
    const c = await prisma.category.upsert({ where: { slug }, create: { slug, name, sortOrder: i }, update: { name, sortOrder: i } });
    cats.set(slug, c.id);
  }

  const list = await prisma.priceList.upsert({
    where: { id: 'aban-1405' },
    create: { id: 'aban-1405', title: 'لیست قیمت آبان ۱۴۰۵', status: 'ACTIVE', publishedAt: new Date('2026-10-23T00:00:00Z') },
    update: {},
  });

  for (const [fi, f] of families.entries()) {
    const categoryId = cats.get(f.cat);
    if (!categoryId) throw new Error(`unknown category ${f.cat}`);
    const brand = f.brand ? await prisma.brand.upsert({ where: { name: f.brand }, create: { name: f.brand }, update: {} }) : null;
    const fam = await prisma.productFamily.upsert({
      where: { slug: f.id },
      create: { slug: f.id, name: f.name, model: f.model, unitName: f.unit ?? 'عدد', packName: f.pack, specs: f.spec ?? undefined, badge: f.badge, sortOrder: fi, categoryId, brandId: brand?.id },
      update: { name: f.name, model: f.model, unitName: f.unit ?? 'عدد', packName: f.pack, specs: f.spec ?? undefined, badge: f.badge, sortOrder: fi, categoryId, brandId: brand?.id },
    });
    const axes = [];
    for (const [ai, name] of f.axes.entries()) {
      axes.push(await prisma.optionAxis.upsert({
        where: { familyId_name: { familyId: fam.id, name } },
        create: { familyId: fam.id, name, sortOrder: ai },
        update: { sortOrder: ai },
      }));
    }
    for (const [vi, v] of f.variants.entries()) {
      const sku = `${f.id}-${String(vi + 1).padStart(3, '0')}`;
      const title = `${f.name} ${v.o.join(' × ')}`;
      const variant = await prisma.variant.upsert({
        where: { sku },
        create: { sku, title, familyId: fam.id, accountingCode: v.c, perPack: v.q },
        update: { title, accountingCode: v.c, perPack: v.q },
      });
      for (const [ai, value] of v.o.entries()) {
        await prisma.variantOption.upsert({
          where: { variantId_axisId: { variantId: variant.id, axisId: axes[ai].id } },
          create: { variantId: variant.id, axisId: axes[ai].id, value },
          update: { value },
        });
      }
      const priced = typeof v.p === 'number' && v.p > 0;
      await prisma.price.upsert({
        where: { priceListId_variantId: { priceListId: list.id, variantId: variant.id } },
        create: { priceListId: list.id, variantId: variant.id, amount: priced ? BigInt(v.p!) : null, status: priced ? 'PRICED' : 'INQUIRY' },
        update: { amount: priced ? BigInt(v.p!) : null, status: priced ? 'PRICED' : 'INQUIRY' },
      });
    }
    await prisma.synonym.deleteMany({ where: { familyId: fam.id } });
    if (f.syn?.length) await prisma.synonym.createMany({ data: f.syn.map(term => ({ term, familyId: fam.id })) });
    const ph = photos[f.id];
    await prisma.media.deleteMany({ where: { familyId: fam.id, source: { startsWith: 'pdf:' } } });
    if (ph) await prisma.media.create({ data: { familyId: fam.id, key: `products/${ph.file}`, mime: 'image/webp', isPrimary: true, source: ph.sibling ? `${ph.source}:sibling` : ph.source } });
  }
  return { families: families.length, variants: families.reduce((s, f) => s + f.variants.length, 0) };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seed(prisma)
    .then(r => console.log(`seeded ${r.families} families, ${r.variants} variants`))
    .catch(e => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
