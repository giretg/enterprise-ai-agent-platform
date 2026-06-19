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

function resolveInitialMode(): DatabaseMode {
  const env = process.env.DATABASE_MODE?.trim().toLowerCase()
  if (env === 'test') return 'test'
  return 'production'
}

export function isTestDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL_TEST?.trim())
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
    const direct = process.env.DIRECT_URL_TEST?.trim()
    const pooled = process.env.DATABASE_URL_TEST?.trim()
    const url = direct ?? pooled
    if (!url) {
      throw new Error('DIRECT_URL_TEST / DATABASE_URL_TEST nincs beállítva')
    }
    return url
  }
  const direct = process.env.DIRECT_URL?.trim()
  const pooled = process.env.DATABASE_URL?.trim()
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
    const testUrl = process.env.DATABASE_URL_TEST?.trim()
    if (!testUrl) {
      throw new Error('DATABASE_URL_TEST nincs beállítva — teszt mód nem használható')
    }
    return testUrl
  }
  const prodUrl = process.env.DATABASE_URL?.trim()
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
      lastRefreshAt = Date.now()
      return activeMode
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

export function createPrismaClientForUrl(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
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
    mode === 'test' ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL
  return {
    ...state,
    mode,
    testConfigured: isTestDatabaseConfigured(),
    activeUrlHost: hostFromDatabaseUrl(activeUrl),
  }
}
