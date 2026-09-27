/**
 * HTTP API connector → modellnek szóló katalógus / hiba / hatékonysági szöveg.
 * Tiszta függvények — MCP enterprise tool hívások és a HttpApiClient ezeket hívja.
 */

import { COMMON_HTTP_PAGE_SIZES, requiresHttpApiGetAll } from '@/lib/http-api-pagination-signals'
import type { TenantLanguage } from '@/lib/tenant-language'

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

/** 4xx válasz mellé: ne tippeljen új query neveket. */
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

/** Túl nagy JSON: soft jelzés — a teljes body megmarad (get_all / archive / extract). */
export function buildHttpApiOversizedResponseHint(input: {
  originalChars: number
  maxChars: number
  language?: TenantLanguage
}): string {
  if ((input.language ?? 'hu') === 'en') {
    return (
      `Large response (${input.originalChars} chars, soft limit ${input.maxChars}). ` +
      'The full body is preserved for the tool pipeline (get_all / archive). For the model: ' +
      "don't dump it into context — use the documented query/filter, http_api_get_all, " +
      'or tool_result_extract on the workspace copy; no chunked file_read.'
    )
  }
  return (
    `A válasz nagy (${input.originalChars} karakter, soft limit ${input.maxChars}). ` +
    'A teljes body megmaradt a tool-pipeline számára (get_all / archive). A modellnek: ' +
    'ne dumpold a kontextusba — használd a dokumentált query/szűrőt, http_api_get_all-t, ' +
    'vagy tool_result_extract-et a munkaterületi másolaton; ne chunkolt file_read-et.'
  )
}

/**
 * Hard truncate meta — csak ha a JSON nem parse-olható / nem-JSON túl nagy.
 * Sikeres parse-olt JSON-nál NE ezt használd: a get_all+extract a teljes body-t igényli.
 */
export function buildHttpApiTruncationBody(input: {
  originalChars: number
  maxChars: number
  preview: string
  language?: TenantLanguage
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
    hint: en
      ? `Response too large (${input.originalChars} chars, limit ${input.maxChars}), and it could not be ` +
        'preserved as full JSON. Use: (1) a documented query/filter, ' +
        '(2) http_api_get_all with a smaller pageSize, (3) a more specific path (single record), ' +
        '(4) for a list: tool_result_extract on the workspace copy.'
      : `A válasz túl nagy (${input.originalChars} karakter, limit ${input.maxChars}), és nem sikerült ` +
        'teljes JSON-ként megőrizni. Használj: (1) dokumentált query/szűrőt, ' +
        '(2) http_api_get_all kisebb pageSize-zal, (3) specifikusabb path-ot (egyedi rekord), ' +
        '(4) ha lista kell: tool_result_extract a munkaterületi másolaton.',
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
      '- After archiving a large JSON: tool_result_extract (arrayPath if needed) → reconcile/xlsx; NEVER chunk the same file with file_read. For ownership reconciliation the get_all tool-output path works directly too.',
    ].join('\n')
  }
  return [
    'Hatékony HTTP API használat:',
    '- Először a connector endpoint-katalógus dokumentált query/path paramétereit használd — ne találj ki mezőneveket (422/400 után sem).',
    '- Lapozott nagy listához http_api_get_all (egy hívás), ne page=1,2,3… http_api_get sorozatot.',
    '- Ownership / partner / ownerships / nagy névsor: KÖTELEZŐEN http_api_get_all — a sima get gyakran csak az első oldalt (pl. 50 sort) adja.',
    '- Időszak / összehasonlítás / top-N analitika: aggregált vagy report/query végpont + period paramok; NE dumpold a teljes order/account listát, és NE helyettesíts más proxy-metrikával (pl. rolling health), ha a kért periódus-adat hiányzik — mondd ki.',
    '- Szűretlen listázás után ne húzz végig tucatnyi egyedi részlet-endpointot; előbb top-N / search / filter.',
    '- Nagy JSON archive után: tool_result_extract (arrayPath ha kell) → reconcile/xlsx; SOHA ne chunkold file_read-del ugyanazt a fájlt. Ownership egyeztetéshez a get_all tool-outputs path közvetlenül is jó.',
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
