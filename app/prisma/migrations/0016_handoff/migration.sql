CREATE TYPE "HandoffStatus" AS ENUM ('open', 'accepted', 'done', 'rejected');

CREATE TABLE "handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "from_agent_id" UUID NOT NULL,
  "from_definition_id" UUID NOT NULL,
  "to_agent_id" UUID,
  "to_user_id" UUID,
  "project_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "links" TEXT,
  "status" "HandoffStatus" NOT NULL DEFAULT 'open',
  "memory_id" UUID,
  "created_by_id" UUID NOT NULL,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "handoffs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "handoffs_tenant_id_to_agent_id_status_idx" ON "handoffs"("tenant_id", "to_agent_id", "status");
CREATE INDEX "handoffs_tenant_id_to_user_id_status_idx" ON "handoffs"("tenant_id", "to_user_id", "status");

ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_agent_id_fkey" FOREIGN KEY ("to_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
