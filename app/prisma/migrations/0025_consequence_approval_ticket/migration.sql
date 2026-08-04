-- Task-only ticketeken is legyen következmény-kapu jóváhagyás (conversation nélkül).
ALTER TABLE "consequence_approvals" ALTER COLUMN "conversation_id" DROP NOT NULL;

-- Ticket FK + index a ticket-szálú listázáshoz.
CREATE INDEX IF NOT EXISTS "consequence_approvals_ticket_id_status_idx"
  ON "consequence_approvals"("ticket_id", "status");

ALTER TABLE "consequence_approvals"
  ADD CONSTRAINT "consequence_approvals_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
