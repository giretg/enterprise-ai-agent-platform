CREATE TYPE "CustomerPromiseStatus" AS ENUM ('open', 'claimed', 'fulfilled', 'cancelled', 'missed');
CREATE TABLE "customer_promises" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "commitment" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_email" TEXT,
    "customer_ref" TEXT,
    "channel" TEXT,
    "due_at" TIMESTAMPTZ NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "CustomerPromiseStatus" NOT NULL DEFAULT 'open',
    "claimed_at" TIMESTAMPTZ,
    "claim_client" TEXT,
    "claim_external_id" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "resolved_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "customer_promises_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_promises_tenant_id_owner_user_id_status_due_at_idx" ON "customer_promises"("tenant_id", "owner_user_id", "status", "due_at");
CREATE INDEX "customer_promises_tenant_id_agent_id_status_due_at_idx" ON "customer_promises"("tenant_id", "agent_id", "status", "due_at");
ALTER TABLE "customer_promises" ADD CONSTRAINT "customer_promises_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_promises" ADD CONSTRAINT "customer_promises_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_promises" ADD CONSTRAINT "customer_promises_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
