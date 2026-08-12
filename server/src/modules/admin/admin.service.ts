import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { getAnalyticsSummary } from '../analytics/analytics.service';
import { recordAudit } from './audit.service';
import type { PhotoStatus, Role } from '@prisma/client';

export async function getDashboardStats(days = 30) {
  const [summary, photoStatusCounts] = await Promise.all([
    getAnalyticsSummary(days),
    prisma.photo.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } })
  ]);
  return {
    ...summary,
    photosByStatus: Object.fromEntries(photoStatusCounts.map(p => [p.status, p._count._all]))
  };
}

export async function listAllPhotos(opts: { limit: number; offset: number; status?: PhotoStatus }) {
  const where = { deletedAt: null, ...(opts.status ? { status: opts.status } : {}) };
  const [photos, total] = await Promise.all([
    prisma.photo.findMany({ where, include: { ai: true }, orderBy: { createdAt: 'desc' }, take: opts.limit, skip: opts.offset }),
    prisma.photo.count({ where })
  ]);
  return { photos, total };
}

export async function listUsers(opts: { limit: number; offset: number }) {
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, username: true, role: true, emailVerified: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      skip: opts.offset
    }),
    prisma.user.count()
  ]);
  return { users, total };
}

export async function updateUserRole(targetUserId: string, role: Role, actorId: string) {
  if (targetUserId === actorId && role !== 'ADMIN') {
    throw AppError.badRequest('You cannot remove your own admin access');
  }
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw AppError.notFound('User not found');

  const updated = await prisma.user.update({ where: { id: targetUserId }, data: { role } });
  await recordAudit({ actorId, action: 'user.role_change', targetType: 'user', targetId: targetUserId, meta: { from: user.role, to: role } });
  return updated;
}

export async function listAuditLogs(opts: { limit: number; offset: number }) {
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      include: { actor: { select: { username: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      skip: opts.offset
    }),
    prisma.auditLog.count()
  ]);
  return { logs, total };
}
