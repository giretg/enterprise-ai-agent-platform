CREATE TABLE "client_installs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "install_id" TEXT NOT NULL,
  "last_heartbeat_at" TIMESTAMPTZ NOT NULL,
  "config_hash" TEXT NOT NULL,
  "managed_dir_hash" TEXT NOT NULL,
  "policy_version" TEXT NOT NULL,
  "guard_version" TEXT NOT NULL,
  "hermes_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "client_installs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_installs_tenant_id_user_id_install_id_key"
  ON "client_installs"("tenant_id", "user_id", "install_id");

ALTER TABLE "client_installs"
  ADD CONSTRAINT "client_installs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "client_install_sessions" (
  "id" UUID NOT NULL,
  "client_install_id" UUID NOT NULL,
  "session_id" TEXT NOT NULL,
  "agent_id" UUID NOT NULL,
  "last_seen_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "client_install_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_install_sessions_client_install_id_session_id_agent__key"
  ON "client_install_sessions"("client_install_id", "session_id", "agent_id");

ALTER TABLE "client_install_sessions"
  ADD CONSTRAINT "client_install_sessions_client_install_id_fkey"
  FOREIGN KEY ("client_install_id") REFERENCES "client_installs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
