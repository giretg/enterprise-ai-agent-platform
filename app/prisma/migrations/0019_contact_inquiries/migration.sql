CREATE TYPE "contact_inquiry_status" AS ENUM ('new', 'reviewed');

CREATE TABLE "contact_inquiries" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" "contact_inquiry_status" NOT NULL DEFAULT 'new',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMPTZ,
  "reviewed_by_id" UUID,

  CONSTRAINT "contact_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contact_inquiries_status_created_at_idx"
  ON "contact_inquiries"("status", "created_at");

ALTER TABLE "contact_inquiries"
  ADD CONSTRAINT "contact_inquiries_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
