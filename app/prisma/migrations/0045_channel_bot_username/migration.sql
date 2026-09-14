-- Telegram platform-bot felhasználóneve (@ nélkül) a beüzemelő UI-ról.
-- Nem titok: a `t.me/<username>?start=…` mélylink alapja. Régi telepítésnél az env
-- (`TELEGRAM_BOT_USERNAME`) marad a fallback, ezért NULL-olható.
ALTER TABLE "channel_bots" ADD COLUMN IF NOT EXISTS "bot_username" TEXT;
