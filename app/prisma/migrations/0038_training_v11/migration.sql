-- MemoryTraining v1.1: betanított szabályverzió és projektmemória-manifeszt
-- külön logikai verziólánc; ticketen belüli javaslat-revíziók.

CREATE TYPE "memory_version_kind" AS ENUM ('instruction', 'project_manifest');
CREATE TYPE "training_origin" AS ENUM ('human', 'reflection');
CREATE TYPE "training_scope_class" AS ENUM ('memory', 'behavior', 'role');
CREATE TYPE "training_proposal_composition_mode" AS ENUM ('build_on_pending', 'replace_pending');
CREATE TYPE "training_proposal_revision_status" AS ENUM ('current', 'superseded');
CREATE TYPE "training_proposal_token_status" AS ENUM ('unissued', 'issued', 'consumed', 'expired', 'revoked');

ALTER TABLE "memory_versions"
  ADD COLUMN "kind" "memory_version_kind" NOT NULL DEFAULT 'instruction',
  ADD COLUMN "parent_version" INTEGER;

-- A meglévő T2 manifesztek (chunk-id lista, üres content) a projektmemória-láncra mennek.
UPDATE "memory_versions"
SET "kind" = 'project_manifest'
WHERE "active_chunk_ids" IS NOT NULL
  AND ("content" IS NULL OR btrim("content") = '');

ALTER TABLE "memories"
  ADD COLUMN "project_manifest_current_version_id" UUID;

DROP INDEX "memory_versions_memory_id_version_key";
CREATE UNIQUE INDEX "memory_versions_memory_id_kind_version_key"
  ON "memory_versions"("memory_id", "kind", "version");
CREATE INDEX "memory_versions_memory_id_kind_status_idx"
  ON "memory_versions"("memory_id", "kind", "status");

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_project_manifest_current_version_id_fkey"
  FOREIGN KEY ("project_manifest_current_version_id") REFERENCES "memory_versions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Minden memória aktuális projektmemória-manifesztje a scope-független
-- legutóbbi project_manifest sor (ha van).
UPDATE "memories" m
SET "project_manifest_current_version_id" = latest.id
FROM (
  SELECT DISTINCT ON ("memory_id") "id", "memory_id"
  FROM "memory_versions"
  WHERE "kind" = 'project_manifest'
  ORDER BY "memory_id", "version" DESC
) latest
WHERE m.id = latest."memory_id";

-- A legacy current pointer az instruction-lánc kizárólagos mutatója marad. Ha
-- korábban mégis manifesztre mutatott, álljon vissza a legutóbbi aktív
-- instruction-verzióra; a manifesztnek már külön current pointere van.
UPDATE "memories" m
SET "current_version_id" = latest.id
FROM (
  SELECT DISTINCT ON ("memory_id") "id", "memory_id"
  FROM "memory_versions"
  WHERE "kind" = 'instruction' AND "status" = 'active'
  ORDER BY "memory_id", "version" DESC
) latest
WHERE m.id = latest."memory_id"
  AND (
    m."current_version_id" IS NULL
    OR EXISTS (
      SELECT 1
      FROM "memory_versions" pointed
      WHERE pointed.id = m."current_version_id"
        AND pointed."kind" = 'project_manifest'
    )
  );

-- Ha még egyetlen instruction-verzió sincs, a legacy manifeszt-pointert
-- nullázzuk. Így az első instruction aktiválás null-ról induló CAS-a sikerülhet.
UPDATE "memories" m
SET "current_version_id" = NULL
WHERE EXISTS (
  SELECT 1
  FROM "memory_versions" pointed
  WHERE pointed.id = m."current_version_id"
    AND pointed."kind" = 'project_manifest'
)
AND NOT EXISTS (
  SELECT 1
  FROM "memory_versions" instruction
  WHERE instruction."memory_id" = m.id
    AND instruction."kind" = 'instruction'
    AND instruction."status" = 'active'
);

-- Az alkalmazás előnézeti ellenőrzése önmagában nem elég: két párhuzamos
-- operátor ugyanabban a pillanatban is submitolhat. A részleges unique index a
-- kanonikus DB-invariáns; a KB- és projektmemória-ticketek külön folyamatok.
CREATE UNIQUE INDEX "tickets_one_open_instruction_training_per_agent_key"
  ON "tickets"("agent_id")
  WHERE "type" = 'training'
    AND "agent_id" IS NOT NULL
    AND "state" IN ('backlog', 'ready', 'in_progress', 'awaiting_human', 'needs_info')
    AND COALESCE("payload"->>'kind', '') NOT IN ('kb_document', 'memory_candidate');

ALTER TABLE "training_tickets"
  ADD COLUMN "eval_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "origin" "training_origin" NOT NULL DEFAULT 'human',
  ADD COLUMN "scope_class" "training_scope_class" NOT NULL DEFAULT 'memory',
  ADD COLUMN "current_revision_id" UUID;

CREATE UNIQUE INDEX "training_tickets_current_revision_id_key"
  ON "training_tickets"("current_revision_id");

CREATE TABLE "training_proposal_revisions" (
  "id" UUID NOT NULL,
  "training_ticket_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "base_version_id" UUID NOT NULL,
  "proposed_version_ref" TEXT NOT NULL,
  "change_summary" JSONB NOT NULL,
  "impact_result" JSONB NOT NULL,
  "composition_mode" "training_proposal_composition_mode" NOT NULL,
  "status" "training_proposal_revision_status" NOT NULL DEFAULT 'current',
  "target_memory_version" INTEGER NOT NULL,
  "write_gate_token_ref" TEXT,
  "token_status" "training_proposal_token_status" NOT NULL DEFAULT 'unissued',
  "token_expires_at" TIMESTAMPTZ,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "training_proposal_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "training_proposal_revisions_training_ticket_id_revision_key"
  ON "training_proposal_revisions"("training_ticket_id", "revision");
CREATE INDEX "training_proposal_revisions_training_ticket_id_status_idx"
  ON "training_proposal_revisions"("training_ticket_id", "status");

ALTER TABLE "training_proposal_revisions"
  ADD CONSTRAINT "training_proposal_revisions_training_ticket_id_fkey"
  FOREIGN KEY ("training_ticket_id") REFERENCES "training_tickets"("ticket_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "training_tickets"
  ADD CONSTRAINT "training_tickets_current_revision_id_fkey"
  FOREIGN KEY ("current_revision_id") REFERENCES "training_proposal_revisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
