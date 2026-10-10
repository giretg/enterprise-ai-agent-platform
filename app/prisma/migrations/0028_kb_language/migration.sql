-- #717 A réteg: KB-keresés nyelve — connector-alapértelmezés + dokumentum-felülírás.
-- A GIN expression-index csak karakterre egyező kifejezésre él, ezért nyelvenként külön index.
ALTER TABLE "connectors" ADD COLUMN "kb_language" TEXT NOT NULL DEFAULT 'hu';
ALTER TABLE "documents" ADD COLUMN "kb_language_override" TEXT;

-- Backfill: meglévő tudástár-connectorok a saját tenantjuk kimeneti nyelvét
-- kapják (`hu`/`en`; minden más — hiányzó, ismeretlen — marad `hu`, a mai viselkedés).
UPDATE "connectors" c
SET "kb_language" = t.settings ->> 'language'
FROM "tenants" t
WHERE c.tenant_id = t.id
  AND c.type = CAST('knowledge_base' AS "ConnectorType")
  AND t.settings ->> 'language' IN ('hu', 'en');

-- Angol + fallback indexek a meglévő knowledge_chunks_fts_hu_idx (0011) mellé.
-- Nagy táblán karbantartási ablakban futtatandó (CONCURRENTLY nem fér Prisma-tranzakcióba).
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_en_idx" ON "knowledge_chunks"
  USING GIN (to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || text));
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_simple_idx" ON "knowledge_chunks"
  USING GIN (to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || text));
