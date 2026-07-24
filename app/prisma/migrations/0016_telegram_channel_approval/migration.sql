-- Telegram-csatorna: eseményvezérelt jóváhagyás gombokkal (feature-spec #70/#76, D5/D6/D14).
--
-- Amikor egy ticket `awaiting_human`-ba lép, a felelős / jóváhagyói kör jogosultság-tudatos
-- Telegram-gombokat kap. EGY sor = EGY címzettnek kiküldött gombüzenet. A sor hordozza a
-- KÖTÉST (ticket, kapu, címzett-identitás, kezdeményező, kért szerepkör) és a megengedett
-- döntéseket, hogy a koppintáskor a szerver élőben újra tudja ellenőrizni a jogosultságot, és
-- az EGYSZER-használatot atomian (a `status` `pending`→`decided` billentése) kikényszerítse.
-- A gomb-payload aláírása a kötött mezők felett képződik (l. channel-approval-token.ts); a nyers
-- külső azonosító SOHA nem kerül ide.

CREATE TABLE "channel_approval_prompts" (
    "id" UUID NOT NULL,
    "prompt_id" TEXT NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tenant_id" UUID,
    "gate_id" TEXT,
    "step_id" TEXT,
    "required_actor_role" TEXT,
    "recipient_identity_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "initiator_user_id" UUID,
    "allowed_actions" TEXT[],
    "external_thread_id" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_action" TEXT,
    "decided_by_lookup_hash" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_approval_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_approval_prompts_prompt_id_key" ON "channel_approval_prompts"("prompt_id");
CREATE INDEX "channel_approval_prompts_ticket_id_status_idx" ON "channel_approval_prompts"("ticket_id", "status");
CREATE INDEX "channel_approval_prompts_recipient_identity_id_idx" ON "channel_approval_prompts"("recipient_identity_id");
