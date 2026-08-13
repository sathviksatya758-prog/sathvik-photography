-- Owner-set display title/name for a photograph (shown across the archive).
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "title" TEXT;
