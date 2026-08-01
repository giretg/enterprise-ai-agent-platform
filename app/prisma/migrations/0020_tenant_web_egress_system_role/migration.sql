-- Web-Egress rendszer-szerep: a név UI-adat, nem biztonsági principal.
--
-- A korábbi materializáció `name = 'Web-Egress Worker'` alapján választott. Egy
-- tenant-admin azonban normál agentnek is adhat ilyen nevet, ezért a név nem lehet
-- a webes egress trust boundary-ja. A rendszer-szerep explicit és tenantonként
-- egyedi. Szándékosan NINCS név-alapú backfill: a már létező azonos nevű agentet
-- nem emeljük automatikusan privilegizált rendszer-szereppé. A következő idempotens
-- materializáció biztonságos, jelölt példányt hoz létre.

CREATE TYPE "agent_system_role" AS ENUM ('web_egress');

ALTER TABLE "agents"
  ADD COLUMN "system_role" "agent_system_role";

CREATE UNIQUE INDEX "agents_tenant_id_system_role_key"
  ON "agents"("tenant_id", "system_role");
