-- #1028 tenant-szintű postafiók: a grant gazdája lehet a tenant is (nem egy ember).
-- CreateEnum
CREATE TYPE "ConnectorGrantOwnerType" AS ENUM ('user', 'tenant');

-- AlterTable
ALTER TABLE "connector_grants" ADD COLUMN "owner_type" "ConnectorGrantOwnerType" NOT NULL DEFAULT 'user';
ALTER TABLE "connector_grants" ALTER COLUMN "user_id" DROP NOT NULL;

-- Tenant-grantnek nincs userje; user-grantnek kötelező.
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_owner_user_check"
  CHECK (("owner_type" = 'user' AND "user_id" IS NOT NULL) OR ("owner_type" = 'tenant' AND "user_id" IS NULL));

-- Egy aktív tenant-postafiók címenként és konnektoronként.
CREATE UNIQUE INDEX "connector_grants_active_tenant_account_key"
  ON "connector_grants" ("tenant_id", "connector_id", lower("account_label"))
  WHERE "status" = 'active' AND "owner_type" = 'tenant';
