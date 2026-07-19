-- Ticket kooperatív emergency stop (Aktív futások UI Fázis 3).
ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cancel_requested_by" UUID,
  ADD COLUMN IF NOT EXISTS "cancel_requested_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "tickets_cancel_requested_idx"
  ON "tickets" ("cancel_requested")
  WHERE "cancel_requested" = true AND "state" = 'in_progress';
