-- #1032: a platform által indított beszélgetés (bejövő levél feldolgozása) eredete és az admin
-- feldolgozási utasítása. Az utasítás a system promptba kerül; a böngésző-út nem állíthatja be.
ALTER TABLE platform_chat.conversations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'user';
ALTER TABLE platform_chat.conversations ADD COLUMN IF NOT EXISTS instructions text;
