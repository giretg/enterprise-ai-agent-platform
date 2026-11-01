-- #1029 az agent saját e-mail címe: elsődleges postafiók (egy postafiók legfeljebb egy agenté), aláírás, megjelenő név.
-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "primary_mailbox_connector_id" UUID,
ADD COLUMN     "primary_mailbox_address" TEXT,
ADD COLUMN     "mail_signature" TEXT,
ADD COLUMN     "mail_display_name" TEXT;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_primary_mailbox_connector_id_fkey" FOREIGN KEY ("primary_mailbox_connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Kizárólagosság: egy postafiók legfeljebb egy agent saját címe.
CREATE UNIQUE INDEX "agents_primary_mailbox_connector_id_key" ON "agents"("primary_mailbox_connector_id") WHERE "primary_mailbox_connector_id" IS NOT NULL;
