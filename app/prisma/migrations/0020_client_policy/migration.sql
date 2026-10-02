CREATE TABLE "client_policies" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "scope_id" UUID NOT NULL,
  "preset" TEXT,
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "tool_overrides" JSONB NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "client_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_policies_scope_check" CHECK ("scope" IN ('tenant', 'user', 'agent'))
);

CREATE UNIQUE INDEX "client_policies_tenant_id_scope_scope_id_key"
  ON "client_policies"("tenant_id", "scope", "scope_id");

ALTER TABLE "client_policies"
  ADD CONSTRAINT "client_policies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
