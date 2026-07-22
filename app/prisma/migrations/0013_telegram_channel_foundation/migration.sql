-- Csatorna-réteg alapja (Telegram feature-spec #70/#71, D14).
--
-- Ez a slice CSAK az adatmodellt hozza: az öt csatorna-entitást (bot, identitás,
-- agent-engedély, munkamenet, forduló) és a beszélgetés csatorna-megjelölését.
-- A bejövő webhook, az összekötés és a futásidő későbbi ticketek — a cél, hogy
-- legyen mire épülniük. A hozzáférési kulcs és a webhook titkos fejléc SOHA nem
-- nyersen, csak titok-referenciaként (`access_key_secret_ref` / `webhook_secret_ref`)
-- tárolódik.

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('telegram');

-- CreateEnum
CREATE TYPE "ChannelBotStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "ChannelIdentityStatus" AS ENUM ('active', 'revoked', 'blocked');

-- CreateEnum
CREATE TYPE "ChannelTurnStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "channel" "ChannelType",
ADD COLUMN     "channel_external_id" TEXT;

-- CreateTable
CREATE TABLE "channel_bots" (
    "id" UUID NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "access_key_secret_ref" TEXT NOT NULL,
    "webhook_secret_ref" TEXT NOT NULL,
    "status" "ChannelBotStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" UUID NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "external_user_id_enc" TEXT NOT NULL,
    "lookup_hash" TEXT NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "status" "ChannelIdentityStatus" NOT NULL DEFAULT 'active',
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_agent_grants" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "project_key" TEXT NOT NULL DEFAULT '__general__',
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_agent_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sessions" (
    "id" UUID NOT NULL,
    "bot_id" UUID NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "identity_id" UUID,
    "active_agent_id" UUID,
    "update_watermark" BIGINT,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_turns" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "inbound_ref" TEXT,
    "status" "ChannelTurnStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_bots_channel_type_status_idx" ON "channel_bots"("channel_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_bots_channel_type_tenant_id_key" ON "channel_bots"("channel_type", "tenant_id");

-- CreateIndex
CREATE INDEX "channel_identities_user_id_status_idx" ON "channel_identities"("user_id", "status");

-- CreateIndex
CREATE INDEX "channel_identities_tenant_id_status_idx" ON "channel_identities"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_channel_type_lookup_hash_key" ON "channel_identities"("channel_type", "lookup_hash");

-- CreateIndex
CREATE INDEX "channel_agent_grants_agent_id_idx" ON "channel_agent_grants"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_agent_grants_identity_id_agent_id_key" ON "channel_agent_grants"("identity_id", "agent_id");

-- CreateIndex
CREATE INDEX "channel_sessions_identity_id_idx" ON "channel_sessions"("identity_id");

-- CreateIndex
CREATE INDEX "channel_sessions_last_activity_at_idx" ON "channel_sessions"("last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_sessions_bot_id_external_thread_id_key" ON "channel_sessions"("bot_id", "external_thread_id");

-- CreateIndex
CREATE INDEX "channel_turns_session_id_status_idx" ON "channel_turns"("session_id", "status");

-- CreateIndex
CREATE INDEX "channel_turns_status_created_at_idx" ON "channel_turns"("status", "created_at");

-- CreateIndex
CREATE INDEX "conversations_channel_channel_external_id_idx" ON "conversations"("channel", "channel_external_id");

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_agent_grants" ADD CONSTRAINT "channel_agent_grants_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "channel_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_agent_grants" ADD CONSTRAINT "channel_agent_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "channel_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "channel_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_turns" ADD CONSTRAINT "channel_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "channel_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Egyetlen platform-szintű bot csatorna-típusonként (D3). A `channel_type` + `tenant_id`
-- egyedi index a NULL tenanteket külön értékként kezeli (Postgres-szemantika), ezért a
-- platform-bot (tenant_id IS NULL) egyediségét külön részleges egyedi index kényszeríti ki
-- — ugyanaz a minta, mint a 0009 aktív-forduló invariánsnál.
CREATE UNIQUE INDEX "channel_bots_platform_singleton_key"
  ON "channel_bots" ("channel_type")
  WHERE "tenant_id" IS NULL;
