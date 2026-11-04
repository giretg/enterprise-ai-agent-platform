/**
 * Mentett lekérdezések tárolása (#1083, D2): a cég adattárház-sémájában, mert a
 * szűrőértékek és leírások üzleti tartalom. Minden hívás a szolgáltatáson át jön,
 * az `ownerAgentId` szűrő ott dől el: `null` csak a Control Plane-ről érkezhet.
 */
import type { QuerySpec } from './query'
import type { SavedQueryParam, SavedQuerySnapshots } from './saved-query'
import { qt, type SqlExecutor } from './sql'

export type SavedQueryRecord = {
  id: string
  ownerAgentId: string
  name: string
  description: string
  status: 'active' | 'archived'
  currentVersion: number
  version: number
  spec: QuerySpec
  params: SavedQueryParam[]
  contentHash: string
  snapshots: SavedQuerySnapshots
  changeNote: string | null
  createdAt: string
  versionCreatedAt: string
  reviewedAt: string | null
  lastRunAt: string | null
  runCount: number
}

export type SavedQueryVersionInput = {
  description: string
  spec: QuerySpec
  params: SavedQueryParam[]
  contentHash: string
  snapshots: SavedQuerySnapshots
  changeNote: string | null
  userId: string
}

type Row = {
  id: string
  owner_agent_id: string
  name: string
  description: string
  status: string
  current_version: number
  version: number
  spec: QuerySpec
  params: SavedQueryParam[]
  content_hash: string
  snapshots: SavedQuerySnapshots
  change_note: string | null
  created_at: Date
  version_created_at: Date
  reviewed_at: Date | null
  last_run_at: Date | null
  run_count: number
}

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null)

function toRecord(row: Row): SavedQueryRecord {
  return {
    id: row.id,
    ownerAgentId: row.owner_agent_id,
    name: row.name,
    description: row.description,
    status: row.status === 'archived' ? 'archived' : 'active',
    currentVersion: Number(row.current_version),
    version: Number(row.version),
    spec: row.spec,
    params: row.params,
    contentHash: row.content_hash,
    snapshots: row.snapshots,
    changeNote: row.change_note,
    createdAt: iso(row.created_at)!,
    versionCreatedAt: iso(row.version_created_at)!,
    reviewedAt: iso(row.reviewed_at),
    lastRunAt: iso(row.last_run_at),
    runCount: Number(row.run_count),
  }
}

function selectFrom(schema: string): string {
  return `SELECT q.id::text AS id, q.owner_agent_id::text AS owner_agent_id, q.name, v.description, q.status, q.current_version, v.version,
      v.spec, v.params, v.content_hash, v.snapshots, v.change_note, q.created_at, v.created_at AS version_created_at, v.reviewed_at, q.last_run_at, q.run_count
    FROM ${qt(schema, '_saved_queries')} q`
}

/** Azonosító vagy név alapján; a név csak az aktív lekérdezések között egyedi. */
export async function findSavedQuery(
  sql: SqlExecutor,
  schema: string,
  input: ({ id: string; ownerAgentId: string | null } | { name: string; ownerAgentId: string }) & { version?: number; forUpdate?: boolean },
): Promise<SavedQueryRecord | null> {
  const params: unknown[] = []
  const where: string[] = []
  if ('id' in input) {
    params.push(input.id)
    where.push(`q.id = $${params.length}::uuid`)
  } else {
    params.push(input.name)
    where.push(`q.name = $${params.length}`, `q.status = 'active'`)
  }
  if (input.ownerAgentId !== null) {
    params.push(input.ownerAgentId)
    where.push(`q.owner_agent_id = $${params.length}::uuid`)
  }
  let versionExpr = 'q.current_version'
  if (input.version !== undefined) {
    params.push(input.version)
    versionExpr = `$${params.length}::int`
  }
  const rows = await sql.query<Row>(
    `${selectFrom(schema)} JOIN ${qt(schema, '_saved_query_versions')} v ON v.query_id = q.id AND v.version = ${versionExpr}
     WHERE ${where.join(' AND ')} LIMIT 1${input.forUpdate ? ' FOR UPDATE OF q' : ''}`,
    params,
  )
  return rows[0] ? toRecord(rows[0]) : null
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export async function listSavedQueries(
  sql: SqlExecutor,
  schema: string,
  input: { ownerAgentId: string | null; query?: string; dataset?: string; limit: number },
): Promise<SavedQueryRecord[]> {
  const params: unknown[] = []
  const where = [`q.status = 'active'`]
  if (input.ownerAgentId !== null) {
    params.push(input.ownerAgentId)
    where.push(`q.owner_agent_id = $${params.length}::uuid`)
  }
  if (input.query?.trim()) {
    params.push(`%${escapeLike(input.query.trim())}%`)
    where.push(`(q.name ILIKE $${params.length} OR v.description ILIKE $${params.length})`)
  }
  if (input.dataset) {
    params.push(input.dataset)
    where.push(`v.spec->>'dataset' = $${params.length}`)
  }
  params.push(Math.max(1, Math.min(200, input.limit)))
  const rows = await sql.query<Row>(
    `${selectFrom(schema)} JOIN ${qt(schema, '_saved_query_versions')} v ON v.query_id = q.id AND v.version = q.current_version
     WHERE ${where.join(' AND ')} ORDER BY q.last_run_at DESC NULLS LAST, q.created_at DESC LIMIT $${params.length}::int`,
    params,
  )
  return rows.map(toRecord)
}

export async function countActive(sql: SqlExecutor, schema: string, ownerAgentId: string): Promise<number> {
  const rows = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${qt(schema, '_saved_queries')} WHERE owner_agent_id = $1::uuid AND status = 'active'`, [ownerAgentId])
  return Number(rows[0]?.n ?? 0)
}

async function insertVersion(sql: SqlExecutor, schema: string, id: string, version: number, input: SavedQueryVersionInput) {
  await sql.exec(
    `INSERT INTO ${qt(schema, '_saved_query_versions')} (query_id, version, description, spec, params, content_hash, snapshots, change_note, created_by)
     VALUES ($1::uuid, $2::int, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9::uuid)`,
    [id, version, input.description, JSON.stringify(input.spec), JSON.stringify(input.params), input.contentHash, JSON.stringify(input.snapshots), input.changeNote, input.userId],
  )
}

/** `false`: párhuzamos mentés már létrehozta ugyanezen a néven. */
export async function insertSavedQuery(
  sql: SqlExecutor,
  schema: string,
  input: SavedQueryVersionInput & { id: string; ownerAgentId: string; name: string },
): Promise<boolean> {
  const inserted = await sql.exec(
    `INSERT INTO ${qt(schema, '_saved_queries')} (id, owner_agent_id, name, description, current_version, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5::uuid)
     ON CONFLICT (owner_agent_id, name) WHERE status = 'active' DO NOTHING`,
    [input.id, input.ownerAgentId, input.name, input.description, input.userId],
  )
  if (!inserted) return false
  await insertVersion(sql, schema, input.id, 1, input)
  return true
}

export async function addVersion(sql: SqlExecutor, schema: string, input: SavedQueryVersionInput & { id: string; version: number }) {
  await insertVersion(sql, schema, input.id, input.version, input)
  await sql.exec(
    `UPDATE ${qt(schema, '_saved_queries')} SET current_version = $2::int, description = $3, updated_at = now() WHERE id = $1::uuid`,
    [input.id, input.version, input.description],
  )
}

/** Az agent átnézte: a lenyomat a mai katalógushoz igazodik, új verzió nélkül. */
export async function reviewVersion(sql: SqlExecutor, schema: string, input: { id: string; version: number; snapshots: SavedQuerySnapshots; userId: string }) {
  await sql.exec(
    `UPDATE ${qt(schema, '_saved_query_versions')} SET snapshots = $3::jsonb, reviewed_at = now(), reviewed_by = $4::uuid WHERE query_id = $1::uuid AND version = $2::int`,
    [input.id, input.version, JSON.stringify(input.snapshots), input.userId],
  )
}

export async function listVersions(sql: SqlExecutor, schema: string, id: string) {
  const rows = await sql.query<{ version: number; change_note: string | null; created_at: Date }>(
    `SELECT version, change_note, created_at FROM ${qt(schema, '_saved_query_versions')} WHERE query_id = $1::uuid ORDER BY version DESC LIMIT 50`,
    [id],
  )
  return rows.map((row) => ({ version: Number(row.version), changeNote: row.change_note, createdAt: iso(row.created_at)! }))
}

export async function recordRun(sql: SqlExecutor, schema: string, id: string) {
  await sql.exec(`UPDATE ${qt(schema, '_saved_queries')} SET last_run_at = now(), run_count = run_count + 1 WHERE id = $1::uuid`, [id])
}

export async function archiveSavedQuery(sql: SqlExecutor, schema: string, id: string) {
  await sql.exec(`UPDATE ${qt(schema, '_saved_queries')} SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1::uuid`, [id])
}
