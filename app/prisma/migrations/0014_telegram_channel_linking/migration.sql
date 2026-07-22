-- Telegram-csatorna: összekötés és visszavonás (feature-spec #70/#72, D12).
--
-- Ez a slice a webes „Telegram összekötése" gombot, az aláírt, rövid élettartamú,
-- egyszer felhasználható deep-link tokent, a bejövő webhook összekötő ágát, a profil-
-- nézetet és a visszavonást (saját + admin) hozza. Új tábla a token (single-use), a
-- platform-oldali felhasználói értesítés, és a `channel_sessions` egy bélyege a
-- bekötetlen „egyszer válaszol, aztán csend" viselkedéshez.

-- AlterTable: a bekötetlen semleges válasz „egyszer" bélyege (D12).
ALTER TABLE "channel_sessions" ADD COLUMN "unlinked_notice_at" TIMESTAMPTZ;

-- CreateTable: egyszer-használatos, aláírt deep-link összekötő token.
CREATE TABLE "channel_link_tokens" (
    "id" UUID NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "jti" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "consumed_by_lookup_hash" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable: platform-oldali felhasználói értesítés (összekötés tényéről).
CREATE TABLE "user_notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_link_tokens_jti_key" ON "channel_link_tokens"("jti");

-- CreateIndex
CREATE INDEX "channel_link_tokens_user_id_idx" ON "channel_link_tokens"("user_id");

-- CreateIndex
CREATE INDEX "channel_link_tokens_expires_at_idx" ON "channel_link_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "user_notifications_user_id_read_at_idx" ON "user_notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "user_notifications_user_id_created_at_idx" ON "user_notifications"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
