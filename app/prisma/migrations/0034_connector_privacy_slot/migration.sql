-- issue #320 WP-2: tenanton belüli monoton forrás-sorszám (S1, S2, …) a connector soron.

ALTER TABLE "connectors" ADD COLUMN "privacy_slot" INTEGER;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "tenant_id"
      ORDER BY "created_at" ASC, id ASC
    ) AS slot
  FROM "connectors"
)
UPDATE "connectors" AS c
SET "privacy_slot" = ranked.slot
FROM ranked
WHERE c.id = ranked.id;

ALTER TABLE "connectors" ALTER COLUMN "privacy_slot" SET NOT NULL;

CREATE UNIQUE INDEX "connectors_tenant_privacy_slot_key"
  ON "connectors" ("tenant_id", "privacy_slot");
