import type { PrismaClient } from '@prisma/client';

/** Setting that holds the senior manager (owner) after a transfer in the panel; it wins over ADMIN_TELEGRAM_IDS. */
export const OWNER_KEY = 'owner.telegramIds';

export const envOwners = () => (process.env.ADMIN_TELEGRAM_IDS ?? '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x));

/** Telegram IDs of the senior manager(s): always active managers, whose role nobody else can change. */
export async function ownerIds(prisma: Pick<PrismaClient, 'setting'>): Promise<string[]> {
  const s = await prisma.setting.findUnique({ where: { key: OWNER_KEY } });
  const v = Array.isArray(s?.value) ? (s!.value as unknown[]).map(String).filter(x => /^\d+$/.test(x)) : [];
  return v.length ? v : envOwners();
}
