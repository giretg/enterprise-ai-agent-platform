-- Belépő (orkesztráló) skill jelölése az agent-skill kötésen (#653). Agentenként legfeljebb egy.
ALTER TABLE "agent_skills" ADD COLUMN IF NOT EXISTS "entry" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_one_entry_per_agent" ON "agent_skills"("agent_id") WHERE "entry";
