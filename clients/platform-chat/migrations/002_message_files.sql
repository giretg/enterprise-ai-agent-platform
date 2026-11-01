-- #1024: a munkatárs válaszához tartozó letölthető fájlok (fájl-kártya: név, méret, link, lejárat).
ALTER TABLE platform_chat.messages ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]';
