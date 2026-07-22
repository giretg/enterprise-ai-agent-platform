-- issue #97 — Bizalmi jelölés minden eszköz-eredményen.
-- Dedikált, indexelt `trust_class` oszlop a ToolCall rekordon, hogy utólag gyorsan
-- megválaszolható legyen: „mely futásokat befolyásolt külső, nem megbízható tartalom?".
-- Meglévő rekordokra nullázható (a mező a bevezetés utáni hívásokra töltődik).

-- CreateEnum
CREATE TYPE "TrustClass" AS ENUM ('trusted', 'internal', 'external_untrusted');

-- AlterTable
ALTER TABLE "tool_calls" ADD COLUMN "trust_class" "TrustClass";

-- CreateIndex (audit-lekérdezés: bizalmi osztály + időablak)
CREATE INDEX "tool_calls_trust_class_created_at_idx" ON "tool_calls" ("trust_class", "created_at");
