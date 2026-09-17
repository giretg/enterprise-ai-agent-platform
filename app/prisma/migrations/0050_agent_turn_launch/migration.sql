-- #517 — tartós chat-forduló indítási kísérlet (attempt-korreláció + retry).
ALTER TABLE "agent_turns" ADD COLUMN "launch_id" UUID;
ALTER TABLE "agent_turns" ADD COLUMN "launch_attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_turns" ADD COLUMN "launch_next_retry_at" TIMESTAMPTZ;
ALTER TABLE "agent_turns" ADD COLUMN "launch_provider_ref" TEXT;

CREATE INDEX "agent_turns_status_launch_next_retry_at_idx" ON "agent_turns"("status", "launch_next_retry_at");
