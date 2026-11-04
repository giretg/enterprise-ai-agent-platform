-- #1025: kérdés-kártya (`ask_user`) és munkaterv (`update_plan`).
-- Új forduló-állapot: `awaiting_input` (parkolt, mint a jóváhagyás — nincs futó feladat).
ALTER TABLE platform_chat.turns DROP CONSTRAINT IF EXISTS turns_status_check;
ALTER TABLE platform_chat.turns ADD CONSTRAINT turns_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE platform_chat.turns ADD COLUMN IF NOT EXISTS pending_input jsonb;
-- A válaszra várás ideje nem számít a forduló 40 perces korlátjába.
ALTER TABLE platform_chat.turns ADD COLUMN IF NOT EXISTS paused_seconds integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS platform_chat.turns_one_active_per_conversation;
CREATE UNIQUE INDEX turns_one_active_per_conversation
  ON platform_chat.turns (conversation_id) WHERE status IN ('queued', 'running', 'awaiting_approval', 'awaiting_input');

ALTER TABLE platform_chat.turn_events DROP CONSTRAINT IF EXISTS turn_events_type_check;
ALTER TABLE platform_chat.turn_events ADD CONSTRAINT turn_events_type_check
  CHECK (type IN ('delta', 'status', 'tool', 'approval', 'question', 'plan', 'done', 'error'));

-- A megválaszolt kérdés a kérdező üzeneten, a munkaterv a záró üzeneten (újranyitáskor is látszik).
ALTER TABLE platform_chat.messages ADD COLUMN IF NOT EXISTS question jsonb;
ALTER TABLE platform_chat.messages ADD COLUMN IF NOT EXISTS plan jsonb;
