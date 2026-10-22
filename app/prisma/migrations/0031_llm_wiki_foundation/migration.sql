-- #942 LLM Wiki 1/6 (#941 §7): agent-wiki adatmodell, wiki-jog a kapcsolaton,
-- tálca-mezők a dokumentumon, privát tudásbázis (D13). Meglévő sorok változatlanok:
-- minden új oszlop NULL-ozható vagy a mai viselkedést adó defaulttal jön
-- (`wiki_access = read`, `wiki_write_mode = approval`, `visibility = shared`).

-- CreateEnum
CREATE TYPE "WikiPageStatus" AS ENUM ('published', 'pending_approval', 'archived');

-- CreateEnum
CREATE TYPE "WikiPageType" AS ENUM ('source', 'entity', 'concept', 'analysis', 'overview');

-- CreateEnum
CREATE TYPE "WikiLogOp" AS ENUM ('ingest', 'query', 'lint', 'note', 'schema', 'revert');

-- CreateEnum
CREATE TYPE "WikiAccess" AS ENUM ('none', 'read', 'submit', 'write');

-- CreateEnum
CREATE TYPE "WikiInboxStatus" AS ENUM ('pending', 'in_progress', 'processed', 'skipped');

-- CreateEnum
CREATE TYPE "WikiChangeSetStatus" AS ENUM ('pending', 'applied', 'rejected', 'reverted');

-- CreateEnum
CREATE TYPE "KnowledgeBaseVisibility" AS ENUM ('shared', 'private_to_user');

-- AlterEnum
ALTER TYPE "KnowledgeArtifactFormat" ADD VALUE 'llm_wiki';

-- AlterTable
ALTER TABLE "agent_connectors" ADD COLUMN     "wiki_access" "WikiAccess" NOT NULL DEFAULT 'read',
ADD COLUMN     "wiki_collect_focus" TEXT,
ADD COLUMN     "wiki_write_mode" "MemoryWriteMode" NOT NULL DEFAULT 'approval';

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "owner_user_id" UUID,
ADD COLUMN     "owner_missing_since" TIMESTAMPTZ,
ADD COLUMN     "visibility" "KnowledgeBaseVisibility" NOT NULL DEFAULT 'shared';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "wiki_batch_id" UUID,
ADD COLUMN     "wiki_batch_seq" INTEGER,
ADD COLUMN     "wiki_claim_expires_at" TIMESTAMPTZ,
ADD COLUMN     "wiki_claimed_by_agent_id" UUID,
ADD COLUMN     "wiki_processed_by_change_set_id" UUID,
ADD COLUMN     "wiki_status" "WikiInboxStatus",
ADD COLUMN     "wiki_submitted_by_agent_id" UUID;

-- CreateTable
CREATE TABLE "agent_wikis" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "schema_md" TEXT NOT NULL,
    "last_lint" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_wikis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_pages" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "type" "WikiPageType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" TEXT,
    "frontmatter" JSONB NOT NULL DEFAULT '{}',
    "body" TEXT NOT NULL,
    "source_refs" JSONB NOT NULL DEFAULT '[]',
    "out_links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "WikiPageStatus" NOT NULL DEFAULT 'published',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content_hash" TEXT NOT NULL,
    "created_by_agent_id" UUID,
    "created_by_user_id" UUID,
    "updated_by_agent_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wiki_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_change_sets" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "agent_id" UUID,
    "user_id" UUID,
    "status" "WikiChangeSetStatus" NOT NULL DEFAULT 'pending',
    "pages" JSONB NOT NULL DEFAULT '[]',
    "validation" JSONB,
    "log_entry" JSONB,
    "source_document_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inbox_item_id" UUID,
    "gateway_operation_id" UUID,
    "approver_scope" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ,

    CONSTRAINT "wiki_change_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_page_revisions" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "change_set_id" UUID,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "frontmatter" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_page_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_log_entries" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "op" "WikiLogOp" NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "page_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "change_set_id" UUID,
    "actor_agent_id" UUID,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_wikis_connector_id_key" ON "agent_wikis"("connector_id");

-- CreateIndex
CREATE INDEX "wiki_pages_wiki_id_status_idx" ON "wiki_pages"("wiki_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wiki_pages_connector_id_path_key" ON "wiki_pages"("connector_id", "path");

-- CreateIndex
CREATE INDEX "wiki_change_sets_wiki_id_status_idx" ON "wiki_change_sets"("wiki_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wiki_page_revisions_page_id_version_key" ON "wiki_page_revisions"("page_id", "version");

-- CreateIndex
CREATE INDEX "wiki_log_entries_wiki_id_created_at_idx" ON "wiki_log_entries"("wiki_id", "created_at");

-- CreateIndex
CREATE INDEX "connectors_tenant_id_visibility_owner_user_id_idx" ON "connectors"("tenant_id", "visibility", "owner_user_id");

-- CreateIndex
CREATE INDEX "documents_connector_id_wiki_status_idx" ON "documents"("connector_id", "wiki_status");

-- CreateIndex
CREATE INDEX "documents_connector_id_content_hash_idx" ON "documents"("connector_id", "content_hash");

-- AddForeignKey
ALTER TABLE "agent_wikis" ADD CONSTRAINT "agent_wikis_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_change_sets" ADD CONSTRAINT "wiki_change_sets_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_change_sets" ADD CONSTRAINT "wiki_change_sets_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_change_set_id_fkey" FOREIGN KEY ("change_set_id") REFERENCES "wiki_change_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_log_entries" ADD CONSTRAINT "wiki_log_entries_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- D13 invariáns DB-szinten: privát csak knowledge_base lehet, és van tulajdonosa.
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_private_kb_owner_check"
  CHECK ("visibility" = 'shared' OR ("type" = 'knowledge_base' AND "owner_user_id" IS NOT NULL));
