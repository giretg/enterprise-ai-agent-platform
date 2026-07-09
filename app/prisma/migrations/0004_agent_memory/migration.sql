-- Tartós agent-memória, WP-1 (agent-memory-persistent-cross-conversation-spec.md §9, §23).
--
-- T2 kanonikus tábla (`memory_chunks`) + T1 javaslat-tár (`memory_candidates`);
-- a `memory_versions` mostantól T2 pillanatkép-manifeszt (`content` legacy,
-- NULL-olható, §9.3); a `write_gate_tokens` bővül az inline (ticket nélküli)
-- jóváhagyási úthoz (§9.4); a `conversations` kap egy chat-oldali projekt
-- scope-kulcsot (§2.1).

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "project_key" TEXT NOT NULL DEFAULT '__general__';

-- AlterTable
ALTER TABLE "memory_versions" ADD COLUMN     "active_chunk_ids" JSONB,
ADD COLUMN     "change_set" JSONB,
ADD COLUMN     "project_key" TEXT,
ADD COLUMN     "source_candidate_ids" JSONB,
ADD COLUMN     "workstream_key" TEXT,
ALTER COLUMN "content" DROP NOT NULL;

-- AlterTable
ALTER TABLE "write_gate_tokens" ADD COLUMN     "memory_candidate_id" UUID,
ALTER COLUMN "training_ticket_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "memory_chunks" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_key" TEXT NOT NULL,
    "workstream_key" TEXT,
    "type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "text" TEXT NOT NULL,
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "salience" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" TEXT NOT NULL DEFAULT 'normal',
    "source_refs" JSONB,
    "evidence" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "review_after" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "supersedes" UUID,
    "superseded_by" UUID,
    "retrieved_count" INTEGER NOT NULL DEFAULT 0,
    "used_in_answer_count" INTEGER NOT NULL DEFAULT 0,
    "user_confirmed_helpful_count" INTEGER NOT NULL DEFAULT 0,
    "user_corrected_count" INTEGER NOT NULL DEFAULT 0,
    "last_retrieved_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "last_validated_at" TIMESTAMPTZ,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memory_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_candidates" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_key" TEXT NOT NULL,
    "workstream_key" TEXT,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposed_by" TEXT NOT NULL,
    "proposed_by_run_id" TEXT,
    "proposed_in_thread_id" TEXT,
    "ticket_id" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "write_gate_token_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memory_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_chunks_memory_id_project_key_workstream_key_status_idx" ON "memory_chunks"("memory_id", "project_key", "workstream_key", "status");

-- CreateIndex
CREATE INDEX "memory_chunks_memory_id_path_status_idx" ON "memory_chunks"("memory_id", "path", "status");

-- CreateIndex
CREATE INDEX "memory_chunks_tenant_id_agent_id_status_idx" ON "memory_chunks"("tenant_id", "agent_id", "status");

-- CreateIndex
CREATE INDEX "memory_candidates_memory_id_project_key_status_idx" ON "memory_candidates"("memory_id", "project_key", "status");

-- CreateIndex
CREATE INDEX "memory_candidates_agent_id_status_idx" ON "memory_candidates"("agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "write_gate_tokens_memory_candidate_id_key" ON "write_gate_tokens"("memory_candidate_id");

-- AddForeignKey
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_gate_tokens" ADD CONSTRAINT "write_gate_tokens_memory_candidate_id_fkey" FOREIGN KEY ("memory_candidate_id") REFERENCES "memory_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text (GIN) index a `memory_chunks`-on (spec §9.1). A Prisma nem tud
-- kifejezés-alapú tsvector GIN indexet létrehozni, ezért — a
-- `knowledge_chunks_fts_idx` (0002_kb_chunk_fts_index) mintájára — nyers
-- SQL-ként települ. A lekérdező oldalnak (`MemoryRetrievalService`, WP-2)
-- karakterre ugyanezt a `to_tsvector` kifejezést kell használnia, különben
-- az index nem használódik.
CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx ON memory_chunks
  USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || text));
