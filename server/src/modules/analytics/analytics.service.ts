import type { Request } from 'express';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { randomUUID } from 'node:crypto';

// Anonymous per-browser id, read from a non-httpOnly cookie the
// frontend can set client-side (no PII, just groups events from the
// same visitor for the analytics dashboard's session counts).
export function getOrCreateAnalyticsSessionId(req: Request): string {
  return (req.cookies?.aid as string | undefined) ?? randomUUID();
}

export async function recordEvent(entry: {
  type: string;
  path?: string;
  photoId?: string;
  meta?: Record<string, unknown>;
  req: Request;
}): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: {
        type: entry.type,
        path: entry.path,
        photoId: entry.photoId,
        sessionId: getOrCreateAnalyticsSessionId(entry.req),
        ip: entry.req.ip,
        userAgent: entry.req.headers['user-agent'],
        referrer: entry.req.headers.referer,
        meta: entry.meta as never
      }
    });
  } catch (err) {
    // Analytics must never break the request that triggered it.
    logger.error({ err, entry: { type: entry.type, path: entry.path } }, 'recordEvent failed');
  }
}

export async function getAnalyticsSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [eventsByType, topPhotosRaw, topPaths, dailyRaw, totalPhotos, totalUsers, totalContacts] = await Promise.all([
    prisma.analyticsEvent.groupBy({ by: ['type'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.photoView.groupBy({
      by: ['photoId'],
      where: { createdAt: { gte: since }, photoId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { photoId: 'desc' } },
      take: 10
    }),
    prisma.analyticsEvent.groupBy({
      by: ['path'],
      where: { createdAt: { gte: since }, type: 'page_view' },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: 10
    }),
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', created_at) AS day, COUNT(*)::bigint AS count
      FROM analytics_events
      WHERE created_at >= ${since}
      GROUP BY 1 ORDER BY 1 ASC
    `,
    prisma.photo.count({ where: { deletedAt: null } }),
    prisma.user.count(),
    prisma.contactMessage.count({ where: { status: 'NEW' } })
  ]);

  const topPhotoIds = topPhotosRaw.map(t => t.photoId).filter((id): id is string => !!id);
  const topPhotos = topPhotoIds.length
    ? await prisma.photo.findMany({ where: { id: { in: topPhotoIds } }, include: { ai: true } })
    : [];

  return {
    rangeDays: days,
    totals: { photos: totalPhotos, users: totalUsers, unreadMessages: totalContacts },
    eventsByType: Object.fromEntries(eventsByType.map(e => [e.type, e._count._all])),
    topPaths: topPaths.map(p => ({ path: p.path, views: p._count._all })),
    topPhotos: topPhotosRaw.map(t => ({
      photoId: t.photoId,
      views: t._count._all,
      caption: topPhotos.find(p => p.id === t.photoId)?.ai?.caption ?? null,
      slug: topPhotos.find(p => p.id === t.photoId)?.slug ?? null
    })),
    daily: dailyRaw.map(d => ({ day: d.day, count: Number(d.count) }))
  };
}
