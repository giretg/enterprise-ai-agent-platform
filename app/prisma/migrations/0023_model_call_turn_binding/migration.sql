-- issue #180 WP-2 — „mennyibe került ez a forduló, és fogott-e a cache?"
--
-- A mért, elszaladt futásnál (2026-07-29) a per-forduló token-költséget csak
-- időbélyeg-illesztéssel lehetett szétszedni: a `model_calls` sor a beszélgetést
-- ismerte, a fordulót nem. A prompt-cache hatása pedig sehol nem volt tárolva —
-- a gateway csak metrikába és naplóba tette —, így utólag nem lehetett igazolni,
-- hogy a cache egyáltalán fogott-e.
--
-- `agent_turn_id`        — melyik forduló költötte el (nullable: ticket/task úton
--                          nincs forduló-rekord, meglévő sorokon NULL marad).
-- `cached_prompt_tokens` — a cache-ből, töredék áron kiszolgált prompt-tokenek
--                          (NULL = a provider nem ad cache-telemetriát).
--
-- Ezután egyetlen lekérdezés megadja a per-forduló költséget és a cache-találatot:
--   select agent_turn_id, sum(prompt_tokens), sum(cached_prompt_tokens)
--     from model_calls group by 1;

-- AlterTable
ALTER TABLE "model_calls" ADD COLUMN "agent_turn_id" UUID;
ALTER TABLE "model_calls" ADD COLUMN "cached_prompt_tokens" INTEGER;

-- AddForeignKey
-- ON DELETE SET NULL: a forduló-rekord törlése (beszélgetés-törlés kaszkádja) NEM
-- viheti magával a költség-sort — a számla akkor is a tenanté, ha a chat már nincs meg.
ALTER TABLE "model_calls"
  ADD CONSTRAINT "model_calls_agent_turn_id_fkey"
  FOREIGN KEY ("agent_turn_id") REFERENCES "agent_turns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "model_calls_agent_turn_id_idx" ON "model_calls" ("agent_turn_id");
