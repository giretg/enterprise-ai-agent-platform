-- Ticket → Megbeszélés (#219): conversation köthető forrás-tickethez.
ALTER TABLE "conversations"
  ADD COLUMN "continued_from_ticket_id" UUID;

CREATE INDEX "conversations_continued_from_ticket_id_idx"
  ON "conversations"("continued_from_ticket_id");

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_continued_from_ticket_id_fkey"
    FOREIGN KEY ("continued_from_ticket_id") REFERENCES "tickets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
