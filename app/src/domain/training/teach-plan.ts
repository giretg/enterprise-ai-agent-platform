import { parseMemoryItems, serializeMemoryItems } from './memory-items'

export type TeachPlan = {
  added: string[]
  rewritten: Array<{ from: string; to: string }>
  removed: string[]
}

export function emptyTeachPlan(teaching: string): TeachPlan {
  const text = teaching.trim()
  return { added: text ? [text] : [], rewritten: [], removed: [] }
}

export function resolveExistingItem(existing: string[], ref: string): string | null {
  const needle = ref.trim()
  if (!needle) return null
  const exact = existing.find((item) => item === needle)
  if (exact) return exact
  const trimmed = existing.find((item) => item.trim() === needle)
  if (trimmed) return trimmed
  const matches = existing.filter((item) => item.includes(needle) || needle.includes(item.trim()))
  return matches.length === 1 ? matches[0]! : null
}

export function sanitizeTeachPlan(existing: string[], plan: TeachPlan, teaching: string): TeachPlan {
  const rewritten: Array<{ from: string; to: string }> = []
  const used = new Set<string>()
  for (const row of plan.rewritten) {
    const from = resolveExistingItem(existing, row.from)
    const to = (row.to ?? '').trim()
    if (!from || !to || used.has(from)) continue
    used.add(from)
    rewritten.push({ from, to })
  }
  const removed: string[] = []
  for (const ref of plan.removed) {
    const item = resolveExistingItem(existing, ref)
    if (!item || used.has(item)) continue
    used.add(item)
    removed.push(item)
  }
  const rewrittenTos = new Set(rewritten.map((row) => row.to))
  const added = plan.added
    .map((item) => item.trim())
    .filter((item) => item && !rewrittenTos.has(item))
  if (rewritten.length === 0 && removed.length === 0 && added.length === 0) {
    return emptyTeachPlan(teaching)
  }
  return { added, rewritten, removed }
}

export function applyTeachPlan(baseContent: string, plan: TeachPlan): string {
  const items = parseMemoryItems(baseContent)
  const removed = new Set(plan.removed)
  const rewriteMap = new Map(plan.rewritten.map((row) => [row.from, row.to]))
  const next: string[] = []
  for (const item of items) {
    if (removed.has(item)) continue
    next.push(rewriteMap.get(item) ?? item)
  }
  for (const added of plan.added) {
    if (!next.includes(added)) next.push(added)
  }
  return serializeMemoryItems(next)
}

export function changeSummaryFromTeachPlan(
  existing: string[],
  plan: TeachPlan,
): { added: string[]; removed: string[]; rewritten: Array<{ from: string; to: string }>; unchanged: string[] } {
  const rewrittenFrom = new Set(plan.rewritten.map((row) => row.from))
  const removed = plan.removed.filter((item) => !rewrittenFrom.has(item))
  const dropped = new Set([...removed, ...rewrittenFrom])
  return {
    added: plan.added,
    removed,
    rewritten: plan.rewritten,
    unchanged: existing.filter((item) => !dropped.has(item)),
  }
}
