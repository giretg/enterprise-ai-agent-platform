-- Telegram-csatorna: üzemeltetés — metrikák + megőrzési takarítás (feature-spec #70/#78, D4).
--
-- Ez a záró slice a #70 MVP-hez: a csatorna forgalmi/hibametrikái az audit-láncból és a
-- csatorna-táblák állapotából olvashatók (nem kell új tábla hozzá), a bot pedig a megőrzési
-- horizonton takarítja a SAJÁT kimenő üzeneteit. Az utóbbihoz kell egyetlen új tábla: a bot
-- által küldött üzenetek `provider_message_id`-ját tartja nyilván (nyers tartalom NÉLKÜL),
-- hogy a takarító a Telegram `deleteMessage` (chat_id, message_id) párost meg tudja adni.
-- Privát chatben a bot CSAK a saját üzeneteit tudja törölni — ezért ez a tábla is csak
-- azokat tartja.

-- CreateTable: a bot saját kimenő üzeneteinek nyilvántartása a megőrzési takarításhoz.
CREATE TABLE "channel_outbound_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "kind" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "channel_outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a takarító a régi, még nem takarított sorokat kéri le (purged_at IS NULL, sent_at szerint).
CREATE INDEX "channel_outbound_messages_purged_at_sent_at_idx" ON "channel_outbound_messages"("purged_at", "sent_at");

-- CreateIndex
CREATE INDEX "channel_outbound_messages_session_id_idx" ON "channel_outbound_messages"("session_id");

-- AddForeignKey
ALTER TABLE "channel_outbound_messages" ADD CONSTRAINT "channel_outbound_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "channel_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
