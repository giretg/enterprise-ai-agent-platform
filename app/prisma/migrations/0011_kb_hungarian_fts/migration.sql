-- KB kereső magyar szótövezéssel + stopszó-szűréssel (knowledge-repository.ts KB_FTS_CONFIG).
-- Ha ez a migráció még nem futott le, a keresés helyes marad, csak index nélkül (seq scan).
DROP INDEX IF EXISTS "knowledge_chunks_fts_idx";
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_hu_idx" ON "knowledge_chunks"
  USING GIN (to_tsvector('hungarian'::regconfig, coalesce(title, '') || ' ' || text));
