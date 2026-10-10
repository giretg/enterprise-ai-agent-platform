CREATE TABLE "client_machine_floors" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "install_id" TEXT NOT NULL,
  "managed_dir_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "client_machine_floors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_machine_floors_tenant_id_user_id_key"
  ON "client_machine_floors"("tenant_id", "user_id");

ALTER TABLE "client_machine_floors"
  ADD CONSTRAINT "client_machine_floors_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
