CREATE TABLE "ticket_attachments" (
  "id" UUID NOT NULL,
  "ticket_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "filename" TEXT NOT NULL,
  "mime_type" TEXT,
  "byte_size" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_attachments_ticket_id_seq_key"
  ON "ticket_attachments"("ticket_id", "seq");
CREATE UNIQUE INDEX "ticket_attachments_ticket_id_document_id_key"
  ON "ticket_attachments"("ticket_id", "document_id");
CREATE INDEX "ticket_attachments_document_id_idx"
  ON "ticket_attachments"("document_id");

ALTER TABLE "ticket_attachments"
  ADD CONSTRAINT "ticket_attachments_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_attachments"
  ADD CONSTRAINT "ticket_attachments_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A már létrejött chat-promóciós ticketek dokumentumhivatkozásait is láthatóvá
-- tesszük. Ezek régi bináris dokumentumai lehetnek csak szövegkinyeretek; a
-- letöltési route ezt felismeri, és őszinte `.txt` néven szolgálja ki.
INSERT INTO "ticket_attachments" (
  "id", "ticket_id", "document_id", "seq", "filename", "mime_type", "byte_size"
)
SELECT
  gen_random_uuid(),
  t."id",
  d."id",
  item.ordinality::integer,
  d."filename",
  d."mime_type",
  CASE
    WHEN jsonb_typeof(d."metadata" -> 'byteSize') = 'number'
      THEN (d."metadata" ->> 'byteSize')::integer
    ELSE NULL
  END
FROM "tickets" t
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(t."payload" -> 'attachmentDocumentIds') = 'array'
      THEN t."payload" -> 'attachmentDocumentIds'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS item(document_id, ordinality)
JOIN "documents" d ON d."id"::text = item.document_id
ON CONFLICT ("ticket_id", "document_id") DO NOTHING;

UPDATE "tickets" t
SET "source_document_id" = first_attachment."document_id"
FROM (
  SELECT DISTINCT ON ("ticket_id") "ticket_id", "document_id"
  FROM "ticket_attachments"
  ORDER BY "ticket_id", "seq" ASC
) first_attachment
WHERE t."id" = first_attachment."ticket_id"
  AND t."source_document_id" IS NULL;
