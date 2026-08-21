-- APG-22: OBSERVE mód UI-előnézet perzisztencia.
-- A megfigyelt entitásértékek külön táblában élnek (nem surrogate_map), hogy
-- a chat újranyitásakor is kiemelhető legyen, mit tokenizáltunk volna — vault-sor
-- és preview-álnev ütközés nélkül.
CREATE TABLE "conversation_observe_entities" (
    "conversation_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "value_fingerprint" TEXT NOT NULL,
    "preview_ordinal" INTEGER NOT NULL,
    "display_value_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_observe_entities_pkey" PRIMARY KEY ("conversation_id","entity_type","value_fingerprint")
);

ALTER TABLE "conversation_observe_entities" ADD CONSTRAINT "conversation_observe_entities_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_observe_entities" ADD CONSTRAINT "conversation_observe_entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "conversation_observe_entities_tenant_id_idx" ON "conversation_observe_entities"("tenant_id");
