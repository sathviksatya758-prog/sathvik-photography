-- ============================================================
-- Hand-written additions — Prisma's migrate diff can't express
-- pgvector HNSW indexes, triggers, or SQL functions, so these are
-- ported/extended from legacy/schema.sql by hand and appended to
-- the end of prisma/migrations/000_init/migration.sql after every
-- regeneration (e.g. `npx prisma migrate diff --from-empty
-- --to-schema-datamodel prisma/schema.prisma --script`).
--
-- Regenerate + reapply with:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/000_init/migration.sql
--   cat prisma/manual-additions.sql >> prisma/migrations/000_init/migration.sql
-- ============================================================

-- HNSW indexes for cosine similarity search over embeddings
CREATE INDEX IF NOT EXISTS photo_embeddings_hnsw
  ON "photo_embeddings" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS knowledge_hnsw
  ON "knowledge_chunks" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Trigram index for term matching (photo_terms.value already indexed
-- via terms_lookup_idx for exact lookups; this adds fuzzy matching)
CREATE INDEX IF NOT EXISTS terms_trgm_idx
  ON "photo_terms" USING gin (value gin_trgm_ops);

-- Full-text index kept for potential lexical fallback over the RAG corpus
CREATE INDEX IF NOT EXISTS knowledge_fts_idx
  ON "knowledge_chunks" USING gin (to_tsvector('english', title || ' ' || body));

-- Prisma's @updatedAt only sets the value on writes made through
-- Prisma Client. This trigger keeps updated_at correct for any
-- direct SQL (e.g. the search functions, admin scripts, migrations).
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS photos_touch ON "photos";
CREATE TRIGGER photos_touch BEFORE UPDATE ON "photos"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS collections_touch ON "collections";
CREATE TRIGGER collections_touch BEFORE UPDATE ON "collections"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS chat_sessions_touch ON "chat_sessions";
CREATE TRIGGER chat_sessions_touch BEFORE UPDATE ON "chat_sessions"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Hybrid search: cosine similarity (75%) fused with trigram term
-- matching (25%) over READY, non-deleted photos.
CREATE OR REPLACE FUNCTION search_photos(
  q_embedding VECTOR(1536),
  q_text      TEXT,
  k           INT DEFAULT 12
)
RETURNS TABLE (photo_id UUID, score REAL, vector_score REAL, term_score REAL) AS $$
  WITH vec AS (
    SELECT e.photo_id,
           1 - (e.embedding <=> q_embedding) AS vscore
    FROM "photo_embeddings" e
    JOIN "photos" p ON p.id = e.photo_id
    WHERE p.deleted_at IS NULL AND p.status = 'READY'
    ORDER BY e.embedding <=> q_embedding
    LIMIT k * 4
  ),
  terms AS (
    SELECT t.photo_id, MAX(similarity(t.value, q_text)) AS tscore
    FROM "photo_terms" t
    WHERE t.value % q_text
    GROUP BY t.photo_id
  )
  SELECT COALESCE(vec.photo_id, terms.photo_id)                       AS photo_id,
         (COALESCE(vec.vscore, 0) * 0.75
          + COALESCE(terms.tscore, 0) * 0.25)::REAL                   AS score,
         COALESCE(vec.vscore, 0)::REAL                                AS vector_score,
         COALESCE(terms.tscore, 0)::REAL                              AS term_score
  FROM vec FULL OUTER JOIN terms ON vec.photo_id = terms.photo_id
  ORDER BY score DESC
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Visually similar frames for the related-photos rail
CREATE OR REPLACE FUNCTION similar_photos(target UUID, k INT DEFAULT 6)
RETURNS TABLE (photo_id UUID, score REAL) AS $$
  SELECT e.photo_id,
         (1 - (e.embedding <=> (SELECT embedding FROM "photo_embeddings" WHERE photo_id = target)))::REAL
  FROM "photo_embeddings" e
  JOIN "photos" p ON p.id = e.photo_id
  WHERE e.photo_id <> target AND p.deleted_at IS NULL AND p.status = 'READY'
  ORDER BY e.embedding <=> (SELECT embedding FROM "photo_embeddings" WHERE photo_id = target)
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- RAG retrieval over the knowledge base (bio, FAQs, per-photo chunks)
CREATE OR REPLACE FUNCTION retrieve_knowledge(q_embedding VECTOR(1536), k INT DEFAULT 6)
RETURNS TABLE (id UUID, kind "KnowledgeKind", title TEXT, body TEXT, photo_id UUID, score REAL) AS $$
  SELECT c.id, c.kind, c.title, c.body, c.photo_id,
         (1 - (c.embedding <=> q_embedding))::REAL AS score
  FROM "knowledge_chunks" c
  WHERE c.embedding IS NOT NULL
  ORDER BY c.embedding <=> q_embedding
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Near-duplicate detection: embeddings above `threshold` cosine
-- similarity are very likely the same frame (a re-edit, a burst-shot
-- variant, a re-upload) rather than merely "related". Used to generate
-- PhotoSuggestion(kind='DUPLICATE') rows for admin review — nothing is
-- ever auto-deleted.
CREATE OR REPLACE FUNCTION find_duplicate_photos(target UUID, threshold REAL DEFAULT 0.985)
RETURNS TABLE (photo_id UUID, score REAL) AS $$
  SELECT e.photo_id,
         (1 - (e.embedding <=> (SELECT embedding FROM "photo_embeddings" WHERE photo_id = target)))::REAL AS score
  FROM "photo_embeddings" e
  JOIN "photos" p ON p.id = e.photo_id
  WHERE e.photo_id <> target AND p.deleted_at IS NULL
    AND (1 - (e.embedding <=> (SELECT embedding FROM "photo_embeddings" WHERE photo_id = target))) >= threshold
  ORDER BY score DESC;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- Discovery / recommendation additions
-- ============================================================

-- Palette similarity: euclidean distance between dominant colours,
-- normalised to 0..1 (441.673 = max RGB distance, sqrt(255^2*3)).
-- Powers the "Same Colour Palette" recommendation rail.
CREATE OR REPLACE FUNCTION similar_by_palette(target UUID, k INT DEFAULT 12)
RETURNS TABLE (photo_id UUID, score REAL) AS $$
  WITH t AS (
    SELECT r, g, b FROM "photo_colors"
    WHERE photo_id = target AND r IS NOT NULL
    ORDER BY rank LIMIT 1
  )
  SELECT c.photo_id,
         (1 - (sqrt(power(c.r - t.r, 2) + power(c.g - t.g, 2) + power(c.b - t.b, 2)) / 441.673))::REAL AS score
  FROM "photo_colors" c
  CROSS JOIN t
  JOIN "photos" p ON p.id = c.photo_id
  WHERE c.rank = 0
    AND c.r IS NOT NULL
    AND c.photo_id <> target
    AND p.deleted_at IS NULL
    AND p.status = 'READY'
  ORDER BY score DESC
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Geographic proximity via the haversine formula (6371 km earth radius).
-- Powers the "Same Location" rail and the photography map's marker panel.
CREATE OR REPLACE FUNCTION nearby_photos(target UUID, radius_km REAL DEFAULT 50, k INT DEFAULT 12)
RETURNS TABLE (photo_id UUID, distance_km REAL) AS $$
  WITH t AS (
    SELECT gps_lat AS lat, gps_lon AS lon FROM "photo_exif"
    WHERE photo_id = target AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
  )
  SELECT e.photo_id,
         (6371 * acos(
            LEAST(1, GREATEST(-1,
              cos(radians(t.lat)) * cos(radians(e.gps_lat)) *
              cos(radians(e.gps_lon) - radians(t.lon)) +
              sin(radians(t.lat)) * sin(radians(e.gps_lat))
            ))
         ))::REAL AS distance_km
  FROM "photo_exif" e
  CROSS JOIN t
  JOIN "photos" p ON p.id = e.photo_id
  WHERE e.photo_id <> target
    AND e.gps_lat IS NOT NULL AND e.gps_lon IS NOT NULL
    AND p.deleted_at IS NULL AND p.status = 'READY'
    AND (6371 * acos(
          LEAST(1, GREATEST(-1,
            cos(radians(t.lat)) * cos(radians(e.gps_lat)) *
            cos(radians(e.gps_lon) - radians(t.lon)) +
            sin(radians(t.lat)) * sin(radians(e.gps_lat))
          ))
       )) <= radius_km
  ORDER BY distance_km ASC
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Supporting indexes for the metadata-similarity rails.
CREATE INDEX IF NOT EXISTS exif_lens_idx ON "photo_exif"(lens) WHERE lens IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_genre_idx ON "photo_ai"(genre) WHERE genre IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_mood_idx ON "photo_ai"(mood) WHERE mood IS NOT NULL;
CREATE INDEX IF NOT EXISTS colors_rank0_idx ON "photo_colors"(photo_id) WHERE rank = 0;
CREATE INDEX IF NOT EXISTS photos_featured_idx ON "photos"(featured) WHERE featured = true;
