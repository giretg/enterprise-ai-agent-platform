/**
 * Control-plane lista pagináció — közös limitek és take+1 / hasMore minta.
 * Full dump csak explicit `unbounded: true` mellett (admin/export).
 */

export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200
/** Kanban / aktív futások: egy oldalnyi biztonsági felső korlát. */
export const BOARD_LIST_LIMIT = 100

export type ListPageOpts = {
  limit?: number
  offset?: number
  /** Explicit teljes dump — kihagyja az alapértelmezett limitet. */
  unbounded?: boolean
}

export type ListPageResult<T> = {
  items: T[]
  hasMore: boolean
  nextOffset?: number
}

/** UI listákhoz: 1..MAX közé szorít; unbounded → undefined (nincs take). */
export function resolveListLimit(opts?: ListPageOpts): number | undefined {
  if (opts?.unbounded) return undefined
  const raw = opts?.limit ?? DEFAULT_LIST_LIMIT
  return Math.min(Math.max(1, raw), MAX_LIST_LIMIT)
}

export function resolveListOffset(opts?: ListPageOpts): number {
  return Math.max(0, opts?.offset ?? 0)
}

/**
 * Prisma `take` / `skip` a take+1 mintához. Ha nincs limit, üres objektum
 * (korlátlan findMany a full-dump hívóknak).
 */
export function prismaPageArgs(opts?: ListPageOpts): {
  take?: number
  skip?: number
  pageLimit?: number
} {
  const limit = resolveListLimit(opts)
  if (limit === undefined) return {}
  const offset = resolveListOffset(opts)
  return { take: limit + 1, skip: offset, pageLimit: limit }
}

export function toListPage<T>(rows: T[], pageLimit: number | undefined, offset: number): ListPageResult<T> {
  if (pageLimit === undefined) {
    return { items: rows, hasMore: false }
  }
  const hasMore = rows.length > pageLimit
  const items = hasMore ? rows.slice(0, pageLimit) : rows
  return {
    items,
    hasMore,
    nextOffset: hasMore ? offset + pageLimit : undefined,
  }
}
