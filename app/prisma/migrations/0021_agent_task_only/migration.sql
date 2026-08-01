-- Feladatkör-korlátozás (#199): az agent felületén nincs chat, csak egyetlen
-- skill-kötött feladat-indító gomb.
--
-- Ez UI-egyszerűsítés, NEM jogosultsági korlát: az agent képességei változatlanok,
-- és a nem-emberi belépési pontok (agent_ask, csatorna-integrációk, agent API-kulcs,
-- ticket-kommentek) nyitva maradnak. Backfill nincs — minden meglévő agent a mai,
-- korlátozás nélküli viselkedést tartja meg.

ALTER TABLE "agents"
  ADD COLUMN "task_only" BOOLEAN NOT NULL DEFAULT false;
