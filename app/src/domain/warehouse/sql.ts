/**
 * SQL-végrehajtó + azonosító-kapu (#984 §4: „DDL csak engedélyezett
 * műveletlistából”). Minden azonosító (séma/tábla/oszlop) a kódban képzett,
 * regexszel ellenőrzött és idézőjelezett; minden érték paraméter.
 */
import type { PrismaClient } from '@prisma/client'
import type { WarehouseFieldType } from './value-parse'

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<number>
}

export type RunOptions = { readOnly?: boolean; timeoutMs?: number; statementTimeoutMs?: number }

export interface WarehouseDatabase {
  /** Egy tranzakció; `readOnly` mellett a DB is tilt minden írást. */
  run<T>(fn: (sql: SqlExecutor) => Promise<T>, options?: RunOptions): Promise<T>
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const SCHEMA = /^wh_[0-9a-f]{32}$/

export class UnsafeIdentifierError extends Error {
  constructor(name: string) {
    super(`unsafe identifier: ${name.slice(0, 80)}`)
    this.name = 'UnsafeIdentifierError'
  }
}

export function qi(name: string): string {
  if (!IDENT.test(name)) throw new UnsafeIdentifierError(name)
  return `"${name}"`
}

export function qs(schema: string): string {
  if (!SCHEMA.test(schema)) throw new UnsafeIdentifierError(schema)
  return `"${schema}"`
}

export function qt(schema: string, table: string): string {
  return `${qs(schema)}.${qi(table)}`
}

/** A tenant sémaneve a szerveroldali tenantId-ből — soha nem a kliens/AI argumentumából (§8). */
export function warehouseSchemaName(tenantId: string): string {
  const hex = tenantId.toLowerCase().replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new UnsafeIdentifierError(tenantId)
  return `wh_${hex}`
}

export function datasetTableName(key: string): string {
  return `ds_${key}`
}

export const SQL_TYPE: Record<WarehouseFieldType | 'link', string> = {
  text: 'text',
  integer: 'bigint',
  decimal: 'numeric',
  date: 'date',
  boolean: 'boolean',
  link: 'uuid',
}

/** Postgres paraméterkorlát (65535) alatt marad a többsoros INSERT/VALUES. */
export function batchSize(columns: number): number {
  return Math.max(1, Math.min(1_000, Math.floor(60_000 / Math.max(1, columns))))
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'bigint' ? Number(value) : value
  return out
}

/** Prisma-alapú végrehajtó; a `client` lehet a platform-kliens vagy egy külön adattárház-kliens. */
export function prismaWarehouseDatabase(client: PrismaClient): WarehouseDatabase {
  return {
    async run(fn, options = {}) {
      return client.$transaction(
        async (tx) => {
          if (options.readOnly) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
          const statementTimeout = Math.max(1_000, Math.min(options.statementTimeoutMs ?? 60_000, 300_000))
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeout}`)
          const executor: SqlExecutor = {
            async query<T>(sql: string, params: unknown[] = []) {
              const rows = (await tx.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[]
              return rows.map(normalizeRow) as T[]
            },
            async exec(sql: string, params: unknown[] = []) {
              return tx.$executeRawUnsafe(sql, ...params)
            },
          }
          return fn(executor)
        },
        { timeout: options.timeoutMs ?? 120_000, maxWait: 10_000 },
      )
    },
  }
}
