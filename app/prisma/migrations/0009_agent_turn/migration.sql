-- Perzisztált chat-agent-forduló (chat-agent-turn-resilience-spec.md §4, D1/D7/D8).
--
-- Ma a chat-forduló futásállapota egy in-memory Map-ben él; semmilyen kívülálló
-- (másik instance, watchdog, admin) nem tudja megmondani, mi történik éppen egy
-- beszélgetéssel. Ez a tábla teszi a fordulót első osztályú, lekérdezhető
-- entitássá: haladás (részszöveg + aktivitások), elszámolók, cancel-jelzés, és a
-- Tier-2 futtatáshoz szükséges tulajdonlás-mezők (lock_token + heartbeat) a
-- `tickets` dispatcher-konvenciója szerint.

-- CreateEnum
CREATE TYPE "AgentTurnStatus" AS ENUM ('queued', 'running', 'streaming', 'completed', 'exhausted', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "agent_turns" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tenant_id" UUID,
    "agent_id" UUID NOT NULL,
    "agent_version" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "status" "AgentTurnStatus" NOT NULL DEFAULT 'queued',
    "user_message_id" UUID NOT NULL,
    "assistant_message_id" UUID,
    "partial_text" TEXT NOT NULL DEFAULT '',
    "activities" JSONB NOT NULL DEFAULT '[]',
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "denied_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancel_requested_by" UUID,
    "cancel_requested_at" TIMESTAMPTZ,
    "lock_token" TEXT,
    "locked_at" TIMESTAMPTZ,
    "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "reason" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_turns_conversation_id_status_idx" ON "agent_turns"("conversation_id", "status");

-- CreateIndex (watchdog: stale heartbeat keresés státusz szerint)
CREATE INDEX "agent_turns_status_heartbeat_at_idx" ON "agent_turns"("status", "heartbeat_at");

-- AddForeignKey
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Aktív-forduló invariáns (D7): egy beszélgetéshez egyszerre legfeljebb EGY
-- aktív (queued|running|streaming) forduló tartozhat. Részleges egyedi index —
-- a Prisma-séma ezt nem tudja kifejezni, ezért kézzel írt SQL (mint a
-- 0001 audit-trigger és a 0002 FTS-index esetében).
CREATE UNIQUE INDEX "agent_turns_active_per_conversation_key"
  ON "agent_turns" ("conversation_id")
  WHERE "status" IN ('queued', 'running', 'streaming');
