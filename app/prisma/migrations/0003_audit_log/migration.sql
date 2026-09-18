-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('human', 'agent', 'system');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "agent_version" INTEGER,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "model_used" TEXT,
    "input_ref" TEXT,
    "output_ref" TEXT,
    "policy_decision" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only enforcement for audit_log (AuditLog-Observability feature-spec §2/2, §4).
--
-- The table owner implicitly holds every privilege, so a plain REVOKE UPDATE/DELETE
-- would not constrain it. Enforcement is a BEFORE UPDATE/DELETE trigger that fires
-- for EVERY role (owner included) until someone explicitly runs ALTER TABLE ...
-- DISABLE TRIGGER. `prisma db push` cannot represent this rule; CI migrate deploy
-- must install it. Mirrors scripts/apply-audit-append-only-trigger.ts.

CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not allowed (row id=%)', TG_OP, OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_deny_mutation();
