-- #1004 D8: a platform-chat worker szűk DB-szerepe. A séma tulajdonosa (neondb_owner) futtatja,
-- a `clients/platform-chat` migrációja UTÁN. A jelszót a Secret Managerből add meg:
--   psql "$OWNER_URL" -v worker_password="'…'" -f ops/platform-chat/db-role.sql
-- A szerep CSAK a platform_chat sémát éri el; a public séma (platform-adatok) tiltott.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_chat_worker') THEN
    CREATE ROLE platform_chat_worker LOGIN;
  END IF;
END
$$;
ALTER ROLE platform_chat_worker WITH LOGIN PASSWORD :worker_password;
ALTER ROLE platform_chat_worker SET search_path = platform_chat;

REVOKE ALL ON SCHEMA public FROM platform_chat_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_chat_worker;

GRANT USAGE ON SCHEMA platform_chat TO platform_chat_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform_chat TO platform_chat_worker;
REVOKE INSERT, UPDATE, DELETE ON platform_chat.schema_migrations FROM platform_chat_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_chat GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_chat_worker;
