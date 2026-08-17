-- Level-2 skill-mellékletek (több-fájlos SKILL.md csomag import).
-- A `SKILL.md` mellett érkező SZÖVEGES referencia-fájlok (references/*.md, adat-táblák)
-- tárolása a verzióhoz kötve. Futtatható kód ide nem kerül: a csomag-importáló a
-- kód-fájlokat kihagyja, mert a platform nem futtat skill-kódot (Fázis 1 elv).
-- NULL = nincs melléklet (a mező bevezetése előtti verziók viselkedése változatlan).

ALTER TABLE "skill_versions"
  ADD COLUMN "attachments" JSONB;
