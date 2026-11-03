-- CreateEnum
CREATE TYPE "WikiCategoryApproval" AS ENUM ('inherit', 'always');

-- AlterTable
ALTER TABLE "agent_wikis" ADD COLUMN     "managed_categories" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "wiki_categories" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "approval" "WikiCategoryApproval" NOT NULL DEFAULT 'inherit',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wiki_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_categories_wiki_id_parent_id_idx" ON "wiki_categories"("wiki_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "wiki_categories_wiki_id_key_key" ON "wiki_categories"("wiki_id", "key");

-- CreateIndex
CREATE INDEX "wiki_pages_out_links_idx" ON "wiki_pages" USING GIN ("out_links");

-- AddForeignKey
ALTER TABLE "wiki_categories" ADD CONSTRAINT "wiki_categories_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_categories" ADD CONSTRAINT "wiki_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "wiki_categories"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

