-- #1004 platform-chat — a worker saját sémája (D8). A migrációt a séma tulajdonosa futtatja
-- (`npm run migrate`, PLATFORM_CHAT_MIGRATE_URL); a worker futás közben a szűk
-- `platform_chat_worker` szereppel dolgozik, ami csak ezt a sémát éri el (ops/platform-chat/db-role.sql).
CREATE SCHEMA IF NOT EXISTS platform_chat;

CREATE TABLE IF NOT EXISTS platform_chat.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant-törléskor kaszkád. Az RI-ellenőrzés a tábla-tulajdonos jogával fut, így a worker
  -- szerepnek nem kell olvasnia a public sémát.
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  tenant_slug text NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_name text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  title_set_by_user boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  title_search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED
);
CREATE INDEX IF NOT EXISTS conversations_owner_idx
  ON platform_chat.conversations (tenant_id, user_id, agent_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON platform_chat.conversations (tenant_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_title_search_idx ON platform_chat.conversations USING gin (title_search);

CREATE TABLE IF NOT EXISTS platform_chat.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES platform_chat.conversations(id) ON DELETE CASCADE,
  turn_id uuid,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- D13: `simple` konfiguráció — nincs szótő-képzés, de magyar szövegre is működik.
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON platform_chat.messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_search_idx ON platform_chat.messages USING gin (search);

CREATE TABLE IF NOT EXISTS platform_chat.turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES platform_chat.conversations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled')),
  step_count integer NOT NULL DEFAULT 0,
  token_usage jsonb NOT NULL DEFAULT '{}',
  error text,
  -- Forduló-szintű folytatási token (§7) — a forduló lezárásakor törlődik.
  continuation_token text,
  -- Forduló eleji, egyszer betöltött agent-definíció és eszközlista (§5.2 „cache-elve”).
  context jsonb,
  pending_approval jsonb,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- §5.2/6: egy beszélgetésben egyszerre egy futó forduló.
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_per_conversation
  ON platform_chat.turns (conversation_id) WHERE status IN ('queued', 'running', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS turns_finished_idx ON platform_chat.turns (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_chat.turn_steps (
  turn_id uuid NOT NULL REFERENCES platform_chat.turns(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('llm', 'tool')),
  input_hash text NOT NULL,
  output jsonb,
  status text NOT NULL CHECK (status IN ('running', 'done', 'awaiting_approval')),
  attempts integer NOT NULL DEFAULT 1,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);

CREATE TABLE IF NOT EXISTS platform_chat.turn_events (
  turn_id uuid NOT NULL REFERENCES platform_chat.turns(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('delta', 'status', 'tool', 'approval', 'done', 'error')),
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq)
);

CREATE TABLE IF NOT EXISTS platform_chat.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES platform_chat.conversations(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  extracted_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON platform_chat.attachments (conversation_id);

-- D15: minden admin-megnyitás naplózva (ki, mikor, melyik beszélgetést).
CREATE TABLE IF NOT EXISTS platform_chat.admin_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_views_tenant_idx ON platform_chat.admin_views (tenant_id, viewed_at DESC);

CREATE TABLE IF NOT EXISTS platform_chat.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
