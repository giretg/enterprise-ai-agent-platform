-- Tenant-szintű munka-konténer (projekt). A `key` a memória/conversation
-- `projectKey` értéke. Az Általános (`__general__`) gyűjtő implicit, nincs sor.

CREATE TABLE "work_projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_projects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_projects_tenant_id_key_key" ON "work_projects"("tenant_id", "key");
CREATE INDEX "work_projects_tenant_id_idx" ON "work_projects"("tenant_id");
