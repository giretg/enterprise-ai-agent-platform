ALTER TABLE "inbound_mail_events" ADD COLUMN "run_started_at" TIMESTAMPTZ;
UPDATE "inbound_mail_events" SET "run_started_at" = "created_at" WHERE "action" = 'process';
CREATE INDEX "inbound_mail_events_agent_id_run_started_at_idx" ON "inbound_mail_events"("agent_id", "run_started_at");
