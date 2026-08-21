-- issue #237 — „melyik forduló hívta ezt az eszközt?"
--
-- A hatékonysági tanácsadó futás-szinten elemez. A `model_calls` sor a #180 WP-2
-- óta ismeri a fordulót (`agent_turn_id`); a `tool_calls` csak a beszélgetést /
-- ticketet. Chat-ágon emiatt az eszközhívásokat csak időbélyeg-illesztéssel
-- lehetett volna a fordulóhoz rendelni — pontosan az a törékenység, amit a
-- modellhívásnál már megszüntettünk.
--
-- `agent_turn_id` — melyik forduló hívta (nullable: ticket/task úton nincs
--                   forduló-rekord, meglévő sorokon NULL marad; nincs backfill).
--
-- ON DELETE SET NULL: a forduló törlése NEM viheti magával a hívás-sort — a
-- hatékonysági kártya durvább (beszélgetés-szintű) bontással akkor is elemezhető.

ALTER TABLE "tool_calls" ADD COLUMN "agent_turn_id" UUID;

ALTER TABLE "tool_calls"
  ADD CONSTRAINT "tool_calls_agent_turn_id_fkey"
  FOREIGN KEY ("agent_turn_id") REFERENCES "agent_turns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tool_calls_agent_turn_id_idx" ON "tool_calls" ("agent_turn_id");
