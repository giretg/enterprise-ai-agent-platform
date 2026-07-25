-- Hot-path indexes: dashboard aggregations, KB document lists, tool-call lookups.
-- These tables were growing without supporting indexes for the common filters.

CREATE INDEX IF NOT EXISTS "documents_connector_id_status_idx"
  ON "documents"("connector_id", "status");

CREATE INDEX IF NOT EXISTS "model_calls_created_at_idx"
  ON "model_calls"("created_at");

CREATE INDEX IF NOT EXISTS "model_calls_agent_id_created_at_idx"
  ON "model_calls"("agent_id", "created_at");

CREATE INDEX IF NOT EXISTS "model_calls_ticket_id_idx"
  ON "model_calls"("ticket_id");

CREATE INDEX IF NOT EXISTS "model_calls_conversation_id_idx"
  ON "model_calls"("conversation_id");

CREATE INDEX IF NOT EXISTS "tool_calls_created_at_idx"
  ON "tool_calls"("created_at");

CREATE INDEX IF NOT EXISTS "tool_calls_agent_id_created_at_idx"
  ON "tool_calls"("agent_id", "created_at");

CREATE INDEX IF NOT EXISTS "tool_calls_ticket_id_idx"
  ON "tool_calls"("ticket_id");

CREATE INDEX IF NOT EXISTS "tool_calls_conversation_id_idx"
  ON "tool_calls"("conversation_id");
