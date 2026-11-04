-- #1061 F2: „csak a kijelöltek” tudástár, névsor, kapcsolt wiki menüpont.

-- AlterEnum
ALTER TYPE "KnowledgeBaseVisibility" ADD VALUE 'members';

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "kb_member_user_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "wiki_categories" ADD COLUMN     "linked_connector_id" UUID;

-- AddForeignKey
ALTER TABLE "wiki_categories" ADD CONSTRAINT "wiki_categories_linked_connector_id_fkey" FOREIGN KEY ("linked_connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
