ALTER TYPE "KnowledgeProcessingMode" ADD VALUE IF NOT EXISTS 'wiki';

CREATE TABLE "document_source_files" (
  "document_id" UUID PRIMARY KEY REFERENCES "documents"("id") ON DELETE CASCADE,
  "data" BYTEA NOT NULL
);
