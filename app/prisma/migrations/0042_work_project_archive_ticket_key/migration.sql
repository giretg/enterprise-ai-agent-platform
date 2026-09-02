-- Projekt archiválás + ticket-szintű projektkulcs.

ALTER TABLE "work_projects" ADD COLUMN "archived_at" TIMESTAMPTZ;
CREATE INDEX "work_projects_tenant_id_archived_at_idx" ON "work_projects"("tenant_id", "archived_at");

ALTER TABLE "tickets" ADD COLUMN "project_key" TEXT NOT NULL DEFAULT '__general__';
CREATE INDEX "tickets_tenant_id_project_key_idx" ON "tickets"("tenant_id", "project_key");
