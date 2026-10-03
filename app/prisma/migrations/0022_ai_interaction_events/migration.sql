CREATE TABLE "ai_interaction_events" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "install_id" TEXT NOT NULL,
  "session_id" TEXT,
  "turn_id" TEXT,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "content" TEXT,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "policy_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "ai_interaction_events_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "ai_interaction_events_kind_check" CHECK ("kind" IN ('user_prompt', 'model_call', 'tool_call', 'final')),
  CONSTRAINT "ai_interaction_events_source_check" CHECK ("source" IN ('gateway', 'guard'))
);

CREATE INDEX "ai_interaction_events_tenant_id_session_id_idx" ON "ai_interaction_events"("tenant_id", "session_id");
CREATE INDEX "ai_interaction_events_tenant_id_user_id_created_at_idx" ON "ai_interaction_events"("tenant_id", "user_id", "created_at");

ALTER TABLE "ai_interaction_events"
  ADD CONSTRAINT "ai_interaction_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
