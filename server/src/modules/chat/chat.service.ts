import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { embed, toVectorLiteral } from '../../lib/embeddings';
import { anthropic, MODEL, extractText } from '../../lib/anthropic';
import { cacheGet, cacheSet } from '../../lib/redis';
import crypto from 'node:crypto';

interface KnowledgeRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  photo_id: string | null;
  score: number;
}

// Same scope restriction as the client-side assistant in exhibition.js:
// this is a personal portfolio, not a storefront. Kept in sync with
// that prompt on purpose — this is the version that actually runs
// once Exhibition.config.apiBase points here.
export const SYSTEM_PROMPT =
  `You are the studio assistant for photographer Katnam Sathvik. This is a personal ` +
  `portfolio, not a business — Sathvik does not sell prints, take commissions, or quote ` +
  `rates. Only answer questions about his photography: individual photographs in the ` +
  `archive, his biography, when he started, how many photos are in the archive, his ` +
  `approach and style, and his equipment. Answer ONLY from the retrieved context below ` +
  `and cite the sources you used inline as [1], [2]. If asked about pricing, prints, ` +
  `licensing, bookings or anything unrelated to his photography, say plainly that this ` +
  `is personal work and not for sale, and invite a question about the photos or his ` +
  `practice instead. If the context does not contain the answer to an in-scope question, ` +
  `say so plainly. Warm, concise, under 5 sentences. Never invent dates, gear, or counts.`;

async function retrieveKnowledge(question: string, k = 6): Promise<KnowledgeRow[]> {
  const [vector] = await embed(question);
  const rows = await prisma.$queryRawUnsafe<KnowledgeRow[]>(
    `SELECT * FROM retrieve_knowledge($1::vector, $2)`,
    toVectorLiteral(vector),
    k
  );
  return rows.filter(r => r.score > 0.15);
}

// A small always-included block of facts vector search can't reliably
// surface (aggregates, "most recent", counts) — semantic retrieval is
// great at "which photo shows fog" and bad at "how many photos total".
// This is computed fresh on every call (cheap — a handful of indexed
// queries), never cached, so numbers are always current.
async function getLiveStatsContext(): Promise<string> {
  const [total, mostRecent, cameraCount, lensCount] = await Promise.all([
    prisma.photo.count({ where: { deletedAt: null, status: 'READY' } }),
    prisma.photo.findFirst({
      where: { deletedAt: null, status: 'READY' },
      orderBy: { createdAt: 'desc' },
      include: { ai: true }
    }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT TRIM(COALESCE(make,'') || COALESCE(model,'')))::bigint AS count
      FROM "photo_exif" WHERE make IS NOT NULL OR model IS NOT NULL
    `,
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT lens)::bigint AS count FROM "photo_exif" WHERE lens IS NOT NULL`
  ]);

  const lines = [
    `The archive currently holds ${total} published photograph${total === 1 ? '' : 's'}.`,
    mostRecent &&
      `The most recently added photograph is "${mostRecent.ai?.title || mostRecent.ai?.caption || 'Untitled'}", ` +
        `added ${mostRecent.createdAt.toISOString().slice(0, 10)}.`,
    `Photos were shot on ${Number(cameraCount[0]?.count ?? 0)} distinct camera bodies and ` +
      `${Number(lensCount[0]?.count ?? 0)} distinct lenses.`
  ].filter(Boolean);

  return lines.join(' ');
}

function cacheKeyFor(message: string): string {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return `chat:answer:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

async function callClaude(
  history: { role: 'user' | 'assistant'; content: string }[],
  context: string,
  message: string
): Promise<string> {
  const reply = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user' as const, content: `Retrieved context:\n\n${context}\n\nVisitor question: ${message}` }]
  });
  return extractText(reply.content);
}

export async function ask(message: string, sessionId: string | undefined, userId: string | undefined) {
  const session = sessionId
    ? await prisma.chatSession.findUnique({ where: { id: sessionId }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 12 } } })
    : null;

  const activeSession =
    session ?? (await prisma.chatSession.create({ data: { userId: userId ?? null }, include: { messages: true } }));

  const history = (activeSession.messages ?? []).slice(-6).map(m => ({ role: m.role, content: m.content }));
  // Only cache when there's no prior turn — a follow-up's correct answer
  // usually depends on conversation context, so it must always be a live call.
  const isCacheable = history.length === 0;
  const cacheKey = cacheKeyFor(message);

  const [hits, liveStats] = await Promise.all([retrieveKnowledge(message, 6), getLiveStatsContext()]);
  const context = [
    `[live] Current archive stats: ${liveStats}`,
    ...(hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.body}`) : ['No matching entries in the archive.'])
  ].join('\n\n');

  let answer: string | null = isCacheable ? await cacheGet<string>(cacheKey) : null;
  const fromCache = answer !== null;
  if (!answer) {
    try {
      answer = await callClaude(history, context, message);
    } catch {
      throw AppError.badGateway('The studio assistant is unavailable right now — try again shortly.');
    }
    if (isCacheable) await cacheSet(cacheKey, answer, 600); // 10 min — long enough to absorb bursts of the same FAQ
  }

  const sources = hits.map((h, i) => ({ n: i + 1, title: h.title, kind: h.kind, photoId: h.photo_id }));

  await prisma.$transaction([
    prisma.chatMessage.create({ data: { sessionId: activeSession.id, role: 'user', content: message } }),
    prisma.chatMessage.create({ data: { sessionId: activeSession.id, role: 'assistant', content: answer, sources: sources as never } }),
    prisma.chatSession.update({ where: { id: activeSession.id }, data: { updatedAt: new Date() } })
  ]);

  return { sessionId: activeSession.id, message: answer, sources, cached: fromCache };
}

// Streaming variant for POST /api/chat/stream — same retrieval + prompt,
// but yields text deltas as they arrive from Claude instead of waiting
// for the full response. Persistence happens once the stream ends.
export async function* askStream(
  message: string,
  sessionId: string | undefined,
  userId: string | undefined
): AsyncGenerator<{ type: 'sessionId' | 'delta' | 'sources' | 'done'; data: unknown }> {
  const session = sessionId
    ? await prisma.chatSession.findUnique({ where: { id: sessionId }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 12 } } })
    : null;
  const activeSession =
    session ?? (await prisma.chatSession.create({ data: { userId: userId ?? null }, include: { messages: true } }));

  yield { type: 'sessionId', data: activeSession.id };

  const history = (activeSession.messages ?? []).slice(-6).map(m => ({ role: m.role, content: m.content }));
  const [hits, liveStats] = await Promise.all([retrieveKnowledge(message, 6), getLiveStatsContext()]);
  const context = [
    `[live] Current archive stats: ${liveStats}`,
    ...(hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.body}`) : ['No matching entries in the archive.'])
  ].join('\n\n');
  const sources = hits.map((h, i) => ({ n: i + 1, title: h.title, kind: h.kind, photoId: h.photo_id }));

  let full = '';
  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [...history, { role: 'user' as const, content: `Retrieved context:\n\n${context}\n\nVisitor question: ${message}` }]
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        yield { type: 'delta', data: event.delta.text };
      }
    }
  } catch {
    throw AppError.badGateway('The studio assistant is unavailable right now — try again shortly.');
  }

  yield { type: 'sources', data: sources };

  await prisma.$transaction([
    prisma.chatMessage.create({ data: { sessionId: activeSession.id, role: 'user', content: message } }),
    prisma.chatMessage.create({ data: { sessionId: activeSession.id, role: 'assistant', content: full, sources: sources as never } }),
    prisma.chatSession.update({ where: { id: activeSession.id }, data: { updatedAt: new Date() } })
  ]);

  yield { type: 'done', data: null };
}

export async function getSession(sessionId: string, userId: string | undefined) {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: { messages: { orderBy: { createdAt: 'asc' } } }
  });
  if (!session) throw AppError.notFound('Chat session not found');
  if (session.userId && session.userId !== userId) throw AppError.forbidden();
  return session;
}

// Rebuilds the non-photo half of the knowledge base (bio, approach,
// equipment, and anything else the owner curates). Photo chunks are
// managed separately by the upload worker. Ported/extended from
// legacy/lib.ts::reindexKnowledge.
export async function reindexKnowledge(entries: { kind: string; title: string; body: string }[]): Promise<number> {
  const vectors = await embed(entries.map(e => e.body));
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`DELETE FROM knowledge_chunks WHERE kind <> 'photo'`);
    for (const [i, e] of entries.entries()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO knowledge_chunks (kind, title, body, embedding, token_len) VALUES ($1, $2, $3, $4::vector, $5)`,
        e.kind,
        e.title,
        e.body,
        toVectorLiteral(vectors[i]!),
        Math.ceil(e.body.length / 4)
      );
    }
  });
  return entries.length;
}

export const DEFAULT_KNOWLEDGE_ENTRIES = [
  {
    kind: 'bio',
    title: 'Biography',
    body: 'Katnam Sathvik is a photographer based in Visakhapatnam, Andhra Pradesh, India. He started photography in 2023, shooting nature, monuments, wildlife and humans, primarily on film.'
  },
  {
    kind: 'bio',
    title: 'Approach',
    body: 'His approach is patient and slow. Most of his strongest frames happen inside five minutes of real conversation rather than direction. The work sits in the seam between documentary and memory.'
  },
  {
    kind: 'faq',
    title: 'Equipment',
    body: 'Works primarily with film cameras, supported by digital bodies. Camera and lens details for each frame are recorded in the EXIF panel on every photograph.'
  }
];

export async function seedDefaultKnowledgeIfEmpty(): Promise<void> {
  const count = await prisma.knowledgeChunk.count({ where: { kind: { not: 'photo' } } });
  if (count > 0) return;
  await reindexKnowledge(DEFAULT_KNOWLEDGE_ENTRIES);
}
