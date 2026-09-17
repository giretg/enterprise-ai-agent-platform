-- #518 — kapacitásfoglalás ideje (sorban állás / indítás / futás külön mérhető).
ALTER TABLE "agent_turns" ADD COLUMN "launch_reserved_at" TIMESTAMPTZ;

-- A kapacitás-számlálás (futó + indításra lefoglalt) tenantonként — részleges
-- index, hogy a foglalás advisory lock alatt is gyors maradjon.
CREATE INDEX "agent_turns_capacity_idx"
  ON "agent_turns" ("tenant_id")
  WHERE "status" IN ('running', 'streaming') OR ("status" = 'queued' AND "launch_id" IS NOT NULL);
