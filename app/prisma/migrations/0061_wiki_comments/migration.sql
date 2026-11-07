-- CreateEnum
CREATE TYPE "WikiCommentStatus" AS ENUM ('open', 'question', 'pending_approval', 'resolved', 'declined', 'withdrawn');

-- CreateEnum
CREATE TYPE "WikiCommentEventKind" AS ENUM ('reply', 'status');

-- CreateEnum
CREATE TYPE "WikiCommentActorKind" AS ENUM ('human', 'agent', 'system');

-- CreateTable
CREATE TABLE "wiki_comments" (
    "id" UUID NOT NULL,
    "wiki_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "page_version" INTEGER NOT NULL,
    "quote" TEXT,
    "body" TEXT NOT NULL,
    "status" "WikiCommentStatus" NOT NULL DEFAULT 'open',
    "author_user_id" UUID NOT NULL,
    "change_set_id" UUID,
    "closed_at" TIMESTAMPTZ,
    "author_seen_at" TIMESTAMPTZ,
    "erased_at" TIMESTAMPTZ,
    "erasure_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wiki_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_comment_events" (
    "id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "kind" "WikiCommentEventKind" NOT NULL,
    "from_status" "WikiCommentStatus",
    "to_status" "WikiCommentStatus",
    "actor_kind" "WikiCommentActorKind" NOT NULL,
    "actor_user_id" UUID,
    "actor_agent_id" UUID,
    "body" TEXT,
    "system_code" TEXT,
    "change_set_id" UUID,
    "erased_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_comment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_comments_connector_id_status_created_at_idx" ON "wiki_comments"("connector_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wiki_comments_page_id_status_idx" ON "wiki_comments"("page_id", "status");

-- CreateIndex
CREATE INDEX "wiki_comments_author_user_id_status_idx" ON "wiki_comments"("author_user_id", "status");

-- CreateIndex
CREATE INDEX "wiki_comments_change_set_id_idx" ON "wiki_comments"("change_set_id");

-- CreateIndex
CREATE INDEX "wiki_comment_events_comment_id_created_at_idx" ON "wiki_comment_events"("comment_id", "created_at");

-- AddForeignKey
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_wiki_id_fkey" FOREIGN KEY ("wiki_id") REFERENCES "agent_wikis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_change_set_id_fkey" FOREIGN KEY ("change_set_id") REFERENCES "wiki_change_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_comment_events" ADD CONSTRAINT "wiki_comment_events_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "wiki_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

