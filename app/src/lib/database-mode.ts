import { PrismaClient } from '@prisma/client'

export type DatabaseMode = 'production' | 'test'

export const DATABASE_MODE_KEY = 'database.mode'
export const DATABASE_SYNC_KEY = 'database.sync_status'

export type DatabaseSyncStatus = {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  method: 'neon_restore' | 'pg_copy' | null
  startedAt: string | null
  completedAt: string | null
  startedById: string | null
  error: string | null
  tableCount: number | null
  rowCount: number | null
  durationMs: number | null
}

const MODE_REFRESH_TTL_MS = 15_000

export type DatabaseModeState = {
  mode: DatabaseMode
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_STATE: DatabaseModeState = {
  mode: 'production',
  updatedById: null,
  updatedAt: null,
}

let activeMode: DatabaseMode = resolveInitialMode()
let lastRefreshAt = 0
let refreshInFlight: Promise<DatabaseMode> | null = null

/** Secret Manager / .env másolás gyakran idézőjeleket hagy a connection stringen. */
function normalizeDatabaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function resolveInitialMode(): DatabaseMode {
  const env = process.env.DATABASE_MODE?.trim().toLowerCase()
  if (env === 'test') return 'test'
  return 'production'
}

export function isTestDatabaseConfigured(): boolean {
  return Boolean(normalizeDatabaseUrl(process.env.DATABASE_URL_TEST))
}

export function isNeonBranchRestoreConfigured(): boolean {
  return Boolean(
    process.env.NEON_API_KEY?.trim() &&
      process.env.NEON_PROJECT_ID?.trim() &&
      process.env.NEON_TEST_BRANCH_ID?.trim() &&
      process.env.NEON_PRODUCTION_BRANCH_ID?.trim(),
  )
}

export function directDatabaseUrlForMode(mode: DatabaseMode): string {
  if (mode === 'test') {
    const direct = normalizeDatabaseUrl(process.env.DIRECT_URL_TEST)
    const pooled = normalizeDatabaseUrl(process.env.DATABASE_URL_TEST)
    const url = direct ?? pooled
    if (!url) {
      throw new Error('DIRECT_URL_TEST / DATABASE_URL_TEST nincs beállítva')
    }
    return url
  }
  const direct = normalizeDatabaseUrl(process.env.DIRECT_URL)
  const pooled = normalizeDatabaseUrl(process.env.DATABASE_URL)
  const url = direct ?? pooled
  if (!url) {
    throw new Error('DIRECT_URL / DATABASE_URL nincs beállítva')
  }
  return url
}

export function getActiveDatabaseMode(): DatabaseMode {
  return activeMode
}

export function setActiveDatabaseMode(mode: DatabaseMode): void {
  activeMode = mode
  lastRefreshAt = Date.now()
}

export function databaseUrlForMode(mode: DatabaseMode): string {
  if (mode === 'test') {
    const testUrl = normalizeDatabaseUrl(process.env.DATABASE_URL_TEST)
    if (!testUrl) {
      throw new Error('DATABASE_URL_TEST nincs beállítva — teszt mód nem használható')
    }
    return testUrl
  }
  const prodUrl = normalizeDatabaseUrl(process.env.DATABASE_URL)
  if (!prodUrl) {
    throw new Error('DATABASE_URL nincs beállítva')
  }
  return prodUrl
}

export function configDatabaseUrl(): string {
  return databaseUrlForMode('production')
}

export function parseDatabaseModeState(raw: unknown): DatabaseModeState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE }
  const value = raw as Partial<DatabaseModeState>
  return {
    mode: value.mode === 'test' ? 'test' : 'production',
    updatedById: typeof value.updatedById === 'string' ? value.updatedById : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

export function serializeDatabaseModeState(state: DatabaseModeState): DatabaseModeState {
  return {
    mode: state.mode,
    updatedById: state.updatedById,
    updatedAt: state.updatedAt,
  }
}

export async function refreshActiveDatabaseMode(
  readFromConfig: () => Promise<DatabaseModeState>,
): Promise<DatabaseMode> {
  const now = Date.now()
  if (now - lastRefreshAt < MODE_REFRESH_TTL_MS) return activeMode
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const state = await readFromConfig()
      if (state.mode === 'test' && !isTestDatabaseConfigured()) {
        activeMode = 'production'
      } else {
        activeMode = state.mode
      }
      return activeMode
    } finally {
      // Hibánál is TTL-t nyitunk: DB-kiesés alatt a `prisma` proxy property-access-enként
      // hívna ide, és minden egyes hívás új platformSetting-lekérdezést indítana a már
      // elérhetetlen adatbázis felé. A mód ilyenkor az utolsó ismert értéken marad.
      lastRefreshAt = Date.now()
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

/**
 * A Prisma alapértelmezett `connection_limit`-je `num_cpus * 2 + 1`. Cloud Runon
 * `cpu: 1` mellett ez 3 kapcsolat, miközben a `concurrency` 40 — a poolra váró
 * kérések `pool_timeout` hibába futnának. A poolt ezért explicitté tesszük, de a
 * connection stringben megadott értéket sosem írjuk felül.
 *
 * A `connection_limit` szándékosan alacsony (serverless-hangolás): minél kevesebb
 * kapcsolatot tart nyitva egy instance, annál gyakrabban forog mindegyik, így
 * ritkábban éri el őket a Neon pooler `server_idle_timeout`-ja / a compute
 * auto-suspend. A "holtan hagyott" pooled kapcsolat a `prisma:error Error in
 * PostgreSQL connection: Error { kind: Closed }` fő forrása. Ha burst alatt kevés
 * az 5 kapcsolat (P2024 pool_timeout a logban), a `PRISMA_CONNECTION_LIMIT`
 * env-vel emelhető deploy nélkül is.
 */
const POOL_DEFAULTS: Record<string, string> = {
  connection_limit: process.env.PRISMA_CONNECTION_LIMIT?.trim() || '5',
  pool_timeout: '20',
  connect_timeout: '10',
}

/**
 * Neon pooled (PgBouncer, transaction mode) végpont — a `-pooler` aldomain a
 * megkülönböztető jel (`ep-xxx-pooler.<régió>.aws.neon.tech`). A direkt végponton
 * (migráció, `DIRECT_URL`) nincs `-pooler`, oda nem tesszük ki a flaget.
 */
function isNeonPooledHost(hostname: string): boolean {
  return /-pooler\./.test(hostname)
}

export function applyPoolDefaults(url: string): string {
  try {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(POOL_DEFAULTS)) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value)
    }
    // PgBouncer transaction-pooling mögött a Prisma nevesített prepared statement
    // cache-e ütközik (`prepared statement "s0" already exists`), amit a pooler a
    // szerver-kapcsolat bontásával "büntet" → a query engine `kind: Closed`-ot lát
    // a következő lekérdezésnél. A `pgbouncer=true` kikapcsolja a nevesített
    // prepared statementeket. Csak a runtime (pooled) kliensre hat: a migráció a
    // `DIRECT_URL`-t nyersen, ezen a függvényen kívül használja.
    if (isNeonPooledHost(parsed.hostname) && !parsed.searchParams.has('pgbouncer')) {
      parsed.searchParams.set('pgbouncer', 'true')
    }
    return parsed.toString()
  } catch {
    // Nem parse-olható URL — a Prisma úgyis beszédesebb hibát ad rá, mint mi.
    return url
  }
}

export function createPrismaClientForUrl(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: applyPoolDefaults(url) } },
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

export type DatabaseModeInfo = DatabaseModeState & {
  testConfigured: boolean
  activeUrlHost: string | null
}

export function hostFromDatabaseUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url.replace(/^postgresql:/, 'http:')).hostname
  } catch {
    return null
  }
}

export function buildDatabaseModeInfo(state: DatabaseModeState): DatabaseModeInfo {
  const mode = state.mode === 'test' && !isTestDatabaseConfigured() ? 'production' : state.mode
  const activeUrl =
    mode === 'test'
      ? normalizeDatabaseUrl(process.env.DATABASE_URL_TEST)
      : normalizeDatabaseUrl(process.env.DATABASE_URL)
  return {
    ...state,
    mode,
    testConfigured: isTestDatabaseConfigured(),
    activeUrlHost: hostFromDatabaseUrl(activeUrl),
  }
}
