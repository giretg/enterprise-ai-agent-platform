-- Önfrissítő connector (Dev-Spec — Self-Updating-Connector) · WP-0
--
-- Egy connector attól lesz "önfrissítő", hogy kap egy spec-forrást (link) és a
-- futásidejű képességeit a rögzített (approved) spec-verzió capabilitySet-je adja
-- (A3), nem a statikus config.endpoints. A migráció TISZTÁN ADDITÍV:
--   * a meglévő connectorok `connector_mode = 'fixed'` maradnak (viselkedés változatlan),
--   * a titok SOSEM kerül DB-be (A6) — a spec-forrás csak a linket tartja.

-- CreateEnum
CREATE TYPE "connector_mode" AS ENUM ('fixed', 'self_updating');

-- CreateEnum
CREATE TYPE "connector_spec_version_status" AS ENUM ('proposed', 'approved', 'superseded', 'rejected', 'rolled_back');

-- AlterTable: a connector módja + az aktív (rögzített) spec-verzió mutatója.
ALTER TABLE "connectors"
  ADD COLUMN "connector_mode" "connector_mode" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "active_spec_version_id" UUID;

-- CreateTable: spec-forrás (jóváhagyott, oda-szögezett link). 1:1 a connectorral.
CREATE TABLE "connector_spec_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
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

-- CreateTable: append-only verziózott spec-pillanatkép (bizonyíték + capabilitySet + diff).
CREATE TABLE "connector_spec_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
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

-- AddForeignKey: az aktív spec-verzió mutató (a verzió törlésekor SET NULL — a connector él tovább).
ALTER TABLE "connectors"
  ADD CONSTRAINT "connectors_active_spec_version_id_fkey"
  FOREIGN KEY ("active_spec_version_id") REFERENCES "connector_spec_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_spec_sources"
  ADD CONSTRAINT "connector_spec_sources_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_spec_versions"
  ADD CONSTRAINT "connector_spec_versions_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A verzió tartalma append-only: az állapot/approval mezők mozoghatnak az állapotgépben,
-- de a bizonyíték, hash, diff és capability-set utólag nem írható át.
CREATE OR REPLACE FUNCTION prevent_connector_spec_version_content_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.connector_id IS DISTINCT FROM OLD.connector_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.raw_snapshot IS DISTINCT FROM OLD.raw_snapshot
     OR NEW.raw_hash IS DISTINCT FROM OLD.raw_hash
     OR NEW.capability_set IS DISTINCT FROM OLD.capability_set
     OR NEW.diff_from_version_id IS DISTINCT FROM OLD.diff_from_version_id
     OR NEW.diff_summary IS DISTINCT FROM OLD.diff_summary
     OR NEW.fetched_at IS DISTINCT FROM OLD.fetched_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'connector spec version content is append-only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connector_spec_versions_immutable_content
BEFORE UPDATE ON "connector_spec_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_connector_spec_version_content_update();
