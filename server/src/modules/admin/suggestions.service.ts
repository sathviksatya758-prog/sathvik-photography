import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { recordAudit } from './audit.service';
import { cacheDel } from '../../lib/redis';
import type { SuggestionKind, SuggestionStatus } from '@prisma/client';

export async function listSuggestions(opts: { status?: SuggestionStatus; kind?: SuggestionKind; limit: number; offset: number }) {
  const where = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.kind ? { kind: opts.kind } : {})
  };
  const [suggestions, total] = await Promise.all([
    prisma.photoSuggestion.findMany({
      where,
      include: {
        photo: { include: { ai: true } },
        duplicateOf: { include: { ai: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      skip: opts.offset
    }),
    prisma.photoSuggestion.count({ where })
  ]);
  return { suggestions, total };
}

// Approving FEATURED sets Photo.featured=true. Approving DUPLICATE/
// SIMILAR_GROUP just records the decision — deletion stays a deliberate,
// separate action via DELETE /api/photos/:id, never automatic.
export async function reviewSuggestion(id: string, status: 'APPROVED' | 'REJECTED', actorId: string) {
  const suggestion = await prisma.photoSuggestion.findUnique({ where: { id } });
  if (!suggestion) throw AppError.notFound('Suggestion not found');
  if (suggestion.status !== 'PENDING') throw AppError.conflict('Suggestion already reviewed');

  const updated = await prisma.$transaction(async tx => {
    const row = await tx.photoSuggestion.update({
      where: { id },
      data: { status, reviewedById: actorId, reviewedAt: new Date() }
    });
    if (status === 'APPROVED' && suggestion.kind === 'FEATURED') {
      await tx.photo.update({ where: { id: suggestion.photoId }, data: { featured: true } });
    }
    return row;
  });

  await recordAudit({
    actorId,
    action: `suggestion.${status.toLowerCase()}`,
    targetType: 'photo_suggestion',
    targetId: id,
    meta: { kind: suggestion.kind, photoId: suggestion.photoId }
  });
  await cacheDel('photos:list:*');
  return updated;
}
