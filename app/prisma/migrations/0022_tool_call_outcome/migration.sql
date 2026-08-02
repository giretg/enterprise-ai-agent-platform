-- issue #195 — Tool-szerződés keményítés: a néma eszköz-hibák megszüntetése.
--
-- A `ToolCall` rekord eddig csak azt tudta, hogy a hívás lefutott-e (status), azt
-- nem, hogy TERMELT-E BÁRMIT. Emiatt a „sikeresen semmit nem csinált" eset (üres
-- Excel, 0 párosítás, 0 csere) megkülönböztethetetlen volt a valódi sikertől.
--
-- `outcome`        — a kikényszerített kimeneti szerződés ítélete hívásonként.
-- `effect_summary` — a MÉRT mellékhatás (mennyiség + egység + cél); a puszta
--                    „ok: true" állítás önmagában nem elfogadható kimenet.
--
-- Meglévő rekordokon mindkettő NULL (a mezők a bevezetés utáni hívásokra töltődnek).

-- CreateEnum
CREATE TYPE "ToolOutcome" AS ENUM ('ok', 'empty', 'partial', 'failed');

-- AlterTable
ALTER TABLE "tool_calls" ADD COLUMN "outcome" "ToolOutcome";
ALTER TABLE "tool_calls" ADD COLUMN "effect_summary" JSONB;

-- CreateIndex (admin-nézet: melyik eszköz ad a leggyakrabban empty/partial/failed eredményt)
CREATE INDEX "tool_calls_outcome_tool_name_created_at_idx" ON "tool_calls" ("outcome", "tool_name", "created_at");
