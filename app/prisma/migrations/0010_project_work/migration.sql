CREATE TYPE "MemoryWriteMode" AS ENUM ('approval', 'direct');
CREATE TYPE "ProjectMemoryKind" AS ENUM ('decision', 'open_task', 'finding', 'constraint', 'artifact', 'handoff_summary');
CREATE TYPE "ProjectMemoryStatus" AS ENUM ('active', 'superseded');

ALTER TABLE "agents" ADD COLUMN "memory_write_mode" "MemoryWriteMode" NOT NULL DEFAULT 'approval';

CREATE TABLE "work_projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "work_projects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_projects_tenant_id_key_key" ON "work_projects"("tenant_id", "key");
CREATE INDEX "work_projects_tenant_id_archived_at_idx" ON "work_projects"("tenant_id", "archived_at");

ALTER TABLE "work_projects" ADD CONSTRAINT "work_projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_projects" ADD CONSTRAINT "work_projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "work_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "last_writer_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "work_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_files_tenant_id_project_key_path_key" ON "work_files"("tenant_id", "project_key", "path");
CREATE INDEX "work_files_tenant_id_project_key_idx" ON "work_files"("tenant_id", "project_key");

ALTER TABLE "work_files" ADD CONSTRAINT "work_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_files" ADD CONSTRAINT "work_files_last_writer_user_id_fkey" FOREIGN KEY ("last_writer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "project_memory_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "project_key" TEXT NOT NULL,
    "kind" "ProjectMemoryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "artifact_path" TEXT,
    "with_user_id" UUID NOT NULL,
    "status" "ProjectMemoryStatus" NOT NULL DEFAULT 'active',
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_memory_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_memory_items_tenant_id_agent_id_project_key_status_idx" ON "project_memory_items"("tenant_id", "agent_id", "project_key", "status");
CREATE INDEX "project_memory_items_with_user_id_idx" ON "project_memory_items"("with_user_id");

ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_with_user_id_fkey" FOREIGN KEY ("with_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "project_memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
