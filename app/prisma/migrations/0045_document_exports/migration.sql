-- #1024 letölthető fájlok (XLSX, CSV, DOCX, PDF, MD): ideiglenes tároló, 7 napos lejárat, kérőhöz kötött letöltés.
-- CreateTable
CREATE TABLE "document_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "definition_id" UUID,
    "file_name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "client" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "document_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_exports_tenant_id_user_id_idx" ON "document_exports"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "document_exports_expires_at_idx" ON "document_exports"("expires_at");

-- AddForeignKey
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
