-- ============================================================
-- schema.sql — Postgres 15+ with pgvector
-- Backing store for the photography archive, embeddings and RAG.
--   createdb sathvik_portfolio
--   psql sathvik_portfolio -f schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         CITEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL CHECK (char_length(username) BETWEEN 3 AND 20),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','owner')),
  failed_logins INT  NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- ---------- Photographs ----------
CREATE TABLE IF NOT EXISTS photos (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug           TEXT UNIQUE NOT NULL,
  storage_key    TEXT NOT NULL,               -- original object key in S3/R2
  width          INT,
  height         INT,
  aspect         REAL,
  bytes          BIGINT,
  mime           TEXT,
  lqip           TEXT,                        -- base64 blur placeholder
  blurhash       TEXT,
  status         TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing','ready','failed','hidden')),
  owner_note     TEXT,
  captured_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS photos_created_idx ON photos(created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS photos_status_idx ON photos(status);

-- Responsive renditions produced by the sharp pipeline
CREATE TABLE IF NOT EXISTS photo_renditions (
  id          BIGSERIAL PRIMARY KEY,
  photo_id    UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  format      TEXT NOT NULL CHECK (format IN ('avif','webp','jpeg')),
  width       INT  NOT NULL,
  height      INT  NOT NULL,
  bytes       BIGINT,
  storage_key TEXT NOT NULL,
  UNIQUE (photo_id, format, width)
);
CREATE INDEX IF NOT EXISTS renditions_photo_idx ON photo_renditions(photo_id);

-- EXIF, one row per photo
CREATE TABLE IF NOT EXISTS photo_exif (
  photo_id      UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  make          TEXT,
  model         TEXT,
  lens          TEXT,
  focal_mm      REAL,
  focal_35mm    REAL,
  aperture      REAL,
  shutter_sec   REAL,
  iso           INT,
  exposure_bias REAL,
  flash         TEXT,
  white_balance TEXT,
  software      TEXT,
  taken_at      TIMESTAMPTZ,
  gps_lat       DOUBLE PRECISION,
  gps_lon       DOUBLE PRECISION,
  place_name    TEXT,
  raw           JSONB
);
CREATE INDEX IF NOT EXISTS exif_camera_idx ON photo_exif(make, model);
CREATE INDEX IF NOT EXISTS exif_gps_idx ON photo_exif(gps_lat, gps_lon)
  WHERE gps_lat IS NOT NULL;

-- AI-generated metadata
CREATE TABLE IF NOT EXISTS photo_ai (
  photo_id       UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  caption        TEXT,
  subject        TEXT,
  description    TEXT,
  alt_text       TEXT,
  story          TEXT,
  mood           TEXT,
  composition    TEXT,
  lighting       TEXT,
  color_analysis TEXT,
  editing_style  TEXT,
  technical_note TEXT,
  location_guess TEXT,
  model_version  TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tags, categories, collections, SEO terms — one table, typed
CREATE TABLE IF NOT EXISTS photo_terms (
  id       BIGSERIAL PRIMARY KEY,
  photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('tag','category','collection','seo','hashtag')),
  value    TEXT NOT NULL,
  UNIQUE (photo_id, kind, value)
);
CREATE INDEX IF NOT EXISTS terms_lookup_idx ON photo_terms(kind, value);
CREATE INDEX IF NOT EXISTS terms_photo_idx  ON photo_terms(photo_id);
CREATE INDEX IF NOT EXISTS terms_trgm_idx   ON photo_terms USING gin (value gin_trgm_ops);

-- Dominant colour palette
CREATE TABLE IF NOT EXISTS photo_colors (
  id        BIGSERIAL PRIMARY KEY,
  photo_id  UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  hex       TEXT NOT NULL,
  r SMALLINT, g SMALLINT, b SMALLINT,
  share     REAL NOT NULL,
  rank      SMALLINT NOT NULL,
  UNIQUE (photo_id, rank)
);
CREATE INDEX IF NOT EXISTS colors_photo_idx ON photo_colors(photo_id);

-- ---------- Vectors ----------
-- 1536 dims matches text-embedding-3-small / voyage-3-lite.
CREATE TABLE IF NOT EXISTS photo_embeddings (
  photo_id   UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  embedding  VECTOR(1536) NOT NULL,
  source     TEXT NOT NULL DEFAULT 'caption+tags+story',
  model      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_embeddings_hnsw
  ON photo_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- RAG knowledge base: bio, FAQs, per-photo records
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind       TEXT NOT NULL CHECK (kind IN ('bio','faq','photo','press','service')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  photo_id   UUID REFERENCES photos(id) ON DELETE CASCADE,
  embedding  VECTOR(1536),
  token_len  INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS knowledge_fts_idx
  ON knowledge_chunks USING gin (to_tsvector('english', title || ' ' || body));

-- ---------- Analytics ----------
CREATE TABLE IF NOT EXISTS search_log (
  id          BIGSERIAL PRIMARY KEY,
  query       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('lexical','semantic','hybrid')),
  result_ids  UUID[],
  latency_ms  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photo_views (
  id         BIGSERIAL PRIMARY KEY,
  photo_id   UUID REFERENCES photos(id) ON DELETE CASCADE,
  referrer   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS views_photo_idx ON photo_views(photo_id, created_at DESC);

-- ---------- Helpers ----------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS photos_touch ON photos;
CREATE TRIGGER photos_touch BEFORE UPDATE ON photos
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Hybrid search: cosine similarity fused with trigram term matching
CREATE OR REPLACE FUNCTION search_photos(
  q_embedding VECTOR(1536),
  q_text      TEXT,
  k           INT DEFAULT 12
)
RETURNS TABLE (photo_id UUID, score REAL, vector_score REAL, term_score REAL) AS $$
  WITH vec AS (
    SELECT e.photo_id,
           1 - (e.embedding <=> q_embedding) AS vscore
    FROM photo_embeddings e
    JOIN photos p ON p.id = e.photo_id
    WHERE p.deleted_at IS NULL AND p.status = 'ready'
    ORDER BY e.embedding <=> q_embedding
    LIMIT k * 4
  ),
  terms AS (
    SELECT t.photo_id, MAX(similarity(t.value, q_text)) AS tscore
    FROM photo_terms t
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
         (1 - (e.embedding <=> (SELECT embedding FROM photo_embeddings WHERE photo_id = target)))::REAL
  FROM photo_embeddings e
  JOIN photos p ON p.id = e.photo_id
  WHERE e.photo_id <> target AND p.deleted_at IS NULL AND p.status = 'ready'
  ORDER BY e.embedding <=> (SELECT embedding FROM photo_embeddings WHERE photo_id = target)
  LIMIT k;
$$ LANGUAGE sql STABLE;
