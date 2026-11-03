-- #1075: agent által javasolt wiki-beállítás. Csak hozzáad: alapból kikapcsolt, a meglévő wikik változatlanok.

-- CreateEnum
CREATE TYPE "WikiConfigProposalStatus" AS ENUM ('pending', 'applied', 'rejected', 'withdrawn');

-- AlterTable
ALTER TABLE "agent_wikis" ADD COLUMN     "agent_config_changes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "collect_focus" TEXT;

-- AlterTable
ALTER TABLE "wiki_categories" ADD COLUMN     "template_key" TEXT;

-- CreateTable
CREATE TABLE "wiki_config_proposals" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "WikiConfigProposalStatus" NOT NULL DEFAULT 'pending',
    "base_config_version" TEXT NOT NULL,
    "operations" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_comment" TEXT,
    "decision_reason" TEXT,
    "change_set_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_config_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_config_proposals_wiki_id_status_created_at_idx" ON "wiki_config_proposals"("wiki_id", "status", "created_at");

-- Agentenként és wikinként egy nyitott javaslat (párhuzamos beküldésnél is).
CREATE UNIQUE INDEX "wiki_config_proposals_one_pending_per_agent" ON "wiki_config_proposals"("wiki_id", "agent_id") WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "wiki_config_proposals" ADD CONSTRAINT "wiki_config_proposals_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
