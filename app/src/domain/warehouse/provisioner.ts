/**
 * Adattárház-kiosztás (#984 §2, R2, Q2 v1-döntés): cserélhető
 * `WarehouseProvisioner` mögött. v1 = cégenként külön PostgreSQL-séma a
 * (külön beállítható) adattárház-adatbázisban; projekt-per-cég Neon később
 * ugyanezen interfész mögé kerülhet. Minden lépés idempotens (`IF NOT EXISTS`),
 * így az aktiválás ismétlése ugyanahhoz a logikai környezethez vezet (AC10).
 */
import { qs, qt, type SqlExecutor, type WarehouseDatabase } from './sql'

export const WAREHOUSE_INTERNAL_VERSION = 1

export type ProvisionedResources = {
  provisioner: 'pg_schema'
  schemaName: string
  internalVersion: number
}

export interface WarehouseProvisioner {
  readonly kind: ProvisionedResources['provisioner']
  provision(schemaName: string): Promise<ProvisionedResources>
  verify(schemaName: string): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** A belső (katalógus, import, recept, kivétel, történet) táblák — kódban rögzített DDL. */
export function internalSchemaDdl(schema: string): string[] {
  const t = (name: string) => qt(schema, name)
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qs(schema)}`,
    `CREATE TABLE IF NOT EXISTS ${t('_meta')} (key text PRIMARY KEY, value jsonb NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t('_datasets')} (
      key text PRIMARY KEY,
      table_name text NOT NULL UNIQUE,
      title text NOT NULL,
      purpose text,
      row_meaning text,
      temporal text,
      status text NOT NULL DEFAULT 'proposed',
      structure_version int NOT NULL DEFAULT 1,
      business_key text[] NOT NULL DEFAULT '{}',
      mode text NOT NULL,
      published_at timestamptz,
      last_import_id uuid,
      row_count int NOT NULL DEFAULT 0,
      confirmed_by uuid,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${t('_fields')} (
      dataset_key text NOT NULL REFERENCES ${t('_datasets')}(key) ON DELETE CASCADE,
      name text NOT NULL,
      position int NOT NULL,
      type text NOT NULL,
      label text NOT NULL,
      meaning text,
      unit text,
      currency text,
      amount_basis text,
      role text NOT NULL DEFAULT 'data',
      link_dataset text,
      link_by text,
      link_field text,
      status text NOT NULL DEFAULT 'proposed',
      source_header text,
      added_in_version int NOT NULL DEFAULT 1,
      PRIMARY KEY (dataset_key, name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${t('_imports')} (
      id uuid PRIMARY KEY,
      state text NOT NULL,
      dataset_key text,
      file_name text NOT NULL,
      file_sha256 text NOT NULL,
      size_bytes int NOT NULL,
      profile jsonb,
      fingerprints text[] NOT NULL DEFAULT '{}',
      plan jsonb,
      plan_source text,
      plan_hash text,
      recipe_id uuid,
      check_result jsonb,
      preview jsonb,
      preview_hash text,
      approval_reasons text[] NOT NULL DEFAULT '{}',
      result jsonb,
      error jsonb,
      created_by uuid,
      agent_id uuid,
      approved_by uuid,
      approved_at timestamptz,
      idempotency_key text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      rolled_back_at timestamptz
    )`,
    `CREATE INDEX IF NOT EXISTS _imports_dataset_idx ON ${t('_imports')} (dataset_key, published_at)`,
    `CREATE TABLE IF NOT EXISTS ${t('_source_files')} (
      import_id uuid PRIMARY KEY REFERENCES ${t('_imports')}(id) ON DELETE CASCADE,
      content bytea NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${t('_recipes')} (
      id uuid PRIMARY KEY,
      dataset_key text NOT NULL,
      fingerprint text NOT NULL,
      sheet text NOT NULL,
      headers text[] NOT NULL DEFAULT '{}',
      version int NOT NULL,
      plan jsonb NOT NULL,
      plan_hash text NOT NULL,
      created_from_import uuid,
      created_by uuid,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset_key, fingerprint, version)
    )`,
    `CREATE INDEX IF NOT EXISTS _recipes_fingerprint_idx ON ${t('_recipes')} (fingerprint) WHERE active`,
    `CREATE TABLE IF NOT EXISTS ${t('_exceptions')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      import_id uuid NOT NULL,
      dataset_key text NOT NULL,
      source_row int,
      kind text NOT NULL,
      field text,
      value text,
      detail text,
      candidates jsonb,
      row_id uuid,
      link_column text,
      status text NOT NULL DEFAULT 'pending',
      resolution jsonb,
      resolved_by uuid,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS _exceptions_open_idx ON ${t('_exceptions')} (dataset_key, status)`,
    `CREATE INDEX IF NOT EXISTS _exceptions_import_idx ON ${t('_exceptions')} (import_id)`,
    // Elfogadott név → rekord megfeleltetés (egy kivétel feloldása); újraimportnál ez köt.
    `CREATE TABLE IF NOT EXISTS ${t('_link_aliases')} (
      dataset_key text NOT NULL,
      link_column text NOT NULL,
      source_value text NOT NULL,
      target_id uuid NOT NULL,
      decided_by uuid,
      exception_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      PRIMARY KEY (dataset_key, link_column, source_value)
    )`,
    `CREATE TABLE IF NOT EXISTS ${t('_row_history')} (
      id bigserial PRIMARY KEY,
      import_id uuid NOT NULL,
      dataset_key text NOT NULL,
      row_id uuid NOT NULL,
      op text NOT NULL,
      before jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS _row_history_import_idx ON ${t('_row_history')} (import_id)`,
    `CREATE TABLE IF NOT EXISTS ${t('_decisions')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      subject jsonb NOT NULL,
      decided_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `INSERT INTO ${t('_meta')} (key, value) VALUES ('internal_version', '${WAREHOUSE_INTERNAL_VERSION}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  ]
}

export async function applyInternalSchema(sql: SqlExecutor, schema: string): Promise<void> {
  // Párhuzamos aktiválás ugyanarra a sémára: sorosítva.
  await sql.exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, [schema])
  for (const statement of internalSchemaDdl(schema)) await sql.exec(statement)
}

export class PgSchemaProvisioner implements WarehouseProvisioner {
  readonly kind = 'pg_schema' as const
  constructor(private readonly db: WarehouseDatabase) {}

  async provision(schemaName: string): Promise<ProvisionedResources> {
    await this.db.run((sql) => applyInternalSchema(sql, schemaName), { statementTimeoutMs: 60_000 })
    return { provisioner: this.kind, schemaName, internalVersion: WAREHOUSE_INTERNAL_VERSION }
  }

  async verify(schemaName: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const rows = await this.db.run(
        (sql) => sql.query<{ value: unknown }>(`SELECT value FROM ${qt(schemaName, '_meta')} WHERE key = 'internal_version'`),
        { readOnly: true, statementTimeoutMs: 10_000 },
      )
      if (Number(rows[0]?.value) !== WAREHOUSE_INTERNAL_VERSION) return { ok: false, reason: 'internal_version_mismatch' }
      return { ok: true }
    } catch {
      return { ok: false, reason: 'schema_unreachable' }
    }
  }
}
