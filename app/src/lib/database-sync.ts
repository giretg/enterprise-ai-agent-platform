import { Client } from 'pg'
import {
  directDatabaseUrlForMode,
  isNeonBranchRestoreConfigured,
  isTestDatabaseConfigured,
} from '@/lib/database-mode'

const COPY_BATCH_SIZE = 500
const NEON_API_BASE = 'https://console.neon.tech/api/v2'
const NEON_POLL_INTERVAL_MS = 1_500
const NEON_POLL_TIMEOUT_MS = 120_000

export type DatabaseSyncMethod = 'neon_restore' | 'pg_copy'

export type DatabaseSyncResult = {
  method: DatabaseSyncMethod
  tableCount: number
  rowCount: number
  durationMs: number
  operationId?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollNeonOperation(projectId: string, apiKey: string, operationId: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < NEON_POLL_TIMEOUT_MS) {
    const res = await fetch(`${NEON_API_BASE}/projects/${projectId}/operations/${operationId}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Neon művelet lekérdezés sikertelen (${res.status}): ${text}`)
    }
    const data = (await res.json()) as { operation?: { status?: string; error?: string } }
    const status = data.operation?.status
    if (status === 'finished') return
    if (status === 'failed' || status === 'error') {
      throw new Error(data.operation?.error ?? 'Neon restore művelet sikertelen')
    }
    await sleep(NEON_POLL_INTERVAL_MS)
  }
  throw new Error('Neon restore időtúllépés — ellenőrizd a Neon Console-t')
}

async function syncViaNeonRestore(): Promise<DatabaseSyncResult> {
  const apiKey = process.env.NEON_API_KEY?.trim()
  const projectId = process.env.NEON_PROJECT_ID?.trim()
  const testBranchId = process.env.NEON_TEST_BRANCH_ID?.trim()
  const parentBranchId = process.env.NEON_PRODUCTION_BRANCH_ID?.trim()
  if (!apiKey || !projectId || !testBranchId || !parentBranchId) {
    throw new Error('Neon API nincs teljesen konfigurálva')
  }

  const started = Date.now()
  const res = await fetch(
    `${NEON_API_BASE}/projects/${projectId}/branches/${testBranchId}/restore`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ source_branch_id: parentBranchId }),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Neon restore sikertelen (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { operations?: Array<{ id?: string }> }
  const operationId = data.operations?.[0]?.id
  if (operationId) {
    await pollNeonOperation(projectId, apiKey, operationId)
  }

  return {
    method: 'neon_restore',
    tableCount: 0,
    rowCount: 0,
    durationMs: Date.now() - started,
    operationId,
  }
}

async function resetIdentitySequences(client: Client): Promise<void> {
  await client.query(`
    DO $$
    DECLARE
      rec RECORD;
      seq_name text;
      max_val bigint;
    BEGIN
      FOR rec IN
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_default LIKE 'nextval%'
      LOOP
        seq_name := pg_get_serial_sequence(
          format('%I.%I', rec.table_schema, rec.table_name),
          rec.column_name
        );
        IF seq_name IS NOT NULL THEN
          EXECUTE format(
            'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
            rec.column_name, rec.table_schema, rec.table_name
          ) INTO max_val;
          IF max_val > 0 THEN
            PERFORM setval(seq_name, max_val, true);
          END IF;
        END IF;
      END LOOP;
    END $$;
  `)
}

async function copyTable(
  prod: Client,
  test: Client,
  tablename: string,
): Promise<number> {
  const { rows } = await prod.query(`SELECT * FROM "${tablename}"`)
  if (rows.length === 0) return 0

  const columns = Object.keys(rows[0] as Record<string, unknown>)
  const colList = columns.map((c) => `"${c}"`).join(', ')
  let copied = 0

  for (let offset = 0; offset < rows.length; offset += COPY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COPY_BATCH_SIZE)
    const values: unknown[] = []
    const groups = batch.map((row, rowIdx) => {
      const placeholders = columns.map((col, colIdx) => {
        values.push((row as Record<string, unknown>)[col])
        return `$${rowIdx * columns.length + colIdx + 1}`
      })
      return `(${placeholders.join(', ')})`
    })
    await test.query(
      `INSERT INTO "${tablename}" (${colList}) VALUES ${groups.join(', ')}`,
      values,
    )
    copied += batch.length
  }

  return copied
}

async function syncViaPgCopy(): Promise<DatabaseSyncResult> {
  const prodUrl = directDatabaseUrlForMode('production')
  const testUrl = directDatabaseUrlForMode('test')

  const prod = new Client({ connectionString: prodUrl })
  const test = new Client({ connectionString: testUrl })
  await prod.connect()
  await test.connect()

  const started = Date.now()
  let tableCount = 0
  let rowCount = 0

  try {
    await test.query('BEGIN')
    await test.query("SET session_replication_role = 'replica'")

    const { rows: tables } = await prod.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `)

    if (tables.length === 0) {
      throw new Error('Nincs másolandó tábla az éles adatbázisban')
    }

    const quoted = tables.map((t) => `"${t.tablename}"`).join(', ')
    await test.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`)

    for (const { tablename } of tables) {
      const copied = await copyTable(prod, test, tablename)
      tableCount += 1
      rowCount += copied
    }

    await resetIdentitySequences(test)
    await test.query('COMMIT')
  } catch (error) {
    await test.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await prod.end().catch(() => {})
    await test.end().catch(() => {})
  }

  return {
    method: 'pg_copy',
    tableCount,
    rowCount,
    durationMs: Date.now() - started,
  }
}

/** Éles → teszt teljes adatszinkron (Neon restore, vagy pg másolás tartalék). */
export async function syncProductionDatabaseToTest(): Promise<DatabaseSyncResult> {
  if (!isTestDatabaseConfigured()) {
    throw new Error('A teszt adatbázis nincs konfigurálva (DATABASE_URL_TEST hiányzik)')
  }

  if (isNeonBranchRestoreConfigured()) {
    try {
      return await syncViaNeonRestore()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[database-sync] Neon restore failed, falling back to pg copy:', message)
    }
  }

  return syncViaPgCopy()
}

export function describeSyncMethod(method: DatabaseSyncMethod): string {
  return method === 'neon_restore'
    ? 'Neon branch restore (szülő branch pillanatnyi állapota)'
    : 'PostgreSQL tábla-másolás (fallback)'
}
