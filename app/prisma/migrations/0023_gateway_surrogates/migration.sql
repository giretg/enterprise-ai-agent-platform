CREATE TABLE "gateway_surrogates" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "scope_type" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "surrogate" TEXT NOT NULL,
  "hmac" TEXT NOT NULL,
  "encrypted_value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gateway_surrogates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gateway_surrogates_scope_fingerprint_key"
  ON "gateway_surrogates"("tenant_id", "scope_type", "scope_id", "entity_type", "fingerprint");

CREATE UNIQUE INDEX "gateway_surrogates_scope_surrogate_key"
  ON "gateway_surrogates"("tenant_id", "scope_type", "scope_id", "surrogate");

CREATE INDEX "gateway_surrogates_created_at_idx" ON "gateway_surrogates"("created_at");

ALTER TABLE "gateway_surrogates"
  ADD CONSTRAINT "gateway_surrogates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
