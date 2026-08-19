/**
 * HTTP API lapozás — protokollfüggetlen „fetch all pages → egy tömb".
 * A stratégia endpoint-capability; a hálózati hívást a hívó injektálja.
 */
import type { HttpPagination } from '@/domain/provisioning/connector-config'

export const HTTP_API_GET_ALL_LIMITS = { pageSize: 100, maxPages: 50 } as const
const COMMON_ARRAY_KEYS = ['data', 'items', 'results', 'records', 'rows', 'ownerships'] as const

export type HttpApiPaginateQuery = Record<string, string | number | boolean>
type HttpApiCursor = string | number | boolean
type PlanLimits = { pageSize: number; maxPages: number }
export type HttpApiPaginatePlan = HttpPagination & PlanLimits

export type HttpApiPaginatePageResult = {
  ok: boolean
  status: number
  body: unknown
  hint?: string
  linkHeader?: string
}

export type HttpApiPaginationStopReason =
  | 'empty_page'
  | 'short_page'
  | 'total_reached'
  | 'next_cursor_absent'
  | 'next_link_absent'
  | 'not_paginated'
  | 'max_pages'

export type HttpApiPaginateOutcome = {
  ok: true
  items: unknown[]
  pageCount: number
  emptyTrailingPages: number
  lastStatus: number
  paginationComplete: boolean
  stopReason: HttpApiPaginationStopReason
  strategy: HttpPagination['kind']
}

export type HttpApiPaginateFailure = {
  ok: false
  error: string
  pageCount: number
  items: unknown[]
  lastStatus: number | null
  strategy: HttpPagination['kind']
}

export function valueAtPath(root: unknown, path: string): unknown {
  if (!path || path === '$') return root
  let cur: unknown = root
  const parts = path.split('.').filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    const remaining = parts.slice(index).join('.')
    if (Object.prototype.hasOwnProperty.call(cur, remaining)) {
      return (cur as Record<string, unknown>)[remaining]
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

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

/** Legacy segéd explicit page-stratégiához; globális defaultként nem használható. */
export function buildPageQuery(
  baseQuery: HttpApiPaginateQuery | undefined,
  plan: { pageParam: string; pageSizeParam?: string; pageSize: number },
  page: number,
): HttpApiPaginateQuery {
  return {
    ...(baseQuery ?? {}),
    [plan.pageParam]: page,
    ...(plan.pageSizeParam ? { [plan.pageSizeParam]: plan.pageSize } : {}),
  }
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
  return Math.min(max, candidate)
}

export function resolveHttpApiPaginatePlan(input: {
  pagination?: HttpPagination
  pageSize?: number
  maxPages?: number
  pageParam?: string
  pageSizeParam?: string
  startPage?: number
  arrayPath?: string
}): HttpApiPaginatePlan | null {
  const maxPages = boundedPositive(input.maxPages, HTTP_API_GET_ALL_LIMITS.maxPages, 200)
  if (input.pagination) {
    const defaultPageSize = 'defaultPageSize' in input.pagination
      ? input.pagination.defaultPageSize
      : undefined
    const maxPageSize = 'maxPageSize' in input.pagination
      ? input.pagination.maxPageSize
      : undefined
    const pageSize = boundedPositive(
      input.pageSize,
      defaultPageSize ?? HTTP_API_GET_ALL_LIMITS.pageSize,
      Math.min(maxPageSize ?? 500, 500),
    )
    return { ...input.pagination, pageSize, maxPages }
  }
  // Régi, explicit page-konfiguráció. Paraméter nélküli hívásnál nincs találgatás.
  if (!input.pageParam) return null
  const pageSize = boundedPositive(input.pageSize, HTTP_API_GET_ALL_LIMITS.pageSize, 500)
  return {
    kind: 'page',
    pageParam: input.pageParam?.trim() || 'page',
    ...(input.pageSizeParam?.trim() ? { pageSizeParam: input.pageSizeParam.trim() } : {}),
    firstPage: typeof input.startPage === 'number' ? Math.max(0, Math.round(input.startPage)) : 1,
    itemsPath: input.arrayPath?.trim() || 'data',
    pageSize,
    maxPages,
  }
}

export function paginationQueryParamNames(plan: HttpApiPaginatePlan): string[] {
  return [
    plan.kind === 'cursor' ? plan.cursorParam : null,
    plan.kind === 'cursor' ? plan.limitParam : null,
    plan.kind === 'page' ? plan.pageParam : null,
    plan.kind === 'page' ? plan.pageSizeParam : null,
    plan.kind === 'offset' ? plan.offsetParam : null,
    plan.kind === 'offset' ? plan.limitParam : null,
  ].filter((name): name is string => Boolean(name))
}

export function undocumentedPaginationQueryParams(
  plan: HttpApiPaginatePlan,
  documented: readonly { name: string }[] | undefined,
): string[] {
  if (!documented) return []
  const names = new Set(documented.map((param) => param.name.toLowerCase()))
  return paginationQueryParamNames(plan).filter((name) => !names.has(name.toLowerCase()))
}

function numericAtPath(body: unknown, path: string | undefined): number | null {
  const value = path ? valueAtPath(body, path) : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nextLinkFromHeader(header: string | undefined): string | null {
  if (!header) return null
  for (const segment of header.split(',')) {
    const match = segment.match(/<([^>]+)>\s*;[^,]*\brel\s*=\s*["']?next["']?/i)
    if (match) return match[1]
  }
  return null
}

function requestFromNextLink(input: {
  link: string
  currentPath?: string
  baseUrl?: string
}): { path?: string; query: HttpApiPaginateQuery } | null {
  try {
    const connectorBase = new URL(input.baseUrl ?? 'https://pagination.invalid')
    const basePath = connectorBase.pathname.replace(/\/$/, '')
    const currentPath = `/${(input.currentPath ?? '').replace(/^\/+/, '')}`
    const currentUrl = new URL(`${basePath}${currentPath}`, `${connectorBase.origin}/`)
    const url = new URL(input.link, currentUrl)
    if (url.origin !== connectorBase.origin) return null
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null
    const connectorPath = basePath ? url.pathname.slice(basePath.length) || '/' : url.pathname
    const query: HttpApiPaginateQuery = {}
    for (const [key, value] of url.searchParams) query[key] = value
    return { path: connectorPath, query }
  } catch {
    return null
  }
}

function pageFingerprint(items: unknown[]): string {
  try {
    return JSON.stringify(items)
  } catch {
    return String(items.length)
  }
}

export async function paginateHttpApiGet(input: {
  plan: HttpApiPaginatePlan
  path?: string
  baseUrl?: string
  baseQuery?: HttpApiPaginateQuery
  fetchPage: (query: HttpApiPaginateQuery, path?: string) => Promise<HttpApiPaginatePageResult>
}): Promise<HttpApiPaginateOutcome | HttpApiPaginateFailure> {
  const { plan } = input
  const items: unknown[] = []
  const seenCursors = new Set<string>()
  const seenPages = new Set<string>()
  let pageCount = 0
  let emptyTrailingPages = 0
  let lastStatus: number | null = null
  let cursor: HttpApiCursor | null = null
  let nextLinkQuery: HttpApiPaginateQuery | null = null
  let nextLinkPath: string | undefined = input.path
  let stopReason: HttpApiPaginationStopReason = 'max_pages'

  while (pageCount < plan.maxPages) {
    let query: HttpApiPaginateQuery = { ...(input.baseQuery ?? {}) }
    if (plan.kind === 'cursor') {
      if (plan.limitParam) query[plan.limitParam] = plan.pageSize
      if (cursor !== null) query[plan.cursorParam] = cursor
    } else if (plan.kind === 'page') {
      query = buildPageQuery(query, plan, plan.firstPage + pageCount)
    } else if (plan.kind === 'offset') {
      query[plan.offsetParam] = plan.firstOffset + items.length
      query[plan.limitParam] = plan.pageSize
    } else if (plan.kind === 'next_link' && nextLinkQuery) {
      query = { ...query, ...nextLinkQuery }
    }

    const result = await input.fetchPage(query, nextLinkPath)
    pageCount += 1
    lastStatus = result.status
    if (!result.ok) {
      const hint = typeof result.hint === 'string' && result.hint.trim() ? ` — ${result.hint.trim()}` : ''
      return {
        ok: false,
        error: `HTTP ${result.status} a(z) ${pageCount}. oldalon — a lapozás megszakadt${hint}`,
        pageCount, items, lastStatus, strategy: plan.kind,
      }
    }

    const pageItems = extractPageItems(result.body, plan.itemsPath)
    if (!pageItems) {
      return {
        ok: false,
        error: `nem található rekordtömb a(z) "${plan.itemsPath}" útvonalon a(z) ${pageCount}. oldalon`,
        pageCount, items, lastStatus, strategy: plan.kind,
      }
    }
    if (pageItems.length === 0) {
      emptyTrailingPages += 1
      stopReason = 'empty_page'
      break
    }

    const fingerprint = pageFingerprint(pageItems)
    if (seenPages.has(fingerprint)) {
      return {
        ok: false,
        error: `a(z) ${pageCount}. oldal megismételte egy korábbi oldal tartalmát`,
        pageCount, items, lastStatus, strategy: plan.kind,
      }
    }
    seenPages.add(fingerprint)
    items.push(...pageItems)

    const total = 'totalPath' in plan ? numericAtPath(result.body, plan.totalPath) : null
    if (total !== null && items.length >= total) {
      stopReason = 'total_reached'
      break
    }
    if (plan.kind === 'none') {
      stopReason = 'not_paginated'
      break
    }
    if (plan.kind === 'cursor') {
      const rawNext = valueAtPath(result.body, plan.nextCursorPath)
      const next = typeof rawNext === 'string'
        ? rawNext.trim() || null
        : typeof rawNext === 'number' && Number.isFinite(rawNext)
          ? rawNext
          : typeof rawNext === 'boolean'
            ? rawNext
            : null
      if (next === null) {
        stopReason = 'next_cursor_absent'
        break
      }
      const cursorKey = `${typeof next}:${String(next)}`
      if (seenCursors.has(cursorKey)) {
        return {
          ok: false,
          error: `a cursor megismétlődött (${next})`,
          pageCount, items, lastStatus, strategy: plan.kind,
        }
      }
      seenCursors.add(cursorKey)
      cursor = next
      continue
    }
    if (plan.kind === 'next_link') {
      const rawNext = plan.nextLinkPath ? valueAtPath(result.body, plan.nextLinkPath) : null
      const link = typeof rawNext === 'string' && rawNext.trim()
        ? rawNext.trim()
        : plan.linkHeaderRel === 'next'
          ? nextLinkFromHeader(result.linkHeader)
          : null
      if (!link) {
        stopReason = 'next_link_absent'
        break
      }
      const nextRequest = requestFromNextLink({
        link,
        currentPath: nextLinkPath,
        baseUrl: input.baseUrl,
      })
      if (!nextRequest) {
        return {
          ok: false,
          error: 'a következő oldal linkje nem használható biztonságosan ezen a connectoron',
          pageCount, items, lastStatus, strategy: plan.kind,
        }
      }
      nextLinkPath = nextRequest.path
      nextLinkQuery = nextRequest.query
      continue
    }
    const shortPageProvesCompletion =
      plan.kind === 'offset' || (plan.kind === 'page' && Boolean(plan.pageSizeParam))
    if (shortPageProvesCompletion && pageItems.length < plan.pageSize) {
      stopReason = 'short_page'
      break
    }
  }

  return {
    ok: true,
    items,
    pageCount,
    emptyTrailingPages,
    lastStatus: lastStatus ?? 200,
    paginationComplete: stopReason !== 'max_pages',
    stopReason,
    strategy: plan.kind,
  }
}
