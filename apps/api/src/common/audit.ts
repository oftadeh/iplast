import { PrismaService } from '../prisma/prisma.service';

export function audit(prisma: PrismaService, actorId: string, action: string, entity: string, entityId: string, before: unknown, after: unknown) {
  const j = (x: unknown) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))));
  return prisma.auditLog.create({ data: { actorId, action, entity, entityId, before: j(before), after: j(after) } });
}
