-- #830 Self-service cégindítás: opcionális adószám + self-service jelölés a cég-limithez.
ALTER TABLE "tenants" ADD COLUMN "tax_id" TEXT;
ALTER TABLE "tenants" ADD COLUMN "self_service" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tenants_created_by_self_service_idx" ON "tenants"("created_by", "self_service");
