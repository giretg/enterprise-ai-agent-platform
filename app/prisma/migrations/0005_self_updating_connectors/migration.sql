-- CreateEnum
CREATE TYPE "connector_mode" AS ENUM ('fixed', 'self_updating');

-- CreateEnum
CREATE TYPE "connector_spec_version_status" AS ENUM ('proposed', 'approved', 'superseded', 'rejected', 'rolled_back');

-- AlterTable
ALTER TABLE "connectors"
  ADD COLUMN "connector_mode" "connector_mode" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "active_spec_version_id" UUID;

-- CreateTable
CREATE TABLE "connector_spec_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "spec_url" TEXT NOT NULL,
    "spec_format" TEXT NOT NULL DEFAULT 'openapi_3',
    "url_approved_by" UUID,
    "url_approved_at" TIMESTAMPTZ,
    "trusted_by" UUID,
    "trusted_at" TIMESTAMPTZ,
    "auto_approve_policy" JSONB,
    "last_synced_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connector_spec_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_spec_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "raw_snapshot" JSONB NOT NULL,
    "raw_hash" TEXT NOT NULL,
    "capability_set" JSONB NOT NULL,
    "status" "connector_spec_version_status" NOT NULL DEFAULT 'proposed',
    "diff_from_version_id" UUID,
    "diff_summary" JSONB,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_spec_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_spec_sources_connector_id_key" ON "connector_spec_sources"("connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_spec_versions_connector_id_version_no_key" ON "connector_spec_versions"("connector_id", "version_no");

-- CreateIndex
CREATE INDEX "connector_spec_versions_connector_id_status_idx" ON "connector_spec_versions"("connector_id", "status");

-- AddForeignKey
ALTER TABLE "connector_spec_sources" ADD CONSTRAINT "connector_spec_sources_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_spec_versions" ADD CONSTRAINT "connector_spec_versions_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_active_spec_version_id_fkey" FOREIGN KEY ("active_spec_version_id") REFERENCES "connector_spec_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
