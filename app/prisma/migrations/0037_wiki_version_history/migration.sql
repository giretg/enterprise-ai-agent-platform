-- #978 Wiki-előzmények: wiki-szintű sorszám (időutazás), visszavonás-hivatkozás,
-- teljes revízió-állapot, címkék, agent olvasási cursor, megőrzés és GDPR-törlés.
-- Meglévő sorok: minden új oszlop NULL-ozható vagy defaulttal jön; a backfill a
-- fájl végén fut (sorszám az alkalmazás sorrendjében, revízió-állapot az oldalról).

-- AlterTable
ALTER TABLE "agent_wikis" ADD COLUMN     "next_seq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "retention_delete_days" INTEGER DEFAULT 365,
ADD COLUMN     "retention_full_days" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "wiki_change_sets" ADD COLUMN     "page_summary" JSONB,
ADD COLUMN     "pages_pruned_at" TIMESTAMPTZ,
ADD COLUMN     "reverted_by_id" UUID,
ADD COLUMN     "reverts_id" UUID,
ADD COLUMN     "seq" INTEGER;

-- AlterTable
ALTER TABLE "wiki_page_revisions" ADD COLUMN     "category" TEXT,
ADD COLUMN     "created_by_agent_id" UUID,
ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "erased_at" TIMESTAMPTZ,
ADD COLUMN     "erasure_id" UUID,
ADD COLUMN     "path" TEXT,
ADD COLUMN     "source_refs" JSONB,
ADD COLUMN     "status" "WikiPageStatus",
ADD COLUMN     "type" "WikiPageType";

-- CreateTable
CREATE TABLE "wiki_tags" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "seq" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_read_cursors" (
    "wiki_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "seen_seq" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wiki_read_cursors_pkey" PRIMARY KEY ("wiki_id","agent_id","user_id")
);

-- CreateTable
CREATE TABLE "wiki_erasures" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "erased_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_erasures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wiki_tags_wiki_id_name_key" ON "wiki_tags"("wiki_id", "name");

-- CreateIndex
CREATE INDEX "wiki_erasures_wiki_id_created_at_idx" ON "wiki_erasures"("wiki_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wiki_change_sets_wiki_id_seq_key" ON "wiki_change_sets"("wiki_id", "seq");

-- CreateIndex
CREATE INDEX "wiki_page_revisions_page_id_created_at_idx" ON "wiki_page_revisions"("page_id", "created_at");

-- CreateIndex
CREATE INDEX "wiki_page_revisions_change_set_id_idx" ON "wiki_page_revisions"("change_set_id");

-- AddForeignKey
ALTER TABLE "wiki_tags" ADD CONSTRAINT "wiki_tags_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_read_cursors" ADD CONSTRAINT "wiki_read_cursors_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_erasures" ADD CONSTRAINT "wiki_erasures_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill (D6): az alkalmazott / visszavont change-setek az alkalmazás sorrendjében kapnak sorszámot.
UPDATE "wiki_change_sets" cs SET "seq" = ranked.n
FROM (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "wiki_id" ORDER BY COALESCE("applied_at", "created_at"), "created_at", "id"
  ) AS n
  FROM "wiki_change_sets"
  WHERE "status" IN ('applied', 'reverted')
) ranked
WHERE cs."id" = ranked."id";

UPDATE "agent_wikis" w SET "next_seq" = COALESCE(
  (SELECT MAX(cs."seq") FROM "wiki_change_sets" cs WHERE cs."wiki_id" = w."id"), 0
) + 1;

-- Backfill: a revíziók a lap mostani útvonalát / állapotát kapják (a régi áthelyezéseknél pontatlan,
-- a konzol ezt jelzi). A `type` NULL marad: ez jelöli a bevezetés előtti revíziót (a visszaállítás
-- ilyenkor a lap mostani típusát / kategóriáját használja). A szerző a change-setből jön.
UPDATE "wiki_page_revisions" r SET
  "path" = p."path",
  "status" = CASE WHEN p."status" = 'archived' AND r."version" = p."version" THEN 'archived'::"WikiPageStatus" ELSE 'published'::"WikiPageStatus" END,
  "source_refs" = CASE WHEN r."version" = p."version" THEN p."source_refs" ELSE NULL END
FROM "wiki_pages" p
WHERE r."page_id" = p."id";

UPDATE "wiki_page_revisions" r SET
  "created_by_agent_id" = cs."agent_id",
  "created_by_user_id" = cs."user_id"
FROM "wiki_change_sets" cs
WHERE r."change_set_id" = cs."id";
