import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

export async function recordAudit(entry: {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        meta: entry.meta as never,
        ip: entry.ip
      }
    });
  } catch (err) {
    // Auditing must never break the request it's auditing.
    logger.error({ err, entry }, 'recordAudit failed');
  }
}
