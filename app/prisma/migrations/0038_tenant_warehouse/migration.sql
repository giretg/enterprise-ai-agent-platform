-- #984 AI-adattárház: cég ↔ adattárház nyilvántartás (a tenant-séma maga
-- futásidőben, a WarehouseProvisioner-rel jön létre, nem Prisma-migrációval).

-- CreateTable
CREATE TABLE "tenant_warehouses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "provisioner" TEXT NOT NULL,
    "schema_name" TEXT NOT NULL,
    "internal_version" INTEGER,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by" UUID,
    "ready_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_warehouses_tenant_id_key" ON "tenant_warehouses"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_warehouses" ADD CONSTRAINT "tenant_warehouses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
