-- AlterEnum
ALTER TYPE "ConnectorType" ADD VALUE 'knowledge_base';

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('uploaded', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "KnowledgeProcessingMode" AS ENUM ('raw_text_only', 'okf');

-- CreateEnum
CREATE TYPE "KnowledgeArtifactStatus" AS ENUM ('pending_review', 'published', 'failed');

-- CreateEnum
CREATE TYPE "KnowledgeArtifactFormat" AS ENUM ('okf');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "storage_ref" TEXT,
    "extracted_text" TEXT,
    "mime_type" TEXT,
    "content_hash" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'uploaded',
    "processing_mode" "KnowledgeProcessingMode",
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "connector_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_artifacts" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "source_document_id" UUID,
    "created_by_agent_id" UUID,
    "status" "KnowledgeArtifactStatus" NOT NULL DEFAULT 'pending_review',
    "format" "KnowledgeArtifactFormat" NOT NULL DEFAULT 'okf',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content_hash" TEXT NOT NULL,
    "bundle" JSONB NOT NULL DEFAULT '{}',
    "validation_result" JSONB,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "section" TEXT,
    "chunk_index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "source_ref" JSONB,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_tenant_id_connector_id_idx" ON "documents"("tenant_id", "connector_id");

-- CreateIndex
CREATE INDEX "knowledge_artifacts_connector_id_status_idx" ON "knowledge_artifacts"("connector_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_chunks_connector_id_idx" ON "knowledge_chunks"("connector_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_artifact_id_path_idx" ON "knowledge_chunks"("artifact_id", "path");

-- CreateIndex
CREATE INDEX "knowledge_chunks_fts_idx" ON "knowledge_chunks" USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || text));

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_artifacts" ADD CONSTRAINT "knowledge_artifacts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_artifacts" ADD CONSTRAINT "knowledge_artifacts_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "knowledge_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
