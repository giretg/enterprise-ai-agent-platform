/**
 * Adattárház-tároló (#984): a tenant sémájában futó SQL — katalógus, importok,
 * receptek, kivételek, sor-történet, szerkezetkezelés (csak ADDITÍV DDL:
 * új tábla / új oszlop), betöltés és visszavonás. Az azonosítók a `sql.ts`
 * kapuján mennek át, az értékek mindig paraméterek.
 */
import { randomUUID } from 'node:crypto'
import type { CatalogDataset, CatalogField, ImportPlan } from './plan'
import { batchSize, datasetTableName, qi, qt, SQL_TYPE, type SqlExecutor } from './sql'
import type { RowValue } from './transform'
import type { WarehouseFieldType } from './value-parse'

// ── Katalógus ────────────────────────────────────────────────────────────────

type DatasetRow = {
  key: string
  table_name: string
  title: string
  purpose: string | null
  row_meaning: string | null
  temporal: string | null
  status: string
  structure_version: number
  business_key: string[]
  mode: string
  published_at: Date | null
  last_import_id: string | null
  row_count: number
}

type FieldRow = {
  dataset_key: string
  name: string
  type: string
  label: string
  meaning: string | null
  unit: string | null
  currency: string | null
  amount_basis: string | null
  role: string
  link_dataset: string | null
  link_by: string | null
  link_field: string | null
  status: string
  source_header: string | null
}

export async function loadCatalog(sql: SqlExecutor, schema: string): Promise<Map<string, CatalogDataset>> {
  const datasets = await sql.query<DatasetRow>(`SELECT * FROM ${qt(schema, '_datasets')} ORDER BY key`)
  const fields = await sql.query<FieldRow>(`SELECT * FROM ${qt(schema, '_fields')} ORDER BY dataset_key, position`)
  const map = new Map<string, CatalogDataset>()
  for (const d of datasets) {
    map.set(d.key, {
      key: d.key,
      tableName: d.table_name,
      title: d.title,
      purpose: d.purpose,
      rowMeaning: d.row_meaning,
      temporal: d.temporal,
      status: d.status === 'confirmed' ? 'confirmed' : 'proposed',
      structureVersion: Number(d.structure_version),
      businessKey: d.business_key ?? [],
      mode: d.mode === 'append' ? 'append' : 'upsert',
      publishedAt: d.published_at ? new Date(d.published_at).toISOString() : null,
      lastImportId: d.last_import_id,
      rowCount: Number(d.row_count),
      fields: [],
    })
  }
  for (const f of fields) {
    map.get(f.dataset_key)?.fields.push({
      name: f.name,
      type: f.type as CatalogField['type'],
      label: f.label,
      meaning: f.meaning,
      unit: f.unit,
      currency: f.currency,
      amountBasis: f.amount_basis,
      role: f.role === 'link' ? 'link' : 'data',
      linkDataset: f.link_dataset,
      linkBy: f.link_by === 'key' || f.link_by === 'name' ? f.link_by : null,
      linkField: f.link_field,
      status: f.status === 'confirmed' ? 'confirmed' : 'proposed',
      sourceHeader: f.source_header,
    })
  }
  return map
}

/**
 * Szerkezetkezelő: a jóváhagyott terv ADDITÍV végrehajtása (új tábla, új oszlop),
 * katalógus-frissítéssel. Megerősített definíciót a terv nem ír felül.
 */
export async function applyStructure(
  sql: SqlExecutor,
  schema: string,
  plan: ImportPlan,
  catalog: Map<string, CatalogDataset>,
): Promise<{ structureVersion: number; created: boolean; addedColumns: string[] }> {
  const existing = catalog.get(plan.dataset.key)
  const table = datasetTableName(plan.dataset.key)
  const columns: Array<{ name: string; type: WarehouseFieldType | 'link' }> = [
    ...plan.fields.map((f) => ({ name: f.target, type: f.type })),
    ...plan.links.map((l) => ({ name: l.as, type: 'link' as const })),
  ]
  const known = new Set(existing?.fields.map((f) => f.name) ?? [])
  const added = columns.filter((c) => !known.has(c.name))
  if (!existing) {
    await sql.exec(`CREATE TABLE IF NOT EXISTS ${qt(schema, table)} (
      _id uuid PRIMARY KEY,
      _bk text UNIQUE,
      _import_id uuid NOT NULL,
      _updated_import_id uuid NOT NULL,
      _source_row int,
      _created_at timestamptz NOT NULL DEFAULT now(),
      _updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  }
  for (const column of added) {
    await sql.exec(`ALTER TABLE ${qt(schema, table)} ADD COLUMN IF NOT EXISTS ${qi(column.name)} ${SQL_TYPE[column.type]}`)
  }
  const structureVersion = existing ? existing.structureVersion + (added.length ? 1 : 0) : 1
  await sql.exec(
    `INSERT INTO ${qt(schema, '_datasets')} (key, table_name, title, purpose, row_meaning, temporal, business_key, mode, structure_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
     ON CONFLICT (key) DO UPDATE SET
       title = CASE WHEN ${qt(schema, '_datasets')}.status = 'confirmed' THEN ${qt(schema, '_datasets')}.title ELSE EXCLUDED.title END,
       purpose = CASE WHEN ${qt(schema, '_datasets')}.status = 'confirmed' THEN ${qt(schema, '_datasets')}.purpose ELSE EXCLUDED.purpose END,
       row_meaning = CASE WHEN ${qt(schema, '_datasets')}.status = 'confirmed' THEN ${qt(schema, '_datasets')}.row_meaning ELSE EXCLUDED.row_meaning END,
       temporal = CASE WHEN ${qt(schema, '_datasets')}.status = 'confirmed' THEN ${qt(schema, '_datasets')}.temporal ELSE EXCLUDED.temporal END,
       structure_version = EXCLUDED.structure_version,
       updated_at = now()`,
    [
      plan.dataset.key,
      table,
      plan.dataset.title,
      plan.dataset.purpose ?? null,
      plan.dataset.rowMeaning ?? null,
      plan.dataset.temporal ?? null,
      plan.businessKey,
      plan.mode,
      structureVersion,
    ],
  )
  let position = existing?.fields.length ?? 0
  const fieldRows = [
    ...plan.fields.map((f) => ({
      name: f.target,
      type: f.type as string,
      label: f.label,
      meaning: f.meaning ?? null,
      unit: f.unit ?? null,
      currency: f.currency ?? null,
      amountBasis: f.amountBasis ?? null,
      role: 'data',
      linkDataset: null as string | null,
      linkBy: null as string | null,
      linkField: null as string | null,
      sourceHeader: f.source,
    })),
    ...plan.links.map((l) => ({
      name: l.as,
      type: 'link',
      label: `${l.field} → ${l.toDataset}`,
      meaning: `Belső hivatkozás a(z) ${l.toDataset} adatkészlet rekordjára (${l.by === 'key' ? 'üzleti kulcs' : 'normalizált név'} alapján: ${l.toField}).`,
      unit: null,
      currency: null,
      amountBasis: null,
      role: 'link',
      linkDataset: l.toDataset,
      linkBy: l.by,
      linkField: l.toField,
      sourceHeader: null,
    })),
  ]
  for (const f of fieldRows) {
    const isNew = !known.has(f.name)
    await sql.exec(
      `INSERT INTO ${qt(schema, '_fields')} (dataset_key, name, position, type, label, meaning, unit, currency, amount_basis, role, link_dataset, link_by, link_field, source_header, added_in_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (dataset_key, name) DO UPDATE SET
         label = CASE WHEN ${qt(schema, '_fields')}.status = 'confirmed' THEN ${qt(schema, '_fields')}.label ELSE EXCLUDED.label END,
         meaning = CASE WHEN ${qt(schema, '_fields')}.status = 'confirmed' THEN ${qt(schema, '_fields')}.meaning ELSE EXCLUDED.meaning END,
         unit = CASE WHEN ${qt(schema, '_fields')}.status = 'confirmed' THEN ${qt(schema, '_fields')}.unit ELSE EXCLUDED.unit END,
         currency = CASE WHEN ${qt(schema, '_fields')}.status = 'confirmed' THEN ${qt(schema, '_fields')}.currency ELSE EXCLUDED.currency END,
         amount_basis = CASE WHEN ${qt(schema, '_fields')}.status = 'confirmed' THEN ${qt(schema, '_fields')}.amount_basis ELSE EXCLUDED.amount_basis END,
         source_header = EXCLUDED.source_header`,
      [
        plan.dataset.key,
        f.name,
        isNew ? position++ : 0,
        f.type,
        f.label,
        f.meaning,
        f.unit,
        f.currency,
        f.amountBasis,
        f.role,
        f.linkDataset,
        f.linkBy,
        f.linkField,
        f.sourceHeader,
        structureVersion,
      ],
    )
  }
  return { structureVersion, created: !existing, addedColumns: added.map((c) => c.name) }
}

export async function confirmDataset(sql: SqlExecutor, schema: string, key: string, userId: string): Promise<boolean> {
  const updated = await sql.exec(
    `UPDATE ${qt(schema, '_datasets')} SET status = 'confirmed', confirmed_by = $2::uuid, confirmed_at = now(), updated_at = now() WHERE key = $1`,
    [key, userId],
  )
  if (!updated) return false
  await sql.exec(`UPDATE ${qt(schema, '_fields')} SET status = 'confirmed' WHERE dataset_key = $1`, [key])
  await recordDecision(sql, schema, 'catalog.confirmed', { datasetKey: key }, userId)
  return true
}

export async function recordDecision(sql: SqlExecutor, schema: string, kind: string, subject: Record<string, unknown>, userId: string | null) {
  await sql.exec(`INSERT INTO ${qt(schema, '_decisions')} (kind, subject, decided_by) VALUES ($1, $2::jsonb, $3::uuid)`, [
    kind,
    JSON.stringify(subject),
    userId,
  ])
}

// ── Importok ─────────────────────────────────────────────────────────────────

export type ImportState =
  | 'received'
  | 'profiled'
  | 'awaiting_plan'
  | 'planned'
  | 'previewed'
  | 'awaiting_approval'
  | 'loading'
  | 'published'
  | 'awaiting_ai'
  | 'awaiting_clarification'
  | 'failed'
  | 'rolled_back'

export type ImportRecord = {
  id: string
  state: ImportState
  datasetKey: string | null
  fileName: string
  fileSha256: string
  sizeBytes: number
  profile: unknown
  fingerprints: string[]
  plan: ImportPlan | null
  planSource: 'ai' | 'recipe' | 'human' | null
  planHash: string | null
  recipeId: string | null
  checkResult: unknown
  preview: unknown
  previewHash: string | null
  approvalReasons: string[]
  result: unknown
  error: unknown
  createdBy: string | null
  agentId: string | null
  approvedBy: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  rolledBackAt: string | null
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null
}

function toImport(row: Record<string, unknown>): ImportRecord {
  return {
    id: String(row.id),
    state: row.state as ImportState,
    datasetKey: (row.dataset_key as string | null) ?? null,
    fileName: String(row.file_name),
    fileSha256: String(row.file_sha256),
    sizeBytes: Number(row.size_bytes),
    profile: row.profile ?? null,
    fingerprints: (row.fingerprints as string[] | null) ?? [],
    plan: (row.plan as ImportPlan | null) ?? null,
    planSource: (row.plan_source as ImportRecord['planSource']) ?? null,
    planHash: (row.plan_hash as string | null) ?? null,
    recipeId: (row.recipe_id as string | null) ?? null,
    checkResult: row.check_result ?? null,
    preview: row.preview ?? null,
    previewHash: (row.preview_hash as string | null) ?? null,
    approvalReasons: (row.approval_reasons as string[] | null) ?? [],
    result: row.result ?? null,
    error: row.error ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    agentId: (row.agent_id as string | null) ?? null,
    approvedBy: (row.approved_by as string | null) ?? null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    publishedAt: iso(row.published_at),
    rolledBackAt: iso(row.rolled_back_at),
  }
}

const IMPORT_COLUMNS =
  'id, state, dataset_key, file_name, file_sha256, size_bytes, profile, fingerprints, plan, plan_source, plan_hash, recipe_id, check_result, preview, preview_hash, approval_reasons, result, error, created_by, agent_id, approved_by, created_at, updated_at, published_at, rolled_back_at'

export async function insertImport(
  sql: SqlExecutor,
  schema: string,
  input: {
    fileName: string
    fileSha256: string
    content: Buffer
    profile: unknown
    fingerprints: string[]
    createdBy: string | null
    agentId: string | null
    idempotencyKey: string | null
  },
): Promise<{ record: ImportRecord; created: boolean }> {
  if (input.idempotencyKey) {
    const existing = await findImportByIdempotencyKey(sql, schema, input.idempotencyKey)
    if (existing) return { record: existing, created: false }
  }
  const id = randomUUID()
  await sql.exec(
    `INSERT INTO ${qt(schema, '_imports')} (id, state, file_name, file_sha256, size_bytes, profile, fingerprints, created_by, agent_id, idempotency_key)
     VALUES ($1::uuid, 'profiled', $2, $3, $4, $5::jsonb, $6::text[], $7::uuid, $8::uuid, $9)`,
    [id, input.fileName, input.fileSha256, input.content.byteLength, JSON.stringify(input.profile), input.fingerprints, input.createdBy, input.agentId, input.idempotencyKey],
  )
  await sql.exec(`INSERT INTO ${qt(schema, '_source_files')} (import_id, content) VALUES ($1::uuid, $2)`, [id, input.content])
  return { record: (await getImport(sql, schema, id))!, created: true }
}

export async function findImportByIdempotencyKey(sql: SqlExecutor, schema: string, key: string): Promise<ImportRecord | null> {
  const rows = await sql.query(`SELECT ${IMPORT_COLUMNS} FROM ${qt(schema, '_imports')} WHERE idempotency_key = $1`, [key])
  return rows[0] ? toImport(rows[0]) : null
}

export async function getImport(sql: SqlExecutor, schema: string, id: string, forUpdate = false): Promise<ImportRecord | null> {
  const rows = await sql.query(
    `SELECT ${IMPORT_COLUMNS} FROM ${qt(schema, '_imports')} WHERE id = $1::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  )
  return rows[0] ? toImport(rows[0]) : null
}

export async function listImports(sql: SqlExecutor, schema: string, limit: number): Promise<ImportRecord[]> {
  const rows = await sql.query(`SELECT ${IMPORT_COLUMNS} FROM ${qt(schema, '_imports')} ORDER BY created_at DESC LIMIT $1`, [limit])
  return rows.map(toImport)
}

export async function readSourceFile(sql: SqlExecutor, schema: string, importId: string): Promise<Buffer | null> {
  const rows = await sql.query<{ content: Uint8Array }>(`SELECT content FROM ${qt(schema, '_source_files')} WHERE import_id = $1::uuid`, [importId])
  return rows[0] ? Buffer.from(rows[0].content) : null
}

const PATCHABLE: Record<string, string> = {
  state: 'text',
  datasetKey: 'text',
  plan: 'jsonb',
  planSource: 'text',
  planHash: 'text',
  recipeId: 'uuid',
  checkResult: 'jsonb',
  preview: 'jsonb',
  previewHash: 'text',
  approvalReasons: 'text[]',
  result: 'jsonb',
  error: 'jsonb',
  approvedBy: 'uuid',
}

const SNAKE: Record<string, string> = {
  datasetKey: 'dataset_key',
  planSource: 'plan_source',
  planHash: 'plan_hash',
  recipeId: 'recipe_id',
  checkResult: 'check_result',
  previewHash: 'preview_hash',
  approvalReasons: 'approval_reasons',
  approvedBy: 'approved_by',
}

/**
 * Import állapot/mező frissítés. `fromStates` megadásával CAS: csak a várt
 * állapot(ok)ból ír — így a `published` / `rolled_back` végállapotot nem
 * írhatja felül egy későn érkező preview / awaiting_approval / hibaág
 * (duplikált append-betöltés).
 * @returns true, ha legalább egy sor frissült
 */
export async function updateImport(
  sql: SqlExecutor,
  schema: string,
  id: string,
  patch: Partial<Pick<ImportRecord, 'state' | 'datasetKey' | 'plan' | 'planSource' | 'planHash' | 'recipeId' | 'checkResult' | 'preview' | 'previewHash' | 'approvalReasons' | 'result' | 'error' | 'approvedBy'>>,
  extra: { published?: boolean; rolledBack?: boolean; approved?: boolean; fromStates?: readonly ImportState[] } = {},
): Promise<boolean> {
  const sets: string[] = []
  const params: unknown[] = [id]
  for (const [key, value] of Object.entries(patch)) {
    const type = PATCHABLE[key]
    if (!type) continue
    params.push(type === 'jsonb' ? (value === null ? null : JSON.stringify(value)) : value)
    sets.push(`${SNAKE[key] ?? key} = $${params.length}::${type}`)
  }
  if (extra.published) sets.push('published_at = now()')
  if (extra.rolledBack) sets.push('rolled_back_at = now()')
  if (extra.approved) sets.push('approved_at = now()')
  sets.push('updated_at = now()')
  let where = `WHERE id = $1::uuid`
  if (extra.fromStates && extra.fromStates.length > 0) {
    params.push([...extra.fromStates])
    where += ` AND state = ANY($${params.length}::text[])`
  }
  const updated = await sql.exec(`UPDATE ${qt(schema, '_imports')} SET ${sets.join(', ')} ${where}`, params)
  return updated > 0
}

// ── Receptek ─────────────────────────────────────────────────────────────────

export type RecipeRecord = { id: string; datasetKey: string; fingerprint: string; sheet: string; version: number; plan: ImportPlan; planHash: string; createdAt: string }

export async function findRecipe(sql: SqlExecutor, schema: string, fingerprints: string[]): Promise<RecipeRecord | null> {
  if (fingerprints.length === 0) return null
  const rows = await sql.query<Record<string, unknown>>(
    `SELECT id, dataset_key, fingerprint, sheet, version, plan, plan_hash, created_at FROM ${qt(schema, '_recipes')}
     WHERE active AND fingerprint = ANY($1::text[]) ORDER BY created_at DESC, version DESC LIMIT 1`,
    [fingerprints],
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    datasetKey: String(row.dataset_key),
    fingerprint: String(row.fingerprint),
    sheet: String(row.sheet),
    version: Number(row.version),
    plan: row.plan as ImportPlan,
    planHash: String(row.plan_hash),
    createdAt: iso(row.created_at)!,
  }
}

/** Közzétételkor: a terv receptként (verziózva) megmarad; azonos terv nem kap új verziót. */
export async function saveRecipe(
  sql: SqlExecutor,
  schema: string,
  input: { datasetKey: string; fingerprint: string; sheet: string; headers: string[]; plan: ImportPlan; planHash: string; importId: string; userId: string | null },
): Promise<{ id: string; version: number; created: boolean }> {
  const rows = await sql.query<{ id: string; version: number; plan_hash: string }>(
    `SELECT id, version, plan_hash FROM ${qt(schema, '_recipes')} WHERE dataset_key = $1 AND fingerprint = $2 ORDER BY version DESC LIMIT 1`,
    [input.datasetKey, input.fingerprint],
  )
  const latest = rows[0]
  if (latest && latest.plan_hash === input.planHash) return { id: latest.id, version: Number(latest.version), created: false }
  const id = randomUUID()
  const version = latest ? Number(latest.version) + 1 : 1
  await sql.exec(
    `UPDATE ${qt(schema, '_recipes')} SET active = false WHERE dataset_key = $1 AND fingerprint = $2`,
    [input.datasetKey, input.fingerprint],
  )
  await sql.exec(
    `INSERT INTO ${qt(schema, '_recipes')} (id, dataset_key, fingerprint, sheet, headers, version, plan, plan_hash, created_from_import, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::text[], $6, $7::jsonb, $8, $9::uuid, $10::uuid)`,
    [id, input.datasetKey, input.fingerprint, input.sheet, input.headers, version, JSON.stringify(input.plan), input.planHash, input.importId, input.userId],
  )
  return { id, version, created: true }
}

/** Szerkezetváltozás-felismerés (AC5): a legközelebbi recept fejlécei. */
export async function listRecipeHeaders(
  sql: SqlExecutor,
  schema: string,
): Promise<Array<{ datasetKey: string; sheet: string; sources: string[]; headers: string[]; version: number }>> {
  const rows = await sql.query<{ dataset_key: string; sheet: string; headers: string[]; plan: ImportPlan; version: number }>(
    `SELECT dataset_key, sheet, headers, plan, version FROM ${qt(schema, '_recipes')} WHERE active ORDER BY created_at DESC LIMIT 200`,
  )
  return rows.map((r) => ({
    datasetKey: r.dataset_key,
    sheet: r.sheet,
    sources: r.plan.fields.map((f) => f.source),
    headers: r.headers ?? [],
    version: Number(r.version),
  }))
}

// ── Adatsorok ────────────────────────────────────────────────────────────────

export async function tableExists(sql: SqlExecutor, schema: string, table: string): Promise<boolean> {
  const rows = await sql.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`${schema}.${table}`])
  return rows[0]?.exists === true
}

export async function loadLinkTargets(sql: SqlExecutor, schema: string, dataset: CatalogDataset, field: string): Promise<Array<{ id: string; value: string }>> {
  const rows = await sql.query<{ id: string; value: string | null }>(
    `SELECT _id::text AS id, ${qi(field)}::text AS value FROM ${qt(schema, dataset.tableName)} WHERE ${qi(field)} IS NOT NULL LIMIT 500000`,
  )
  return rows.filter((r): r is { id: string; value: string } => r.value !== null)
}

export async function loadAliases(sql: SqlExecutor, schema: string, datasetKey: string, linkColumn: string): Promise<Map<string, string>> {
  const rows = await sql.query<{ source_value: string; target_id: string }>(
    `SELECT source_value, target_id::text AS target_id FROM ${qt(schema, '_link_aliases')} WHERE dataset_key = $1 AND link_column = $2 AND revoked_at IS NULL`,
    [datasetKey, linkColumn],
  )
  return new Map(rows.map((r) => [r.source_value, r.target_id]))
}

export async function fetchExistingByKey(
  sql: SqlExecutor,
  schema: string,
  table: string,
  keys: string[],
): Promise<Map<string, { id: string; row: Record<string, unknown> }>> {
  const out = new Map<string, { id: string; row: Record<string, unknown> }>()
  for (let i = 0; i < keys.length; i += 5_000) {
    const chunk = keys.slice(i, i + 5_000)
    const rows = await sql.query<{ id: string; bk: string; row: Record<string, unknown> }>(
      `SELECT t._id::text AS id, t._bk AS bk, to_jsonb(t) AS row FROM ${qt(schema, table)} t WHERE t._bk = ANY($1::text[])`,
      [chunk],
    )
    for (const r of rows) out.set(r.bk, { id: r.id, row: r.row })
  }
  return out
}

export type ColumnSpec = { name: string; type: WarehouseFieldType | 'link' }

function rowTuple(params: unknown[], values: unknown[], columns: Array<{ cast: string }>): string {
  return `(${values.map((value, i) => {
    params.push(value)
    return `$${params.length}::${columns[i]!.cast}`
  }).join(', ')})`
}

export async function insertDataRows(
  sql: SqlExecutor,
  schema: string,
  table: string,
  columns: ColumnSpec[],
  rows: Array<{ id: string; bk: string | null; sourceRow: number; values: Record<string, RowValue> }>,
  importId: string,
): Promise<void> {
  const all = [
    { name: '_id', cast: 'uuid' },
    { name: '_bk', cast: 'text' },
    { name: '_import_id', cast: 'uuid' },
    { name: '_updated_import_id', cast: 'uuid' },
    { name: '_source_row', cast: 'int' },
    ...columns.map((c) => ({ name: c.name, cast: SQL_TYPE[c.type] })),
  ]
  const size = batchSize(all.length)
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const values: unknown[] = [row.id, row.bk, importId, importId, row.sourceRow, ...columns.map((c) => row.values[c.name] ?? null)]
      return rowTuple(params, values, all)
    })
    await sql.exec(`INSERT INTO ${qt(schema, table)} (${all.map((c) => qi(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`, params)
  }
}

export async function updateDataRows(
  sql: SqlExecutor,
  schema: string,
  table: string,
  columns: ColumnSpec[],
  rows: Array<{ id: string; sourceRow: number; values: Record<string, RowValue> }>,
  importId: string,
): Promise<void> {
  const all = [{ name: '_id', cast: 'uuid' }, { name: '_source_row', cast: 'int' }, ...columns.map((c) => ({ name: c.name, cast: SQL_TYPE[c.type] }))]
  const size = batchSize(all.length)
  const setList = [
    ...columns.map((c) => `${qi(c.name)} = v.${qi(c.name)}`),
    '_source_row = v._source_row',
    `_updated_import_id = '${importId.replace(/[^0-9a-f-]/gi, '')}'::uuid`,
    '_updated_at = now()',
  ].join(', ')
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const values: unknown[] = [row.id, row.sourceRow, ...columns.map((c) => row.values[c.name] ?? null)]
      return rowTuple(params, values, all)
    })
    await sql.exec(
      `UPDATE ${qt(schema, table)} AS t SET ${setList} FROM (VALUES ${tuples.join(', ')}) AS v(${all.map((c) => qi(c.name)).join(', ')}) WHERE t._id = v._id`,
      params,
    )
  }
}

export async function insertHistory(
  sql: SqlExecutor,
  schema: string,
  importId: string,
  datasetKey: string,
  entries: Array<{ rowId: string; op: 'insert' | 'update'; before: Record<string, unknown> | null }>,
): Promise<void> {
  const size = 2_000
  for (let i = 0; i < entries.length; i += size) {
    const chunk = entries.slice(i, i + size)
    const params: unknown[] = [importId, datasetKey]
    const tuples = chunk.map((e) => {
      params.push(e.rowId, e.op, e.before === null ? null : JSON.stringify(e.before))
      const n = params.length
      return `($1::uuid, $2, $${n - 2}::uuid, $${n - 1}, $${n}::jsonb)`
    })
    await sql.exec(`INSERT INTO ${qt(schema, '_row_history')} (import_id, dataset_key, row_id, op, before) VALUES ${tuples.join(', ')}`, params)
  }
}

export type ExceptionInput = {
  importId: string
  datasetKey: string
  sourceRow: number | null
  kind: string
  field: string | null
  value: string | null
  detail: string | null
  candidates: Array<{ id: string; label: string }> | null
  rowId: string | null
  linkColumn: string | null
}

export async function insertExceptions(sql: SqlExecutor, schema: string, entries: ExceptionInput[]): Promise<void> {
  const size = 1_000
  for (let i = 0; i < entries.length; i += size) {
    const chunk = entries.slice(i, i + size)
    const params: unknown[] = []
    const tuples = chunk.map((e) => {
      const values = [e.importId, e.datasetKey, e.sourceRow, e.kind, e.field, e.value, e.detail, e.candidates ? JSON.stringify(e.candidates) : null, e.rowId, e.linkColumn]
      const casts = ['uuid', 'text', 'int', 'text', 'text', 'text', 'text', 'jsonb', 'uuid', 'text']
      return `(${values
        .map((v, idx) => {
          params.push(v)
          return `$${params.length}::${casts[idx]}`
        })
        .join(', ')})`
    })
    await sql.exec(
      `INSERT INTO ${qt(schema, '_exceptions')} (import_id, dataset_key, source_row, kind, field, value, detail, candidates, row_id, link_column) VALUES ${tuples.join(', ')}`,
      params,
    )
  }
}

/** A most újra-feldolgozott sorok korábbi, nyitott kapcsolat-kivételei elavulnak. */
export async function supersedeLinkExceptions(sql: SqlExecutor, schema: string, datasetKey: string, rowIds: string[], importId: string) {
  for (let i = 0; i < rowIds.length; i += 5_000) {
    await sql.exec(
      `UPDATE ${qt(schema, '_exceptions')} SET status = 'superseded', resolution = jsonb_build_object('supersededBy', $3::text), resolved_at = now()
       WHERE dataset_key = $1 AND status = 'pending' AND link_column IS NOT NULL AND row_id = ANY($2::uuid[]) AND import_id <> $3::uuid`,
      [datasetKey, rowIds.slice(i, i + 5_000), importId],
    )
  }
}

export type ExceptionRecord = {
  id: string
  importId: string
  datasetKey: string
  sourceRow: number | null
  kind: string
  field: string | null
  value: string | null
  detail: string | null
  candidates: Array<{ id: string; label: string }> | null
  rowId: string | null
  linkColumn: string | null
  status: string
  resolution: unknown
  createdAt: string
}

function toException(row: Record<string, unknown>): ExceptionRecord {
  return {
    id: String(row.id),
    importId: String(row.import_id),
    datasetKey: String(row.dataset_key),
    sourceRow: row.source_row === null ? null : Number(row.source_row),
    kind: String(row.kind),
    field: (row.field as string | null) ?? null,
    value: (row.value as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    candidates: (row.candidates as ExceptionRecord['candidates']) ?? null,
    rowId: (row.row_id as string | null) ?? null,
    linkColumn: (row.link_column as string | null) ?? null,
    status: String(row.status),
    resolution: row.resolution ?? null,
    createdAt: iso(row.created_at)!,
  }
}

export async function listExceptions(
  sql: SqlExecutor,
  schema: string,
  filter: { importId?: string; datasetKey?: string; status?: string; limit: number },
): Promise<ExceptionRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.importId) {
    params.push(filter.importId)
    where.push(`import_id = $${params.length}::uuid`)
  }
  if (filter.datasetKey) {
    params.push(filter.datasetKey)
    where.push(`dataset_key = $${params.length}`)
  }
  if (filter.status) {
    params.push(filter.status)
    where.push(`status = $${params.length}`)
  }
  params.push(filter.limit)
  const rows = await sql.query(
    `SELECT id::text AS id, import_id::text AS import_id, dataset_key, source_row, kind, field, value, detail, candidates, row_id::text AS row_id, link_column, status, resolution, created_at
     FROM ${qt(schema, '_exceptions')} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, source_row LIMIT $${params.length}`,
    params,
  )
  return rows.map(toException)
}

export async function countOpenExceptions(sql: SqlExecutor, schema: string): Promise<Map<string, number>> {
  const rows = await sql.query<{ dataset_key: string; n: number }>(
    `SELECT dataset_key, count(*)::int AS n FROM ${qt(schema, '_exceptions')} WHERE status = 'pending' GROUP BY dataset_key`,
  )
  return new Map(rows.map((r) => [r.dataset_key, Number(r.n)]))
}

export async function getException(sql: SqlExecutor, schema: string, id: string): Promise<ExceptionRecord | null> {
  const rows = await sql.query(
    `SELECT id::text AS id, import_id::text AS import_id, dataset_key, source_row, kind, field, value, detail, candidates, row_id::text AS row_id, link_column, status, resolution, created_at
     FROM ${qt(schema, '_exceptions')} WHERE id = $1::uuid FOR UPDATE`,
    [id],
  )
  return rows[0] ? toException(rows[0]) : null
}

export async function refreshDatasetStats(sql: SqlExecutor, schema: string, dataset: { key: string; tableName: string }, lastImportId: string | null) {
  await sql.exec(
    `UPDATE ${qt(schema, '_datasets')} SET
       row_count = (SELECT count(*) FROM ${qt(schema, dataset.tableName)}),
       last_import_id = $2::uuid,
       published_at = (SELECT published_at FROM ${qt(schema, '_imports')} WHERE id = $2::uuid),
       updated_at = now()
     WHERE key = $1`,
    [dataset.key, lastImportId],
  )
}
