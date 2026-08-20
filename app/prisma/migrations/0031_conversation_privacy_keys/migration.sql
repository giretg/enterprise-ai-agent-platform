-- APG-18: per-conversation adatkulcs + val-surrogate crypto-shredding (spec §6).

CREATE TABLE "conversation_privacy_keys" (
    "conversation_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "wrapped_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_privacy_keys_pkey" PRIMARY KEY ("conversation_id")
);

CREATE INDEX "conversation_privacy_keys_tenant_id_idx"
  ON "conversation_privacy_keys"("tenant_id");

ALTER TABLE "conversation_privacy_keys"
  ADD CONSTRAINT "conversation_privacy_keys_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_privacy_keys"
  ADD CONSTRAINT "conversation_privacy_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- D2: val-sor titkosított értéket és fingerprint source_id-t tárol; ref-sor továbbra is tiltja.
ALTER TABLE "surrogate_map"
  ADD CONSTRAINT "surrogate_map_val_shape_check" CHECK (
    "class" <> 'val'
    OR (
      "connector_id" IS NULL
      AND "source_id" IS NOT NULL
      AND "encrypted_value" IS NOT NULL
    )
  );
