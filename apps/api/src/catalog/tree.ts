import type { PrismaService } from '../prisma/prisma.service';

export interface TreeCat { id: string; slug: string; name: string; parentId: string | null; sortOrder: number }

/**
 * The category tree (branch → sub-branch → …), loaded whole: it is a few dozen rows. Gives each category's chain up
 * to the root (for percents set on a branch), its descendants (a branch shows the products of its sub-branches) and
 * its path name «اتصالات پیچی › زانو».
 */
export async function categoryTree(prisma: PrismaService) {
  const all: TreeCat[] = await prisma.category.findMany({ select: { id: true, slug: true, name: true, parentId: true, sortOrder: true } });
  const byId = new Map(all.map(c => [c.id, c]));
  const kids = new Map<string | null, TreeCat[]>();
  for (const c of all) {
    const p = c.parentId && byId.has(c.parentId) ? c.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  for (const l of kids.values()) l.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'fa'));
  const chain = (id: string) => {
    const out: string[] = [];
    for (let c = byId.get(id); c && !out.includes(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) out.push(c.id);
    return out;
  };
  const descendants = (id: string) => {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) ?? []) if (!out.includes(k.id)) out.push(k.id);
    return out;
  };
  const path = (id: string) => chain(id).reverse().map(x => byId.get(x)!.name).join(' › ');
  /** Every category in tree order (a branch, then its sub-branches), with its depth. */
  const ordered = () => {
    const out: (TreeCat & { depth: number })[] = [];
    const walk = (p: string | null, depth: number) => { for (const c of kids.get(p) ?? []) { out.push({ ...c, depth }); if (depth < 6) walk(c.id, depth + 1); } };
    walk(null, 0);
    return out;
  };
  return { all, byId, kids, chain, descendants, path, ordered };
}
