-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "RenditionFormat" AS ENUM ('avif', 'webp', 'jpeg');

-- CreateEnum
CREATE TYPE "SuggestionKind" AS ENUM ('FEATURED', 'DUPLICATE', 'SIMILAR_GROUP', 'COLLECTION');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TermKind" AS ENUM ('tag', 'category', 'collection', 'seo', 'hashtag');

-- CreateEnum
CREATE TYPE "KnowledgeKind" AS ENUM ('bio', 'faq', 'photo', 'press', 'service');

-- CreateEnum
CREATE TYPE "CollectionKind" AS ENUM ('COLLECTION', 'ALBUM', 'PROJECT', 'STORY', 'JOURNAL', 'SEASONAL');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'READ', 'REPLIED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "email" CITEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "slug" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "aspect" DOUBLE PRECISION,
    "bytes" BIGINT,
    "mime" TEXT,
    "lqip" TEXT,
    "blurhash" TEXT,
    "status" "PhotoStatus" NOT NULL DEFAULT 'PROCESSING',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "owner_note" TEXT,
    "captured_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_renditions" (
    "id" BIGSERIAL NOT NULL,
    "photo_id" UUID NOT NULL,
    "format" "RenditionFormat" NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BIGINT,
    "storage_key" TEXT NOT NULL,

    CONSTRAINT "photo_renditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_exif" (
    "photo_id" UUID NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "lens" TEXT,
    "focal_mm" DOUBLE PRECISION,
    "focal_35mm" DOUBLE PRECISION,
    "aperture" DOUBLE PRECISION,
    "shutter_sec" DOUBLE PRECISION,
    "iso" INTEGER,
    "exposure_bias" DOUBLE PRECISION,
    "flash" TEXT,
    "white_balance" TEXT,
    "software" TEXT,
    "taken_at" TIMESTAMPTZ,
    "gps_lat" DOUBLE PRECISION,
    "gps_lon" DOUBLE PRECISION,
    "place_name" TEXT,
    "raw" JSONB,

    CONSTRAINT "photo_exif_pkey" PRIMARY KEY ("photo_id")
);

-- CreateTable
CREATE TABLE "photo_ai" (
    "photo_id" UUID NOT NULL,
    "title" TEXT,
    "caption" TEXT,
    "subject" TEXT,
    "description" TEXT,
    "alt_text" TEXT,
    "story" TEXT,
    "mood" TEXT,
    "composition" TEXT,
    "lighting" TEXT,
    "color_analysis" TEXT,
    "editing_style" TEXT,
    "genre" TEXT,
    "social_caption" TEXT,
    "technical_note" TEXT,
    "location_guess" TEXT,
    "model_version" TEXT,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "short_caption" TEXT,
    "long_caption" TEXT,
    "scene_description" TEXT,
    "color_harmony" TEXT,
    "camera_technique" TEXT,
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instagram_caption" TEXT,
    "linkedin_caption" TEXT,
    "twitter_caption" TEXT,
    "scene_classification" TEXT,
    "weather_estimate" TEXT,
    "time_of_day_estimate" TEXT,
    "lighting_quality" TEXT,
    "rule_of_thirds" BOOLEAN,
    "symmetry_detected" BOOLEAN,
    "leading_lines" BOOLEAN,
    "composition_score" INTEGER,
    "quality_score" INTEGER,

    CONSTRAINT "photo_ai_pkey" PRIMARY KEY ("photo_id")
);

-- CreateTable
CREATE TABLE "photo_critiques" (
    "photo_id" UUID NOT NULL,
    "exposure" TEXT,
    "composition_improvements" TEXT,
    "cropping_suggestion" TEXT,
    "white_balance" TEXT,
    "sharpness_feedback" TEXT,
    "noise_analysis" TEXT,
    "editing_recommendations" TEXT,
    "model_version" TEXT,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_critiques_pkey" PRIMARY KEY ("photo_id")
);

-- CreateTable
CREATE TABLE "photo_suggestions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "photo_id" UUID NOT NULL,
    "kind" "SuggestionKind" NOT NULL,
    "value" TEXT,
    "duplicate_of_id" UUID,
    "confidence" DOUBLE PRECISION,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_terms" (
    "id" BIGSERIAL NOT NULL,
    "photo_id" UUID NOT NULL,
    "kind" "TermKind" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "photo_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_colors" (
    "id" BIGSERIAL NOT NULL,
    "photo_id" UUID NOT NULL,
    "hex" TEXT NOT NULL,
    "r" INTEGER,
    "g" INTEGER,
    "b" INTEGER,
    "share" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "photo_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_embeddings" (
    "photo_id" UUID NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'caption+tags+story',
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_embeddings_pkey" PRIMARY KEY ("photo_id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "kind" "KnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "photo_id" UUID,
    "embedding" vector(1536),
    "token_len" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "user_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("user_id","photo_id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "CollectionKind" NOT NULL DEFAULT 'COLLECTION',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "cover_photo_id" UUID,
    "share_slug" TEXT,
    "password_hash" TEXT,
    "expires_at" TIMESTAMPTZ,
    "allow_download" BOOLEAN NOT NULL DEFAULT true,
    "watermark" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_photos" (
    "collection_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_photos_pkey" PRIMARY KEY ("collection_id","photo_id")
);

-- CreateTable
CREATE TABLE "downloads" (
    "id" BIGSERIAL NOT NULL,
    "photo_id" UUID NOT NULL,
    "user_id" UUID,
    "rendition" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "session_id" UUID NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_log" (
    "id" BIGSERIAL NOT NULL,
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "result_ids" UUID[],
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_views" (
    "id" BIGSERIAL NOT NULL,
    "photo_id" UUID,
    "referrer" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "path" TEXT,
    "photo_id" UUID,
    "session_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "referrer" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "photos_slug_key" ON "photos"("slug");

-- CreateIndex
CREATE INDEX "photos_created_idx" ON "photos"("created_at" DESC);

-- CreateIndex
CREATE INDEX "photos_status_idx" ON "photos"("status");

-- CreateIndex
CREATE INDEX "renditions_photo_idx" ON "photo_renditions"("photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_renditions_photo_id_format_width_key" ON "photo_renditions"("photo_id", "format", "width");

-- CreateIndex
CREATE INDEX "exif_camera_idx" ON "photo_exif"("make", "model");

-- CreateIndex
CREATE INDEX "suggestions_status_idx" ON "photo_suggestions"("status", "kind");

-- CreateIndex
CREATE INDEX "suggestions_photo_idx" ON "photo_suggestions"("photo_id");

-- CreateIndex
CREATE INDEX "terms_lookup_idx" ON "photo_terms"("kind", "value");

-- CreateIndex
CREATE INDEX "terms_photo_idx" ON "photo_terms"("photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_terms_photo_id_kind_value_key" ON "photo_terms"("photo_id", "kind", "value");

-- CreateIndex
CREATE INDEX "colors_photo_idx" ON "photo_colors"("photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_colors_photo_id_rank_key" ON "photo_colors"("photo_id", "rank");

-- CreateIndex
CREATE INDEX "favorites_photo_idx" ON "favorites"("photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "collections_share_slug_key" ON "collections"("share_slug");

-- CreateIndex
CREATE INDEX "collections_share_idx" ON "collections"("share_slug");

-- CreateIndex
CREATE UNIQUE INDEX "collections_user_id_name_key" ON "collections"("user_id", "name");

-- CreateIndex
CREATE INDEX "downloads_photo_idx" ON "downloads"("photo_id");

-- CreateIndex
CREATE INDEX "chat_messages_session_idx" ON "chat_messages"("session_id");

-- CreateIndex
CREATE INDEX "contact_status_idx" ON "contact_messages"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "views_photo_idx" ON "photo_views"("photo_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "analytics_type_idx" ON "analytics_events"("type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_actor_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_target_idx" ON "audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_renditions" ADD CONSTRAINT "photo_renditions_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_exif" ADD CONSTRAINT "photo_exif_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_ai" ADD CONSTRAINT "photo_ai_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_critiques" ADD CONSTRAINT "photo_critiques_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_suggestions" ADD CONSTRAINT "photo_suggestions_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_suggestions" ADD CONSTRAINT "photo_suggestions_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_terms" ADD CONSTRAINT "photo_terms_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_colors" ADD CONSTRAINT "photo_colors_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_photos" ADD CONSTRAINT "collection_photos_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_photos" ADD CONSTRAINT "collection_photos_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_views" ADD CONSTRAINT "photo_views_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
