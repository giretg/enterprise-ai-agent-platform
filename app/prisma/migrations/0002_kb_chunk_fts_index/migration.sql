-- Postgres full-text (GIN) index on knowledge_chunks (Knowledge-Base-v3-OKF-Spec §8.4/§10).
--
-- `prisma db push` does NOT create expression-based tsvector GIN indexes, so — like the
-- audit append-only trigger — it is installed as raw SQL. The index backs `kb_search v2`
-- (`searchChunks`), which queries exactly this expression with `@@ to_tsquery(...)` and
-- `ts_rank` ordering. The `simple` config is deterministic and works on Neon without any
-- extension (no stemmer/unaccent dependency — §10.1).
--
-- NOTE: not representable in prisma/schema.prisma. Applied here so it becomes part of the
-- versioned migration history (WP-5). Mirrors scripts/apply-kb-chunk-fts-index.ts.

CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx
  ON knowledge_chunks
  USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || text));
