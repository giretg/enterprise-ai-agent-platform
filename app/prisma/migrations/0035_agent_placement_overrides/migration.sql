-- Agentenként felülírható „hová mit ments” tábla.
ALTER TABLE "agents" ADD COLUMN "placement_overrides" JSONB;
