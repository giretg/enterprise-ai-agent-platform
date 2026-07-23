-- Telegram-csatorna: 1:1 agent-chat — bejövő forduló-sor tartalma (feature-spec #70/#73/#74, D8/D14).
--
-- A worker második munkatípusa (D8) egy tartós `channel_turns` sorból dolgozik. A forduló-nak
-- túl kell élnie a webhook-kérést és újrapróbálhatónak kell lennie, ezért a bejövő üzenet
-- SZÖVEGE a soron tárolódik (a nyers Telegram-üzenetet sehol máshol nem őrizzük). A `inbound_kind`
-- különíti el a feldolgozható szöveget a fájl/hang üzenettől (utóbbira a bot érthető
-- „még nem tudom kezelni" választ ad, agent-futás nélkül).

-- AlterTable: a bejövő üzenet tartalma és fajtája a forduló-soron.
ALTER TABLE "channel_turns" ADD COLUMN "inbound_text" TEXT;
ALTER TABLE "channel_turns" ADD COLUMN "inbound_kind" TEXT NOT NULL DEFAULT 'text';
