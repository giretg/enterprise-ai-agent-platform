-- CreateEnum
CREATE TYPE "FeatureFlagMode" AS ENUM ('off', 'selected', 'all');

-- CreateEnum
CREATE TYPE "FeatureFlagTenantAccess" AS ENUM ('included', 'excluded');

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "mode" "FeatureFlagMode" NOT NULL DEFAULT 'off',
    "version" INTEGER NOT NULL DEFAULT 1,
    "full_rollout_at" TIMESTAMPTZ,
    "remove_by" TIMESTAMPTZ,
    "stopped_at" TIMESTAMPTZ,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flag_tenants" (
    "flag_key" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "access" "FeatureFlagTenantAccess" NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "feature_flag_tenants_pkey" PRIMARY KEY ("flag_key","tenant_id")
);

-- CreateIndex
CREATE INDEX "feature_flag_tenants_tenant_id_idx" ON "feature_flag_tenants"("tenant_id");

-- AddForeignKey
ALTER TABLE "feature_flag_tenants" ADD CONSTRAINT "feature_flag_tenants_flag_key_fkey" FOREIGN KEY ("flag_key") REFERENCES "feature_flags"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_tenants" ADD CONSTRAINT "feature_flag_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

