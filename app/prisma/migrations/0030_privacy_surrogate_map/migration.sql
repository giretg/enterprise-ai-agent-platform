-- AI Privacy Gateway (spec §5–§6, D2) — perzisztens surrogate-leképezés.
-- A ref-osztály nem tárol nyers értéket; a val mezőket APG-19 tölti.

CREATE TYPE "surrogate_scope_type" AS ENUM ('conversation', 'trace');
CREATE TYPE "surrogate_class" AS ENUM ('ref', 'val');

CREATE TABLE "surrogate_map" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope_type" "surrogate_scope_type" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "surrogate" TEXT NOT NULL,
    "class" "surrogate_class" NOT NULL,
    "connector_id" UUID,
    "source_id" TEXT,
    "encrypted_value" TEXT,
    "hmac" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surrogate_map_pkey" PRIMARY KEY ("id")
);

-- Bijektivitás a scope-on belül: egy álnév egy entitáshoz, egy entitás egy álnévhez.
CREATE UNIQUE INDEX "surrogate_map_scope_surrogate_key"
  ON "surrogate_map"("tenant_id", "scope_type", "scope_id", "surrogate");
CREATE UNIQUE INDEX "surrogate_map_entity_identity_key"
  ON "surrogate_map"("tenant_id", "scope_type", "scope_id", "entity_type", "connector_id", "source_id");

-- Retention-járat: beszélgetés/trace törlésekor a scope szerint söpörhető.
CREATE INDEX "surrogate_map_scope_idx"
  ON "surrogate_map"("scope_type", "scope_id");

-- D2: ref-sor csak (connectorId, sourceId) hivatkozást tárol, értékmásolatot nem.
ALTER TABLE "surrogate_map"
  ADD CONSTRAINT "surrogate_map_ref_shape_check" CHECK (
    "class" <> 'ref'
    OR (
      "connector_id" IS NOT NULL
      AND "source_id" IS NOT NULL
      AND "encrypted_value" IS NULL
    )
  );

ALTER TABLE "surrogate_map"
  ADD CONSTRAINT "surrogate_map_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
