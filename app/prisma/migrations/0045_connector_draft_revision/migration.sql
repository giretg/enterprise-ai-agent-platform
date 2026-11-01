-- A provisioning activation compare-and-set tokenje. Az időbélyeg nem elég erős
-- konkurencia-token: egyazon időtickben két gate-módosítás azonos updated_at-ot
-- kaphat. A revision minden gate/config-változáskor atomikusan növekszik.
ALTER TABLE "connector_drafts"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
