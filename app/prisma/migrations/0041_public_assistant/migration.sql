-- #1016 nyilvános ügyfélszolgálati asszisztens: agent-típus, nyilvános KB-jelölés, profil (draft/publikált),
-- látogatói beszélgetések (30 napos megőrzés), megválaszolatlan-kérdés jelzések, külön napi modell-keret.
-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('internal', 'public');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "kind" "AgentKind" NOT NULL DEFAULT 'internal';

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "public_kb" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public_assistants" (
    "agent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "published" JSONB,
    "published_at" TIMESTAMPTZ,
    "published_by" UUID,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "last_loaded_domain" TEXT,
    "last_loaded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "public_assistants_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "public_chat_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "context" JSONB,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "handoff" TEXT NOT NULL DEFAULT 'none',
    "handoff_contact" TEXT,
    "handoff_summary" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_chat_signals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "group_label" TEXT,
    "answer_draft" TEXT,
    "answered_at" TIMESTAMPTZ,
    "dismissed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_chat_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_chat_daily_usage" (
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "public_chat_daily_usage_pkey" PRIMARY KEY ("tenant_id","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_assistants_slug_key" ON "public_assistants"("slug");

-- CreateIndex
CREATE INDEX "public_assistants_tenant_id_idx" ON "public_assistants"("tenant_id");

-- CreateIndex
CREATE INDEX "public_chat_sessions_tenant_id_agent_id_last_activity_at_idx" ON "public_chat_sessions"("tenant_id", "agent_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "public_chat_sessions_agent_id_visitor_id_idx" ON "public_chat_sessions"("agent_id", "visitor_id");

-- CreateIndex
CREATE INDEX "public_chat_sessions_ip_hash_created_at_idx" ON "public_chat_sessions"("ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "public_chat_sessions_created_at_idx" ON "public_chat_sessions"("created_at");

-- CreateIndex
CREATE INDEX "public_chat_signals_tenant_id_agent_id_created_at_idx" ON "public_chat_signals"("tenant_id", "agent_id", "created_at");

-- AddForeignKey
ALTER TABLE "public_assistants" ADD CONSTRAINT "public_assistants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_assistants" ADD CONSTRAINT "public_assistants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_chat_sessions" ADD CONSTRAINT "public_chat_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_chat_sessions" ADD CONSTRAINT "public_chat_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public_assistants"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_chat_signals" ADD CONSTRAINT "public_chat_signals_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_chat_daily_usage" ADD CONSTRAINT "public_chat_daily_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

