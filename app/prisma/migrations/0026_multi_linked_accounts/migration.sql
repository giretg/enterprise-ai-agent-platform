-- Allow several Gmail/Drive grants per user (personal vs work). Unique
-- identity is the live Google account email, plus an optional nickname.
ALTER TABLE "connector_grants" ADD COLUMN "nickname" TEXT;

DROP INDEX IF EXISTS "connector_grants_tenant_id_connector_id_user_id_key";

CREATE INDEX "connector_grants_tenant_id_connector_id_user_id_status_idx"
  ON "connector_grants"("tenant_id", "connector_id", "user_id", "status");

CREATE UNIQUE INDEX "connector_grants_active_account_key"
  ON "connector_grants" ("tenant_id", "connector_id", "user_id", lower("account_label"))
  WHERE status = 'active' AND account_label IS NOT NULL;

CREATE UNIQUE INDEX "connector_grants_active_nickname_key"
  ON "connector_grants" ("tenant_id", "connector_id", "user_id", lower("nickname"))
  WHERE status = 'active' AND nickname IS NOT NULL;
