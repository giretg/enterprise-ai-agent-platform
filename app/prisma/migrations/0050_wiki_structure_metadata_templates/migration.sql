-- #1061 F3: metaadat-mezők (állapot, gazda, átnézés, egyedi mezők) és nézetek; F4: kategória-oldalsablon.
-- Csak hozzáad: új oszlopok NULL / üres alapértékkel, a funkció wikinként kapcsolható (alapból ki).

-- CreateEnum
CREATE TYPE "WikiDocStatus" AS ENUM ('draft', 'approved');

-- CreateEnum
CREATE TYPE "WikiFieldType" AS ENUM ('text', 'select', 'multi_select', 'date');

-- CreateEnum
CREATE TYPE "WikiSectionRule" AS ENUM ('warn', 'error');

-- AlterTable
ALTER TABLE "agent_wikis" ADD COLUMN     "managed_fields" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "wiki_categories" ADD COLUMN     "required_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "required_sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "review_cycle_days" INTEGER,
ADD COLUMN     "section_rule" "WikiSectionRule" NOT NULL DEFAULT 'warn',
ADD COLUMN     "template_md" TEXT;

-- AlterTable
ALTER TABLE "wiki_page_revisions" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "wiki_pages" ADD COLUMN     "doc_status" "WikiDocStatus",
ADD COLUMN     "owner_role" TEXT,
ADD COLUMN     "owner_user_id" UUID,
ADD COLUMN     "review_cycle_days" INTEGER,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ,
ADD COLUMN     "reviewed_by_user_id" UUID;

-- CreateTable
CREATE TABLE "wiki_fields" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WikiFieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "help" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wiki_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wiki_fields_wiki_id_key_key" ON "wiki_fields"("wiki_id", "key");

-- CreateIndex
CREATE INDEX "wiki_pages_connector_id_doc_status_idx" ON "wiki_pages"("connector_id", "doc_status");

-- CreateIndex
CREATE INDEX "wiki_pages_connector_id_owner_user_id_idx" ON "wiki_pages"("connector_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "wiki_pages_frontmatter_idx" ON "wiki_pages" USING GIN ("frontmatter" jsonb_path_ops);

-- AddForeignKey
ALTER TABLE "wiki_fields" ADD CONSTRAINT "wiki_fields_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
