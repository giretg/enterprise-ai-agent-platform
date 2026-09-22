-- Gyártó skill jelölő: tenantonként egy. A név nem azonosítja.
ALTER TABLE "skills" ADD COLUMN "produces_skills" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "skills_one_producer_per_tenant"
  ON "skills" ("tenant_id")
  WHERE "produces_skills" = true AND "tenant_id" IS NOT NULL;

CREATE TYPE "conversation_skill_proposal_status" AS ENUM ('open', 'rejected', 'approved');

CREATE TABLE "conversation_skill_proposals" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "requested_by" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "requires" JSONB NOT NULL,
  "attachments" JSONB,
  "status" "conversation_skill_proposal_status" NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "decided_at" TIMESTAMPTZ,
  "decided_by" UUID,
  "skill_id" UUID,
  CONSTRAINT "conversation_skill_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_skill_proposals_tenant_id_status_idx"
  ON "conversation_skill_proposals" ("tenant_id", "status");

CREATE INDEX "conversation_skill_proposals_agent_id_requested_by_status_idx"
  ON "conversation_skill_proposals" ("agent_id", "requested_by", "status");

-- Egy user és egy agent mellett egy nyitott javaslat.
CREATE UNIQUE INDEX "conversation_skill_proposals_one_open"
  ON "conversation_skill_proposals" ("requested_by", "agent_id")
  WHERE "status" = 'open';

-- Nyitott javaslat neve tenanton belül egy. Az elutasított sor nem foglal.
CREATE UNIQUE INDEX "conversation_skill_proposals_open_name"
  ON "conversation_skill_proposals" ("tenant_id", lower("name"))
  WHERE "status" = 'open';

ALTER TABLE "conversation_skill_proposals"
  ADD CONSTRAINT "conversation_skill_proposals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_proposals"
  ADD CONSTRAINT "conversation_skill_proposals_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_proposals"
  ADD CONSTRAINT "conversation_skill_proposals_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_proposals"
  ADD CONSTRAINT "conversation_skill_proposals_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_proposals"
  ADD CONSTRAINT "conversation_skill_proposals_skill_id_fkey"
  FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
