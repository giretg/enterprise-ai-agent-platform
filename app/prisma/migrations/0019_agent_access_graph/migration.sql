-- Agent-hozzáférési gráf (Access-Policy §agent-scope, issue #142).
--
-- A gráf az ad-hoc user→agent és agent→agent elérési utakat szabályozza két
-- FÜGGETLEN igével: `view` (a subject megtudhatja, hogy a cél létezik) és `address`
-- (chatet indíthat, ticketet címezhet, delegációt kezdeményezhet). Egyik sem
-- implikálja a másikat.
--
-- Kompatibilitási alapérték (C4): mindkét restriction-kapcsoló `false`, tehát a
-- meglévő tenantok viselkedése VÁLTOZATLAN — nincs élgenerálás, nincs backfill.

-- CreateEnum
CREATE TYPE "agent_access_subject_type" AS ENUM ('user', 'agent');

-- AlterTable: az agent-csomópont két kapcsolója.
-- `inbound_restricted`: a cél FELÉ tartó kapcsolat csak explicit granttal engedett.
-- `outbound_restricted`: az agentBŐL induló agent→agent kapcsolat csak granttal engedett.
-- A usernek NINCS outbound kapcsolója: user→agent esetén kizárólag a cél
-- `inbound_restricted` dönti el, kell-e grant.
ALTER TABLE "agents"
  ADD COLUMN "inbound_restricted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "outbound_restricted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "agent_access_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" "agent_access_subject_type" NOT NULL,
    "subject_user_id" UUID,
    "subject_agent_id" UUID,
    "target_agent_id" UUID NOT NULL,
    "can_view" BOOLEAN NOT NULL DEFAULT false,
    "can_address" BOOLEAN NOT NULL DEFAULT false,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_access_grants_pkey" PRIMARY KEY ("id")
);

-- A subject-diszkrimináns és a két FK egymást kizáró kitöltése: `user` alanynál a
-- user-oszlop kötelező és az agent-oszlop NULL, `agent` alanynál fordítva. Így egy
-- sor sosem hordozhat kétféle alanyt, és a policy-mag egyértelműen tud dönteni.
ALTER TABLE "agent_access_grants"
  ADD CONSTRAINT "agent_access_grants_subject_shape_check" CHECK (
    ("subject_type" = 'user'  AND "subject_user_id" IS NOT NULL AND "subject_agent_id" IS NULL)
    OR
    ("subject_type" = 'agent' AND "subject_agent_id" IS NOT NULL AND "subject_user_id" IS NULL)
  );

-- Legalább az egyik ige igaz: a "mindkettő hamis" sor nem policy, hanem szemét.
-- Az admin UI-ban mindkét sáv levétele a SOR TÖRLÉSÉT jelenti, nem false/false-t.
ALTER TABLE "agent_access_grants"
  ADD CONSTRAINT "agent_access_grants_verb_present_check" CHECK (
    "can_view" OR "can_address"
  );

-- Self-edge nem szükséges és nem hozható létre: egy agent önmagát mindig eléri, a
-- gráfban egy A→A él csak félreérthető policy-adat lenne.
ALTER TABLE "agent_access_grants"
  ADD CONSTRAINT "agent_access_grants_no_self_edge_check" CHECK (
    "subject_agent_id" IS NULL OR "subject_agent_id" <> "target_agent_id"
  );

-- Egy subject→target párhoz legfeljebb egy sor: a két boolean EGY sorban hordozza
-- a két vizuális sávot (nem két külön él).
CREATE UNIQUE INDEX "agent_access_grants_tenant_id_subject_user_id_target_agent_id_key"
  ON "agent_access_grants"("tenant_id", "subject_user_id", "target_agent_id");

CREATE UNIQUE INDEX "agent_access_grants_tenant_id_subject_agent_id_target_agent_id_key"
  ON "agent_access_grants"("tenant_id", "subject_agent_id", "target_agent_id");

-- Döntési hot-path indexek: "ki érheti el ezt a célt" (inbound Focus-panel) és
-- "mit érhet el ez az agent" (kimenő él + elérhetőségi kúp bejárás).
CREATE INDEX "agent_access_grants_tenant_id_target_agent_id_idx"
  ON "agent_access_grants"("tenant_id", "target_agent_id");

CREATE INDEX "agent_access_grants_tenant_id_subject_agent_id_idx"
  ON "agent_access_grants"("tenant_id", "subject_agent_id");

-- AddForeignKey
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_subject_user_id_fkey"
  FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_subject_agent_id_fkey"
  FOREIGN KEY ("subject_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_target_agent_id_fkey"
  FOREIGN KEY ("target_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
