/**
 * HTTP API lapozás — szerveroldali „fetch all pages → egy tömb".
 *
 * A modell ne page=1,2,3… tool-hívásokat sorozzon; egy `http_api_get_all`
 * hívás összegyűjti az oldalakat. Tool-budget és kontextus szempontjából ez
 * a nagy listák alapmintája.
 */

export const HTTP_API_GET_ALL_DEFAULTS = {
  pageParam: 'page',
  pageSizeParam: 'pageSize',
  pageSize: 100,
  startPage: 1,
  maxPages: 50,
} as const

const COMMON_ARRAY_KEYS = ['data', 'items', 'results', 'records', 'rows', 'ownerships'] as const

export type HttpApiPaginateQuery = Record<string, string | number | boolean>

export type HttpApiPaginatePlan = {
  pageParam: string
  pageSizeParam: string
  pageSize: number
  startPage: number
  maxPages: number
  arrayPath?: string
}

export type HttpApiPaginatePageResult = {
  ok: boolean
  status: number
  body: unknown
  /** 4xx / oversized soft hint a kliensről — failure errorbe kerül. */
  hint?: string
}

export type HttpApiPaginateOutcome = {
  ok: true
  items: unknown[]
  pageCount: number
  emptyTrailingPages: number
  lastStatus: number
}

export type HttpApiPaginateFailure = {
  ok: false
  error: string
  pageCount: number
  items: unknown[]
  lastStatus: number | null
}

function valueAtPath(root: unknown, path: string): unknown {
  if (!path) return root
  let cur: unknown = root
  for (const part of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Rekordtömb keresése API-válaszban (arrayPath vagy gyakori burkolók). */
export function extractPageItems(body: unknown, arrayPath?: string): unknown[] | null {
  if (arrayPath) {
    const at = valueAtPath(body, arrayPath)
    return Array.isArray(at) ? at : null
  }
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    for (const key of COMMON_ARRAY_KEYS) {
      const value = (body as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
    const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0] as unknown[]
  }
  return null
}

export function buildPageQuery(
  baseQuery: HttpApiPaginateQuery | undefined,
  plan: Pick<HttpApiPaginatePlan, 'pageParam' | 'pageSizeParam' | 'pageSize'>,
  page: number,
): HttpApiPaginateQuery {
  return {
    ...(baseQuery ?? {}),
    [plan.pageParam]: page,
    [plan.pageSizeParam]: plan.pageSize,
  }
}

export function resolveHttpApiPaginatePlan(
  input: Partial<HttpApiPaginatePlan> | undefined,
): HttpApiPaginatePlan {
  const pageSize =
    typeof input?.pageSize === 'number' && Number.isFinite(input.pageSize) && input.pageSize > 0
      ? Math.min(500, Math.round(input.pageSize))
      : HTTP_API_GET_ALL_DEFAULTS.pageSize
  const startPage =
    typeof input?.startPage === 'number' && Number.isFinite(input.startPage) && input.startPage >= 0
      ? Math.round(input.startPage)
      : HTTP_API_GET_ALL_DEFAULTS.startPage
  const maxPages =
    typeof input?.maxPages === 'number' && Number.isFinite(input.maxPages) && input.maxPages > 0
      ? Math.min(200, Math.round(input.maxPages))
      : HTTP_API_GET_ALL_DEFAULTS.maxPages
  return {
    pageParam:
      typeof input?.pageParam === 'string' && input.pageParam.trim()
        ? input.pageParam.trim()
        : HTTP_API_GET_ALL_DEFAULTS.pageParam,
    pageSizeParam:
      typeof input?.pageSizeParam === 'string' && input.pageSizeParam.trim()
        ? input.pageSizeParam.trim()
        : HTTP_API_GET_ALL_DEFAULTS.pageSizeParam,
    pageSize,
    startPage,
    maxPages,
    arrayPath:
      typeof input?.arrayPath === 'string' && input.arrayPath.trim()
        ? input.arrayPath.trim()
        : undefined,
  }
}

/**
 * Lapozás egy fetch callback-kel. Üres oldal → stop. Hibás HTTP → fail
 * (eddig gyűjtött items megmaradnak a failure-ben debughoz).
 *
 * Fontos: a maxPages elérése NEM csendes siker. Ha az utolsó bekért oldal
 * tele volt (effectivePageSize szerint), a lista nagyon valószínűleg csonka —
 * ok:false-szal jelezzük, különben a reconcile/egyéb utófeldolgozás teljes
 * adatként kezelné a hiányos uniót.
 *
 * A short-page heurisztika az upstream által visszakapott tényleges oldalhosszhoz
 * igazodik: ha a szerver a kért pageSize-t lefelé limitálja (pl. 500→100), az
 * első rövid oldal NEM zárja le a lapozást.
 */
export async function paginateHttpApiGet(input: {
  plan: HttpApiPaginatePlan
  baseQuery?: HttpApiPaginateQuery
  fetchPage: (query: HttpApiPaginateQuery) => Promise<HttpApiPaginatePageResult>
}): Promise<HttpApiPaginateOutcome | HttpApiPaginateFailure> {
  const items: unknown[] = []
  let pageCount = 0
  let emptyTrailingPages = 0
  let lastStatus: number | null = null
  let lastPageItemCount = 0
  /** A kért pageSize helyett az upstream által ténylegesen adott oldalhossz. */
  let effectivePageSize = input.plan.pageSize
  let stoppedEarly = false

  for (let page = input.plan.startPage; pageCount < input.plan.maxPages; page++) {
    const query = buildPageQuery(input.baseQuery, input.plan, page)
    const result = await input.fetchPage(query)
    pageCount += 1
    lastStatus = result.status

    if (!result.ok) {
      const hint = typeof result.hint === 'string' && result.hint.trim() ? ` — ${result.hint.trim()}` : ''
      return {
        ok: false,
        error: `HTTP ${result.status} a(z) ${page}. oldalon — a lapozás megszakadt${hint}`,
        pageCount,
        items,
        lastStatus,
      }
    }

    const pageItems = extractPageItems(result.body, input.plan.arrayPath)
    if (!pageItems) {
      return {
        ok: false,
        error: input.plan.arrayPath
          ? `nem található tömb a(z) "${input.plan.arrayPath}" útvonalon a(z) ${page}. oldalon`
          : `nem található rekordtömb a(z) ${page}. oldal válaszában (add meg az arrayPath-ot)`,
        pageCount,
        items,
        lastStatus,
      }
    }

    if (pageItems.length === 0) {
      emptyTrailingPages += 1
      stoppedEarly = true
      break
    }

    lastPageItemCount = pageItems.length
    items.push(...pageItems)

    // Első nemüres oldal rövidebb a kért pageSize-nál: vagy ez az összes adat,
    // vagy az upstream lefelé limitálta az oldalt. Ha van még maxPages keret,
    // peek-elünk (effective méret = megfigyelt hossz); ha nincs, a legacy
    // short-page stop érvényesül — ne jelentsünk hamis csonkolást.
    if (pageCount === 1 && pageItems.length < input.plan.pageSize) {
      effectivePageSize = pageItems.length
      if (pageCount >= input.plan.maxPages) {
        stoppedEarly = true
        break
      }
      continue
    }

    // Rövid oldal (az effective mérethez képest) → tipikusan ez az utolsó.
    if (pageItems.length < effectivePageSize) {
      stoppedEarly = true
      break
    }
  }

  // maxPages kimerült tele utolsó oldallal → csonka lista, ne hazudjunk ok:true-t.
  if (!stoppedEarly && lastPageItemCount >= effectivePageSize && pageCount >= input.plan.maxPages) {
    return {
      ok: false,
      error:
        `a lapozás a maxPages (${input.plan.maxPages}) limitnél megszakadt ` +
        `${items.length} begyűjtött elemmel — a lista valószínűleg csonka; ` +
        `növeld a maxPages értékét vagy szűkítsd a lekérdezést`,
      pageCount,
      items,
      lastStatus,
    }
  }

  return {
    ok: true,
    items,
    pageCount,
    emptyTrailingPages,
    lastStatus: lastStatus ?? 200,
  }
}
