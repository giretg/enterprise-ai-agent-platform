-- Skill-fajta: tenant | published | system. A catalogScope marad a tenant-határ;
-- a kind mondja meg, milyen katalógus-elem a skill, és melyik agent-osztályhoz
-- rendelhető. Meglévő globális sorok kiadottá válnak (nem név-alapú backfill).

CREATE TYPE "SkillKind" AS ENUM ('tenant', 'published', 'system');

ALTER TABLE "skills"
  ADD COLUMN "kind" "SkillKind" NOT NULL DEFAULT 'tenant',
  ADD COLUMN "required_system_role" "agent_system_role";

UPDATE "skills"
  SET "kind" = 'published'
  WHERE "tenant_id" IS NULL;
