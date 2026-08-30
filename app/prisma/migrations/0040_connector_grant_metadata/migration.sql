-- issue #378 — Google Drive Picker manifest + app-created file tracking
ALTER TABLE "connector_grants" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
