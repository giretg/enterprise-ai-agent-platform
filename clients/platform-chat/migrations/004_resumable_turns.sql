-- A keretelfogyás parkolt forduló, a kész lépések megmaradnak.
ALTER TABLE platform_chat.turns DROP CONSTRAINT IF EXISTS turns_status_check;
ALTER TABLE platform_chat.turns ADD CONSTRAINT turns_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'paused', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE platform_chat.turns ADD COLUMN IF NOT EXISTS pause jsonb;
ALTER TABLE platform_chat.turns ADD COLUMN IF NOT EXISTS run_limits jsonb;
DROP INDEX IF EXISTS platform_chat.turns_one_active_per_conversation;
CREATE UNIQUE INDEX turns_one_active_per_conversation
  ON platform_chat.turns (conversation_id) WHERE status IN ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'paused');
ALTER TABLE platform_chat.turn_events DROP CONSTRAINT IF EXISTS turn_events_type_check;
ALTER TABLE platform_chat.turn_events ADD CONSTRAINT turn_events_type_check
  CHECK (type IN ('delta', 'status', 'tool', 'approval', 'question', 'plan', 'pause', 'done', 'error'));
