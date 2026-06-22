import type { MonitorSignalDraft } from './collectors/types'

/**
 * Determinisztikus, nem-LLM szűrő-DSL (Feature-spec — Proactive Monitor §5.3).
 *
 * A `filterConfig` egy kiértékelhető, auditálható szabály-objektum — nincs szabad
 * kódfuttatás. Üres konfiguráció → minden összegyűjtött jel átmegy (a collector
 * már csak érdemi jeleket bocsát ki). A „csak ha fontos" küszöb itt konfigurálható.
 */

export type FilterComparator = '>=' | '>' | '<=' | '<' | '==' | '!=' | 'between' | 'in'

export type FilterRule = {
  field: string
  cmp: FilterComparator
  value: unknown
}

export type FilterGroup = {
  op: 'and' | 'or'
  rules: FilterNode[]
}

export type FilterNode = FilterRule | FilterGroup

export type FilterEvalResult = {
  matched: boolean
  /** Ember-olvasható indok az audithoz / dry-runhoz. */
  reason: string
}

function isGroup(node: FilterNode): node is FilterGroup {
  return (node as FilterGroup).op === 'and' || (node as FilterGroup).op === 'or'
}

/**
 * A jelből + származtatott mezőkből épített kiértékelési kontextus.
 * Pontozott útvonallal címezhető: `severity`, `hoursUntilDue`, `businessHours`,
 * `payload.openCount` stb.
 */
export function buildEvalContext(
  signal: MonitorSignalDraft,
  now: Date,
): Record<string, unknown> {
  const hoursUntilDue =
    signal.dueBy instanceof Date
      ? (signal.dueBy.getTime() - now.getTime()) / 3_600_000
      : null
  const hourUtc = now.getUTCHours()
  return {
    severity: signal.severity,
    dueBy: signal.dueBy ?? null,
    hoursUntilDue,
    businessHours: hourUtc >= 6 && hourUtc < 16, // 08:00–18:00 CET ~ 06:00–16:00 UTC
    payload: signal.payload,
  }
}

function resolveField(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, ctx)
}

function compare(actual: unknown, cmp: FilterComparator, expected: unknown): boolean {
  switch (cmp) {
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    case 'in':
      return Array.isArray(expected) && expected.includes(actual)
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false
      const n = Number(actual)
      return Number.isFinite(n) && n >= Number(expected[0]) && n <= Number(expected[1])
    }
    default: {
      const a = Number(actual)
      const b = Number(expected)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      if (cmp === '>=') return a >= b
      if (cmp === '>') return a > b
      if (cmp === '<=') return a <= b
      if (cmp === '<') return a < b
      return false
    }
  }
}

function evalNode(node: FilterNode, ctx: Record<string, unknown>): boolean {
  if (isGroup(node)) {
    if (node.rules.length === 0) return true
    return node.op === 'and'
      ? node.rules.every((r) => evalNode(r, ctx))
      : node.rules.some((r) => evalNode(r, ctx))
  }
  return compare(resolveField(ctx, node.field), node.cmp, node.value)
}

/**
 * Egy jel kiértékelése a szűrő ellen. Tiszta függvény (input → bool + indok),
 * unit-tesztelhető. Üres / érvénytelen konfiguráció → match (csendes default a
 * collectorra hárul).
 */
export function evaluateFilter(
  filterConfig: unknown,
  signal: MonitorSignalDraft,
  now: Date,
): FilterEvalResult {
  const ctx = buildEvalContext(signal, now)
  if (!filterConfig || typeof filterConfig !== 'object' || Array.isArray(filterConfig)) {
    return { matched: true, reason: 'no filter (default match)' }
  }
  const node = filterConfig as FilterNode
  if (!isGroup(node) && !('field' in node)) {
    return { matched: true, reason: 'empty filter (default match)' }
  }
  const matched = evalNode(node, ctx)
  return {
    matched,
    reason: matched
      ? `severity=${signal.severity} passed filter`
      : `severity=${signal.severity} below threshold`,
  }
}
