/**
 * Élő adat megnyitáskor (#1083 §4.2–4.4): minden megnyitáskor ellenőriz, utána sorban,
 * közös bájtkerettel futtatja a kötéseket. Hibánál nincs régi vagy üres adat: a kötés
 * `status: error` blokkot kap. A sáv szövege itt készül, cellaérték nem kerül bele.
 */
import { warehouseMessage } from '@/lib/warehouse-labels'
import type { MiniAppDataBinding, MiniAppDataBindingInput, MiniAppLiveBlock } from './data-binding'
import { MINI_APP_BINDING_DEFAULT_ROWS, MINI_APP_LIVE_DATA_MAX_BYTES, MINI_APP_LIVE_LINK_TTL_MS } from './data-binding'
import type { MiniAppLiveBar } from './frame'
import type { MiniAppRecord } from './types'

export type BoundQueryResult = {
  columns: string[]
  columnLabels: string[]
  rows: unknown[][]
  truncated: boolean
  bytes: number
  dataAsOf: string | null
  warnings: Array<{ code: string; dataset: string; detail?: unknown }>
  schemaStatus: string
  version: number
  currentVersion: number
}

export type LiveDataPurpose = 'status' | 'content' | 'download'

export type MiniAppLiveDataDeps = {
  findMembership(tenantId: string, userId: string): Promise<{ role: string; status: string } | null>
  canReadWarehouse(role: string): boolean
  agentAccess(input: { tenantId: string; agentId: string }): Promise<string>
  findOwnerAgent(input: { tenantId: string; agentId: string }): Promise<{ retiredAt: Date | null } | null>
  runBoundQuery(
    actor: { tenantId: string; userId: string; role: string; agentId: string },
    input: { queryId: string; version: number | null; params: Record<string, unknown>; maxRows: number; maxBytes: number; audit: boolean },
  ): Promise<BoundQueryResult>
  /** A hibakód a blokkba kerül; ismeretlen hibánál általános kód. */
  errorCode(error: unknown): string
}

/**
 * §4.1 kötéskor: a tulajdonos saját, nem `broken` lekérdezése köthető, próbafuttatással.
 * A verzió a pillanatnyi aktuális, innentől rögzített (D7).
 */
export async function prepareBindings(
  deps: MiniAppLiveDataDeps,
  actor: { tenantId: string; userId: string; role: string; agentId: string },
  inputs: MiniAppDataBindingInput[],
): Promise<{ ok: true; bindings: MiniAppDataBinding[] } | { ok: false; code: string; extra?: Record<string, unknown> }> {
  if (!deps.canReadWarehouse(actor.role)) return { ok: false, code: 'warehouse_permission_denied', extra: { needed: 'read' } }
  if ((await deps.agentAccess({ tenantId: actor.tenantId, agentId: actor.agentId })) === 'off') return { ok: false, code: 'warehouse_agent_disabled' }
  const bindings: MiniAppDataBinding[] = []
  for (const input of inputs) {
    const params = input.params ?? {}
    try {
      const trial = await deps.runBoundQuery(actor, { queryId: input.queryId, version: null, params, maxRows: 1, maxBytes: MINI_APP_LIVE_DATA_MAX_BYTES, audit: false })
      bindings.push({ alias: input.alias, queryId: input.queryId, queryVersion: trial.version, params, maxRows: input.maxRows ?? MINI_APP_BINDING_DEFAULT_ROWS })
    } catch (error) {
      return { ok: false, code: deps.errorCode(error), extra: { alias: input.alias } }
    }
  }
  return { ok: true, bindings }
}

export type LiveAccess = { ok: true; role: string } | { ok: false; code: string }

const DENIED_MESSAGES: Record<string, string> = {
  app_archived: 'Ezt a mini appot archiválták.',
  link_without_user: 'Ez a link nem tartozik személyhez. Kérj új linket a platformon.',
  member_removed: 'A linket kérő felhasználó már nem tagja a szervezetnek.',
  no_read_permission: 'A linket kérő felhasználónak nincs joga az adattárház olvasásához.',
  agent_access_off: 'A riportot készítő munkatársnak már nincs hozzáférése az adattárházhoz.',
  owner_agent_unavailable: 'A riportot készítő munkatárs már nem aktív.',
  warehouse_not_ready: 'Az adattárház most nem elérhető.',
}

export function liveDeniedMessage(code: string): string {
  return DENIED_MESSAGES[code] ?? 'Az élő adat most nem jeleníthető meg.'
}

/** §4.3: ha bármelyik nem teljesül, adat nem megy ki. */
export async function checkLiveAccess(deps: MiniAppLiveDataDeps, app: Pick<MiniAppRecord, 'tenantId' | 'ownerAgentId' | 'status'>, requesterUserId: string | null | undefined): Promise<LiveAccess> {
  if (app.status !== 'active') return { ok: false, code: 'app_archived' }
  if (!requesterUserId) return { ok: false, code: 'link_without_user' }
  const membership = await deps.findMembership(app.tenantId, requesterUserId)
  if (!membership || membership.status !== 'active') return { ok: false, code: 'member_removed' }
  if (!deps.canReadWarehouse(membership.role)) return { ok: false, code: 'no_read_permission' }
  const owner = await deps.findOwnerAgent({ tenantId: app.tenantId, agentId: app.ownerAgentId })
  if (!owner || owner.retiredAt) return { ok: false, code: 'owner_agent_unavailable' }
  if ((await deps.agentAccess({ tenantId: app.tenantId, agentId: app.ownerAgentId })) === 'off') return { ok: false, code: 'agent_access_off' }
  return { ok: true, role: membership.role }
}

export type LiveDataLoad = {
  data: Record<string, MiniAppLiveBlock>
  bar: MiniAppLiveBar
  rows: number
}

const BLOCK_ERROR_MESSAGES: Record<string, string> = {
  saved_query_broken: 'Az egyik lekérdezés nem futtatható, javítani kell',
  saved_query_not_found: 'Az egyik lekérdezést archiválták vagy törölték',
  query_timeout: 'Az egyik lekérdezés túl sokáig futott, ezért leállt',
  warehouse_not_ready: 'Az adattárház most nem elérhető',
  warehouse_upgrade_failed: 'Az adattárház frissítés alatt áll, próbáld újra egy perc múlva',
}

function latest(values: Array<string | null>): Date | null {
  const times = values.flatMap((value) => (value ? [Date.parse(value)] : [])).filter((time) => Number.isFinite(time))
  return times.length > 0 ? new Date(Math.max(...times)) : null
}

/** A chatben az agent mondaná el; itt nincs, aki elmondja, ezért a sávon kötelező (§4.4). */
export function liveBarWarnings(input: {
  results: Array<{ alias: string; block: MiniAppLiveBlock; schemaStatus?: string; currentVersion?: number; queryVersion: number }>
}): string[] {
  const out: string[] = []
  const openExceptions = new Map<string, number>()
  const codes = new Set<string>()
  for (const { block } of input.results) {
    if (block.status !== 'ok') continue
    for (const warning of block.warnings) {
      if (warning.code === 'open_exceptions') {
        const count = (warning.detail as { count?: number } | undefined)?.count ?? 0
        openExceptions.set(warning.dataset, Math.max(openExceptions.get(warning.dataset) ?? 0, count))
      } else {
        codes.add(warning.code)
      }
    }
  }
  const unresolved = [...openExceptions.values()].reduce((sum, count) => sum + count, 0)
  if (unresolved > 0) out.push(`${unresolved} megoldatlan adategyezés`)
  if (codes.has('definitions_not_confirmed')) out.push('AI-javaslat, még nem megerősített mezők')
  if (codes.has('stale_source')) out.push(warehouseMessage('stale_source'))
  if (input.results.some((result) => result.schemaStatus === 'meaning_changed')) out.push('Egy használt mező jelentése megváltozott, ellenőrizd az eredményt')
  for (const result of input.results) {
    if (result.block.status === 'error') out.push(BLOCK_ERROR_MESSAGES[result.block.code] ?? 'Az egyik lekérdezés adata most nem érhető el')
    else if (result.block.truncated) out.push(`Az egyik lekérdezésből csak az első ${result.block.rows.length} sor látszik`)
  }
  if (input.results.some((result) => result.currentVersion !== undefined && result.currentVersion > result.queryVersion)) {
    out.push('Van újabb lekérdezés-verzió, ez az app még a régivel dolgozik')
  }
  return [...new Set(out)]
}

/** Sorban futtat közös kerettel; a `status` mód csak a sávhoz számol, naplót és futásszámot nem ír. */
export async function loadLiveData(
  deps: MiniAppLiveDataDeps,
  input: { app: Pick<MiniAppRecord, 'tenantId' | 'ownerAgentId'>; userId: string; role: string; bindings: MiniAppDataBinding[]; purpose: LiveDataPurpose },
): Promise<LiveDataLoad> {
  const actor = { tenantId: input.app.tenantId, userId: input.userId, role: input.role, agentId: input.app.ownerAgentId }
  const data: Record<string, MiniAppLiveBlock> = {}
  const results: Parameters<typeof liveBarWarnings>[0]['results'] = []
  let remaining = MINI_APP_LIVE_DATA_MAX_BYTES
  let rows = 0
  const loadTimes: Array<string | null> = []
  for (const binding of input.bindings) {
    try {
      const result = await deps.runBoundQuery(actor, {
        queryId: binding.queryId,
        version: binding.queryVersion,
        params: binding.params,
        maxRows: binding.maxRows,
        maxBytes: remaining,
        audit: input.purpose === 'content',
      })
      remaining = Math.max(0, remaining - result.bytes)
      rows += result.rows.length
      loadTimes.push(result.dataAsOf)
      const block: MiniAppLiveBlock = {
        status: 'ok',
        columns: result.columns,
        columnLabels: result.columnLabels,
        rows: result.rows,
        truncated: result.truncated,
        dataAsOf: result.dataAsOf,
        warnings: result.warnings,
      }
      data[binding.alias] = block
      results.push({ alias: binding.alias, block, schemaStatus: result.schemaStatus, currentVersion: result.currentVersion, queryVersion: binding.queryVersion })
    } catch (error) {
      const block: MiniAppLiveBlock = { status: 'error', code: deps.errorCode(error) }
      data[binding.alias] = block
      results.push({ alias: binding.alias, block, queryVersion: binding.queryVersion })
    }
  }
  const mode = input.purpose === 'download' ? 'download' : 'live'
  return { data, rows, bar: { mode, lastLoadAt: latest(loadTimes), warnings: liveBarWarnings({ results }) } }
}

/** D6: a kötött app linkje legfeljebb 1 óráig él. A régebben kiadott, hosszabb token nem fogadható el. */
export function liveLinkTooLong(expiresAt: number, now: number): boolean {
  return expiresAt - now > MINI_APP_LIVE_LINK_TTL_MS + 60_000
}

export type LiveRateLimiter = (key: string, limitPerMinute: number) => boolean

/** ponytail: példányonkénti memória-limit, ahogy a nyilvános chatnél; a lekérdezés-időkorlát a valódi plafon. */
export function createLiveRateLimiter(now: () => number = Date.now): LiveRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (key, limitPerMinute) => {
    const time = now()
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < time) buckets.delete(k)
    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt < time) {
      buckets.set(key, { count: 1, resetAt: time + 60_000 })
      return true
    }
    bucket.count += 1
    return bucket.count <= limitPerMinute
  }
}

/** Egy megnyitás kétszer számít (keret + tartalom): a linkre szabott keret kb. 15 megnyitás percenként. */
export const LIVE_RATE_PER_LINK = 30
export const LIVE_RATE_PER_APP = 120
