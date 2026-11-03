/**
 * HTTP API connector → modellnek szóló katalógus / hiba / hatékonysági szöveg.
 * Tiszta függvények — MCP enterprise tool hívások és a HttpApiClient ezeket hívja.
 */

import { COMMON_HTTP_PAGE_SIZES, requiresHttpApiGetAll } from '@/lib/http-api-pagination-signals'
import type { TenantLanguage } from '@/lib/tenant-language'
import { SAVED_RESULT_PREVIEW_CHARS, type SavedHttpResultInfo } from './http-api-saved-result'

export type HttpApiCatalogParam = {
  name: string
  required: boolean
  type?: string
  description?: string
}

export type HttpApiCatalogEndpoint = {
  method?: string
  path?: string
  description?: string
  name?: string
  risk?: string
  access?: string
  queryParams?: HttpApiCatalogParam[]
  pathParams?: HttpApiCatalogParam[]
  headerParams?: Array<{ name: string; required: boolean }>
  parameters?: Array<{
    name?: string
    in?: string
    required?: boolean
    type?: string
    description?: string
  }>
}

/** Query param lista emberi formában (katalógus / 4xx hint). */
export function formatHttpApiQueryParamsHint(
  params: readonly HttpApiCatalogParam[] | undefined,
  language: TenantLanguage = 'hu',
): string {
  if (!params || params.length === 0) return ''
  const parts = params.map((p) => {
    const type = p.type ? `:${p.type}` : ''
    const req = p.required ? (language === 'en' ? ', required' : ', kötelező') : ''
    const desc = p.description ? ` — ${p.description}` : ''
    return `${p.name}${type}${req}${desc}`
  })
  return `query: ${parts.join('; ')}`
}

/** Path param lista (ha a template nem önmagában elég). */
export function formatHttpApiPathParamsHint(
  params: readonly HttpApiCatalogParam[] | undefined,
): string {
  if (!params || params.length === 0) return ''
  const parts = params.map((p) => {
    const type = p.type ? `:${p.type}` : ''
    return `${p.name}${type}`
  })
  return `path: ${parts.join(', ')}`
}

/**
 * Endpoint sor a modell-katalógushoz: method path, description, query/path/header.
 * Titkot nem tartalmaz.
 */
export function formatHttpApiEndpointCatalogSuffix(
  endpoint: HttpApiCatalogEndpoint,
  language: TenantLanguage = 'hu',
): string {
  const query =
    formatHttpApiQueryParamsHint(resolveQueryParams(endpoint), language) ||
    ''
  const pathParams = formatHttpApiPathParamsHint(resolvePathParams(endpoint))
  const headers = formatCallerHeaderHint(endpoint, language)
  const bits = [query, pathParams, headers].filter(Boolean)
  return bits.length > 0 ? ` — ${bits.join(' | ')}` : ''
}

/** 4xx válasz mellé: ne tippeljen új query neveket, és 401-et ne nézze MCP-újrahitelesítésnek. */
export function buildHttpApiClientErrorHint(input: {
  status: number
  endpoint?: HttpApiCatalogEndpoint | null
  usedQueryKeys?: readonly string[]
  /** #717 B réteg — alapértelmezés `hu` = mai szöveg. */
  language?: TenantLanguage
}): string | undefined {
  const language: TenantLanguage = input.language ?? 'hu'
  const en = language === 'en'
  if (input.status < 400 || input.status >= 500) return undefined
  if (input.status === 401 || input.status === 403) {
    return (
      `A céges API elutasította a kérést (HTTP ${input.status}). ` +
      'Ez nem MCP- vagy connector-újrahitelesítés — ne kérj token-frissítést, ' +
      'és ne mutass „hitelesítsük” gombot, hacsak a válasz nem érvénytelen API-kulcsot jelez. ' +
      'A nyomkövető fejléceket (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) a platform injektálja: ' +
      'ne add át a headers mezőben, és ne próbáld args.agentId-vel pótolni.'
    )
  }
  const allowed = resolveQueryParams(input.endpoint ?? undefined)
  if (!allowed || allowed.length === 0) {
    if (input.status === 422 || input.status === 400) {
      return en
        ? 'Request rejected. Do not invent new query field names — use only parameters ' +
          'from the connector endpoint catalog. If no documented filter exists, ' +
          'look for an aggregated/report endpoint instead of dumping the whole list.'
        : 'A kérés elutasítva. Ne találj ki új query mezőneveket — csak a connector ' +
          'endpoint-katalógusában szereplő paramétereket használd. Ha nincs dokumentált ' +
          'szűrő, aggregált/report végpontot keress, ne dumpold a teljes listát.'
    }
    return undefined
  }
  const allowedHint = formatHttpApiQueryParamsHint(allowed, language)
  const used = (input.usedQueryKeys ?? []).filter(Boolean)
  const unknown = used.filter(
    (k) => !allowed.some((p) => p.name.toLowerCase() === k.toLowerCase()),
  )
  const parts = en
    ? [
        `Allowed query parameters on this endpoint: ${allowedHint}.`,
        'Do not guess other field names.',
      ]
    : [
        `Engedélyezett query paraméterek ezen az endpointon: ${allowedHint}.`,
        'Ne tippelj más mezőneveket.',
      ]
  if (unknown.length > 0) {
    parts.push(
      en
        ? `Unknown / undocumented query keys in the call: ${unknown.join(', ')}.`
        : `Ismeretlen / nem dokumentált query kulcsok a hívásban: ${unknown.join(', ')}.`,
    )
  }
  return parts.join(' ')
}

/** Túl nagy JSON a get_all lapozás belső ágán: a teljes page-body megmarad, a modellnek hint. */
export function buildHttpApiOversizedResponseHint(input: {
  originalChars: number
  maxChars: number
  language?: TenantLanguage
}): string {
  if ((input.language ?? 'hu') === 'en') {
    return (
      `Large response (${input.originalChars} chars, limit ${input.maxChars}). ` +
      'The full page is kept for pagination. For the model: do not dump it into context — ' +
      'use a documented query/filter or an aggregated/report endpoint.'
    )
  }
  return (
    `A válasz nagy (${input.originalChars} karakter, limit ${input.maxChars}). ` +
    'A teljes oldal a lapozáshoz megmaradt. A modellnek: ne dumpold a kontextusba — ' +
    'használj dokumentált query/szűrőt vagy aggregált/report végpontot.'
  )
}

/** Riport-/aggregáló végpont: ott az „aggregált végpontot használj” tanács zsákutca (#1071). */
const AGGREGATE_PATH_RE = /report|riport|kimutat|aggregat|summary|stats|statistic|analytics|pivot/i

export function isAggregateHttpPath(path: string | undefined): boolean {
  return !!path && AGGREGATE_PATH_RE.test(path.split('?')[0]!)
}

function truncationHint(input: { originalChars: number; maxChars: number; en: boolean; aggregatePath?: boolean }): string {
  if (input.aggregatePath) {
    return input.en
      ? `Response too large (${input.originalChars} chars, limit ${input.maxChars}). ` +
          'This already is an aggregated/report endpoint: the result itself is large. ' +
          'Split it into smaller calls (shorter period, fewer dimensions) and combine the parts, ' +
          'or tell the user that the full breakdown does not fit. Do not build a report from this partial preview.'
      : `A válasz túl nagy (${input.originalChars} karakter, limit ${input.maxChars}). ` +
          'Ez már aggregált/riport végpont: maga az eredmény nagy. ' +
          'Bontsd kisebb hívásokra (rövidebb időszak, kevesebb dimenzió), és fűzd össze a részeket, ' +
          'vagy mondd meg a felhasználónak, hogy a teljes bontás így nem fér el. Ebből a részleges előnézetből ne készíts kimutatást.'
  }
  return input.en
    ? `Response too large (${input.originalChars} chars, limit ${input.maxChars}). ` +
      'The full body was not sent to the model. Use a documented query/filter, ' +
      'or an aggregated/report endpoint (a smaller pageSize does not help: the limit is on the whole output). ' +
      'Do not retry the same unfiltered path.'
    : `A válasz túl nagy (${input.originalChars} karakter, limit ${input.maxChars}). ` +
      'A teljes body nem megy a modell-kontextusba. Használj dokumentált query/szűrőt, ' +
      'vagy aggregált/report végpontot (kisebb pageSize nem segít: a limit a teljes kimenetre vonatkozik). ' +
      'Ugyanazt a szűretlen path-ot ne hívd újra.'
}

/** #1071: a teljes válasz el van mentve — a modell innen dolgozzon, ne kérdezze le újra. */
function savedResultHint(input: { originalChars: number; maxChars: number; saved: SavedHttpResultInfo; en: boolean }): string {
  const { saved } = input
  const rows = saved.rowCount != null ? (input.en ? `, ${saved.rowCount} rows` : `, ${saved.rowCount} sor`) : ''
  return input.en
    ? `The response is large (${input.originalChars} chars, limit ${input.maxChars}), but the FULL data is saved ` +
        `(savedResultId ${saved.savedResultId}${rows}); you only see a preview. Do not call the API again or narrow the request because of the size. ` +
        `For a file (Excel/CSV) call document_export with format "xlsx" and savedResultId "${saved.savedResultId}" — the platform builds it from the full data; never type the rows yourself. ` +
        `To read or analyse the data, page through it with http_api_saved_read (savedResultId, offset, limit). Only the requesting user can access it, for 7 days.`
    : `A válasz nagy (${input.originalChars} karakter, limit ${input.maxChars}), de a TELJES adat el van mentve ` +
        `(savedResultId ${saved.savedResultId}${rows}); te csak egy előnézetet látsz. A méret miatt ne hívd újra az API-t, és ne szűkítsd a kérést. ` +
        `Fájlhoz (Excel/CSV) hívd a document_export-ot format "xlsx" és savedResultId "${saved.savedResultId}" értékkel — a platform a teljes adatból készíti el; a sorokat soha ne gépeld be. ` +
        `Az adat olvasásához, elemzéséhez lapozz a http_api_saved_read-del (savedResultId, offset, limit). Csak a kérő user éri el, 7 napig.`
}

/**
 * Hard truncate meta a modellnek / MCP-válasznak. A teljes JSON nem kerül a kontextusba.
 */
export function buildHttpApiTruncationBody(input: {
  originalChars: number
  maxChars: number
  preview: string
  language?: TenantLanguage
  /** A hívott path — riport-végpontnál más a tanács (#1071). */
  path?: string
}): {
  truncated: true
  originalChars: number
  maxChars: number
  preview: string
  hint: string
} {
  const en = (input.language ?? 'hu') === 'en'
  return {
    truncated: true,
    originalChars: input.originalChars,
    maxChars: input.maxChars,
    preview: input.preview,
    hint: truncationHint({
      originalChars: input.originalChars,
      maxChars: input.maxChars,
      en,
      aggregatePath: isAggregateHttpPath(input.path),
    }),
  }
}

/**
 * MCP / modell-válasz kemény plafonja. A get_all belső lapozás a teljes page-body-t
 * megkaphatja; amit a modell lát, az soha nem lehet maxChars fölött. #1071: ha a teljes
 * válasz el van mentve (`saved`), a modell rövidebb előnézetet és a mentett adat azonosítóját kapja.
 */
export function capHttpApiResultForModel(input: {
  result: unknown
  maxChars: number
  language?: TenantLanguage
  /** A hívott path (get/request válaszában nincs benne) — riport-végpontnál más a tanács. */
  path?: string
  saved?: SavedHttpResultInfo | null
}): unknown {
  const maxChars = Math.max(1, Math.floor(input.maxChars))
  let json: string
  try {
    json = JSON.stringify(input.result) ?? ''
  } catch {
    return input.result
  }
  if (json.length <= maxChars) return input.result
  const src =
    input.result && typeof input.result === 'object' && !Array.isArray(input.result)
      ? (input.result as Record<string, unknown>)
      : null
  const saved = input.saved ?? null
  const truncated = buildHttpApiTruncationBody({
    originalChars: json.length,
    maxChars,
    preview: json.slice(0, saved ? Math.min(maxChars, SAVED_RESULT_PREVIEW_CHARS) : maxChars),
    language: input.language,
    path: input.path ?? (typeof src?.path === 'string' ? src.path : undefined),
  })
  if (saved) {
    truncated.hint = savedResultHint({ originalChars: json.length, maxChars, saved, en: (input.language ?? 'hu') === 'en' })
  }
  return {
    ...(typeof src?.ok === 'boolean' ? { ok: src.ok } : { ok: true }),
    ...(typeof src?.status === 'number' ? { status: src.status } : {}),
    ...(typeof src?.path === 'string' ? { path: src.path } : {}),
    ...(typeof src?.itemCount === 'number' ? { itemCount: src.itemCount } : {}),
    ...(typeof src?.pageCount === 'number' ? { pageCount: src.pageCount } : {}),
    // A hibaüzenet rövid és a modellnek kell — a vágás ne nyelje el.
    ...(typeof src?.error === 'string' ? { error: src.error.slice(0, 2_000) } : {}),
    truncated: true,
    originalChars: truncated.originalChars,
    maxChars: truncated.maxChars,
    ...(saved ? { savedResult: saved } : {}),
    preview: truncated.preview,
    // Hiba-hint (4xx/5xx magyarázat) marad; sikeres ágon a kliens soft-hintje ellentmondana.
    hint:
      src?.ok === false && typeof src.hint === 'string'
        ? `${src.hint.slice(0, 2_000)} ${truncated.hint}`
        : truncated.hint,
  }
}

/**
 * Minden körben látható HTTP hatékonysági útmutató (nem connector-specifikus).
 * Analitikus / multi-period feladatokra is általános.
 */
export function buildHttpApiEfficiencyGuidance(language: TenantLanguage = 'hu'): string {
  if (language === 'en') {
    return [
      'Efficient HTTP API use:',
      '- First use the documented query/path parameters from the connector endpoint catalog — never invent field names (not after 422/400 either).',
      '- For a large paged list use http_api_get_all (one call), not a page=1,2,3… http_api_get series.',
      '- Ownership / partner / ownerships / large rosters: http_api_get_all is MANDATORY — plain get often returns only the first page (e.g. 50 rows).',
      '- Period / comparison / top-N analytics: aggregated or report/query endpoint + period params; do NOT dump the full order/account list, and do NOT substitute another proxy metric (e.g. rolling health) when the requested period data is missing — say so.',
      '- After an unfiltered listing, do not walk through dozens of individual detail endpoints; top-N / search / filter first.',
      '- When a response is too large, the platform saves the full data (savedResult.savedResultId): build the Excel with document_export + savedResultId, read it page by page with http_api_saved_read — do not type rows into a tool call and do not query it again.',
    ].join('\n')
  }
  return [
    'Hatékony HTTP API használat:',
    '- Először a connector endpoint-katalógus dokumentált query/path paramétereit használd — ne találj ki mezőneveket (422/400 után sem).',
    '- Lapozott nagy listához http_api_get_all (egy hívás), ne page=1,2,3… http_api_get sorozatot.',
    '- Ownership / partner / ownerships / nagy névsor: KÖTELEZŐEN http_api_get_all — a sima get gyakran csak az első oldalt (pl. 50 sort) adja.',
    '- Időszak / összehasonlítás / top-N analitika: aggregált vagy report/query végpont + period paramok; NE dumpold a teljes order/account listát, és NE helyettesíts más proxy-metrikával (pl. rolling health), ha a kért periódus-adat hiányzik — mondd ki.',
    '- Szűretlen listázás után ne húzz végig tucatnyi egyedi részlet-endpointot; előbb top-N / search / filter.',
    '- Túl nagy válasznál a platform elmenti a teljes adatot (savedResult.savedResultId): Excelt a document_export + savedResultId készít, olvasni a http_api_saved_read-del lapozva lehet — a sorokat ne gépeld be eszközhívásba, és ne kérdezd le újra.',
  ].join('\n')
}

/**
 * http_api_get után: ha a válasz úgy néz ki, mint egyetlen lapozott oldal,
 * tereld a modellt get_all-ra (mielőtt extract→egyeztetés hamis „Új rekordokat" gyárt).
 */
export function buildHttpApiLikelyPaginatedHint(input: {
  path: string
  body: unknown
  itemCount?: number | null
  language?: TenantLanguage
}): string | null {
  const en = (input.language ?? 'hu') === 'en'
  const path = (input.path ?? '').trim()
  if (!path) return null

  let count = typeof input.itemCount === 'number' ? input.itemCount : null
  if (count == null) {
    const items = extractRecordArray(input.body)
    count = items?.length ?? null
  }
  if (count == null || count <= 0) return null

  const listPath = requiresHttpApiGetAll(path)
  const roundPage = COMMON_HTTP_PAGE_SIZES.has(count)
  if (!listPath && !roundPage) return null
  if (!listPath && count < 20) return null

  if (listPath || roundPage) {
    return en
      ? `WARNING: "${path}" returned ${count} rows` +
          (roundPage ? ` (common pageSize: ${count})` : '') +
          '. This is often ONLY the first page. For a large roster / ownership list call ' +
          'http_api_get_all again with the same path — do not tool_result_extract this for reconciliation ' +
          'until the full list is in.'
      : `FIGYELEM: a(z) "${path}" válasz ${count} sort tartalmaz` +
          (roundPage ? ` (gyakori pageSize: ${count})` : '') +
          '. Ez gyakran CSAK az első oldal. Nagy névsor / ownership listához hívd ÚJRA ' +
          'http_api_get_all-lal ugyanezzel a path-dal — ne tool_result_extract-eld ezt egyeztetéshez, ' +
          'amíg a teljes lista nincs meg.'
  }
  return null
}

function extractRecordArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return null
  for (const key of ['data', 'items', 'results', 'records', 'rows', 'ownerships', 'body']) {
    const value = (body as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value
  }
  const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray)
  return arrays.length === 1 ? (arrays[0] as unknown[]) : null
}

function resolveQueryParams(
  endpoint: HttpApiCatalogEndpoint | undefined,
): HttpApiCatalogParam[] | undefined {
  if (!endpoint) return undefined
  if (Array.isArray(endpoint.queryParams) && endpoint.queryParams.length > 0) {
    return endpoint.queryParams
  }
  return paramsWithIn(endpoint, 'query')
}

function resolvePathParams(
  endpoint: HttpApiCatalogEndpoint | undefined,
): HttpApiCatalogParam[] | undefined {
  if (!endpoint) return undefined
  if (Array.isArray(endpoint.pathParams) && endpoint.pathParams.length > 0) {
    return endpoint.pathParams
  }
  return paramsWithIn(endpoint, 'path')
}

function paramsWithIn(
  endpoint: HttpApiCatalogEndpoint,
  location: 'query' | 'path',
): HttpApiCatalogParam[] | undefined {
  if (!Array.isArray(endpoint.parameters)) return undefined
  const out: HttpApiCatalogParam[] = []
  for (const raw of endpoint.parameters) {
    if (!raw || typeof raw.name !== 'string' || raw.in !== location) continue
    out.push({
      name: raw.name,
      required: raw.required === true || location === 'path',
      ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

function formatCallerHeaderHint(endpoint: HttpApiCatalogEndpoint, language: TenantLanguage = 'hu'): string {
  const en = language === 'en'
  const source = Array.isArray(endpoint.headerParams)
    ? endpoint.headerParams
    : Array.isArray(endpoint.parameters)
      ? endpoint.parameters.filter((p) => p && p.in === 'header' && typeof p.name === 'string')
      : []
  const headers = source.flatMap((param) => {
    if (!param || typeof param.name !== 'string' || !param.name.trim()) return []
    const req = param.required === true ? (en ? ' (required)' : ' (kötelező)') : en ? ' (optional)' : ' (opcionális)'
    return [`${param.name}${req}`]
  })
  return headers.length > 0 ? (en ? `Caller headers: ${headers.join(', ')}` : `Hívói fejlécek: ${headers.join(', ')}`) : ''
}
