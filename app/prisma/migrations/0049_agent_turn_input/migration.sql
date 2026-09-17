-- #516 — tartós, verziózott forduló-bemenet (chat-turn-input.ts).
ALTER TABLE "agent_turns" ADD COLUMN "input" JSONB;
