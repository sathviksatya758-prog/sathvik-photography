-- Site-wide owner settings (key/value). Currently used for the homepage
-- hero/intro photo selection.
CREATE TABLE IF NOT EXISTS "site_settings" (
  "key"        TEXT PRIMARY KEY,
  "value"      TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
