-- #967 Mini appok MCP-n: agent által készített statikus HTML, verziók, agent-megosztás.
ALTER TABLE "agents" ADD COLUMN "mini_app_guide" TEXT NOT NULL DEFAULT '';

CREATE TYPE "MiniAppVisibility" AS ENUM ('private', 'agents', 'organization');
CREATE TYPE "MiniAppStatus" AS ENUM ('active', 'archived');

CREATE TABLE "mini_apps" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "owner_agent_id" UUID NOT NULL,
  "project_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "MiniAppStatus" NOT NULL DEFAULT 'active',
  "visibility" "MiniAppVisibility" NOT NULL DEFAULT 'private',
  "current_version" INTEGER NOT NULL,
  "copied_from_app_id" UUID,
  "copied_from_version" INTEGER,
  "create_idempotency_key" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "archived_at" TIMESTAMPTZ,
  CONSTRAINT "mini_apps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mini_app_versions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "app_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "html" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "lint_warnings" TEXT[],
  "change_note" TEXT,
  "idempotency_key" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mini_app_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mini_app_shares" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "app_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "shared_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "mini_app_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mini_apps_tenant_id_owner_agent_id_create_idempotency_key_key" ON "mini_apps"("tenant_id", "owner_agent_id", "create_idempotency_key");
CREATE INDEX "mini_apps_tenant_id_owner_agent_id_status_idx" ON "mini_apps"("tenant_id", "owner_agent_id", "status");
CREATE INDEX "mini_apps_tenant_id_visibility_status_idx" ON "mini_apps"("tenant_id", "visibility", "status");
CREATE INDEX "mini_apps_status_archived_at_idx" ON "mini_apps"("status", "archived_at");
CREATE UNIQUE INDEX "mini_app_versions_app_id_version_key" ON "mini_app_versions"("app_id", "version");
CREATE UNIQUE INDEX "mini_app_versions_app_id_idempotency_key_key" ON "mini_app_versions"("app_id", "idempotency_key");
CREATE UNIQUE INDEX "mini_app_shares_app_id_agent_id_key" ON "mini_app_shares"("app_id", "agent_id");
CREATE INDEX "mini_app_shares_tenant_id_agent_id_revoked_at_idx" ON "mini_app_shares"("tenant_id", "agent_id", "revoked_at");

ALTER TABLE "mini_apps" ADD CONSTRAINT "mini_apps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mini_apps" ADD CONSTRAINT "mini_apps_owner_agent_id_fkey" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mini_app_versions" ADD CONSTRAINT "mini_app_versions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "mini_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mini_app_shares" ADD CONSTRAINT "mini_app_shares_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "mini_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mini_app_shares" ADD CONSTRAINT "mini_app_shares_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
