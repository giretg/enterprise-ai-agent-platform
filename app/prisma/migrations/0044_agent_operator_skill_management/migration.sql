-- Agent-szintű delegálás: az operátor kezelheti-e az agenthez rendelt skilleket.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "operator_can_manage_skills" BOOLEAN NOT NULL DEFAULT false;
