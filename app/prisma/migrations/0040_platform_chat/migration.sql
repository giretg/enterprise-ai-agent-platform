-- #1004 platform-chat: agent-kapcsoló, szerveroldali install-fajta, napi modell-keret számláló.
-- A beszélgetések NEM itt vannak: a worker saját `platform_chat` sémája (clients/platform-chat/migrations).
ALTER TABLE "agents" ADD COLUMN "platform_chat_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "client_installs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'hermes';

CREATE TABLE "platform_chat_daily_usage" (
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "platform_chat_daily_usage_pkey" PRIMARY KEY ("tenant_id","day")
);

ALTER TABLE "platform_chat_daily_usage" ADD CONSTRAINT "platform_chat_daily_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
