-- #1032 bejövő levél esemény: agentenkénti szabály, fejléc-szintű esemény (tartalom nélkül), push-feliratkozás.
-- CreateEnum
CREATE TYPE "inbound_mail_mode" AS ENUM ('notify', 'process', 'handoff');

-- CreateEnum
CREATE TYPE "inbound_mail_event_status" AS ENUM ('new', 'claimed', 'processed', 'ignored', 'failed');

-- CreateTable
CREATE TABLE "agent_inbound_mail_rules" (
    "agent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" "inbound_mail_mode" NOT NULL DEFAULT 'notify',
    "instructions" TEXT NOT NULL DEFAULT '',
    "responsible_user_id" UUID,
    "handoff_to_user_id" UUID,
    "handoff_to_agent_id" UUID,
    "sender_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daily_run_limit" INTEGER NOT NULL DEFAULT 20,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_inbound_mail_rules_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "inbound_mail_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "agent_id" UUID,
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "from_address" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "received_at" TIMESTAMPTZ NOT NULL,
    "status" "inbound_mail_event_status" NOT NULL DEFAULT 'new',
    "action" TEXT NOT NULL DEFAULT 'notify',
    "reason" TEXT,
    "processed_by" TEXT,
    "responsible_user_id" UUID,
    "conversation_id" UUID,
    "handoff_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'poll',
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inbound_mail_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_watch_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT,
    "cursor" TEXT,
    "expires_at" TIMESTAMPTZ,
    "last_polled_at" TIMESTAMPTZ,
    "last_event_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mail_watch_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_inbound_mail_rules_tenant_id_idx" ON "agent_inbound_mail_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "inbound_mail_events_tenant_id_agent_id_received_at_idx" ON "inbound_mail_events"("tenant_id", "agent_id", "received_at");

-- CreateIndex
CREATE INDEX "inbound_mail_events_tenant_id_responsible_user_id_status_idx" ON "inbound_mail_events"("tenant_id", "responsible_user_id", "status");

-- CreateIndex
CREATE INDEX "inbound_mail_events_status_updated_at_idx" ON "inbound_mail_events"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_mail_events_connector_id_message_id_key" ON "inbound_mail_events"("connector_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_watch_subscriptions_connector_id_key" ON "mail_watch_subscriptions"("connector_id");

-- CreateIndex
CREATE INDEX "mail_watch_subscriptions_provider_external_id_idx" ON "mail_watch_subscriptions"("provider", "external_id");

-- AddForeignKey
ALTER TABLE "agent_inbound_mail_rules" ADD CONSTRAINT "agent_inbound_mail_rules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inbound_mail_rules" ADD CONSTRAINT "agent_inbound_mail_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_mail_events" ADD CONSTRAINT "inbound_mail_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_mail_events" ADD CONSTRAINT "inbound_mail_events_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_mail_events" ADD CONSTRAINT "inbound_mail_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_watch_subscriptions" ADD CONSTRAINT "mail_watch_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_watch_subscriptions" ADD CONSTRAINT "mail_watch_subscriptions_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

