import type { SkillContent, SkillRequirement } from '@/lib/skill/skill-content'

/** Egy skill-verzió diff-változása (WP-7, playbook-diff mintára). */
export type SkillDiffChange = {
  category: 'instructions' | 'triggerKeywords' | 'parameters' | 'requires' | 'runtimeHints'
  kind: 'added' | 'removed' | 'modified'
  detail: string
  risk: 'high' | 'medium' | 'low' | 'none'
}

export type SkillDiff = {
  changes: SkillDiffChange[]
  highestRisk: 'high' | 'medium' | 'low' | 'none'
  counts: Record<string, number>
}

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3 } as const

function maxRisk(a: SkillDiffChange['risk'], b: SkillDiffChange['risk']): SkillDiffChange['risk'] {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

function diffStringLists(
  category: 'instructions' | 'triggerKeywords',
  before: string[],
  after: string[],
): SkillDiffChange[] {
  const changes: SkillDiffChange[] = []
  const maxLen = Math.max(before.length, after.length)
  for (let i = 0; i < maxLen; i++) {
    const a = before[i]
    const b = after[i]
    if (a === b) continue
    if (a === undefined) {
      changes.push({
        category,
        kind: 'added',
        detail: `[${i + 1}] ${truncate(b)}`,
        risk: category === 'instructions' ? 'medium' : 'low',
      })
    } else if (b === undefined) {
      changes.push({
        category,
        kind: 'removed',
        detail: `[${i + 1}] ${truncate(a)}`,
        risk: category === 'instructions' ? 'medium' : 'low',
      })
    } else {
      changes.push({
        category,
        kind: 'modified',
        detail: `[${i + 1}] ${truncate(a)} → ${truncate(b)}`,
        risk: category === 'instructions' ? 'medium' : 'low',
      })
    }
  }
  return changes
}

function diffParameters(
  before: SkillContent['parameters'],
  after: SkillContent['parameters'],
): SkillDiffChange[] {
  const changes: SkillDiffChange[] = []
  const byName = (items: SkillContent['parameters']) =>
    new Map(items.map((p) => [p.name, p.description]))
  const a = byName(before)
  const b = byName(after)
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const descA = a.get(name)
    const descB = b.get(name)
    if (descA === descB) continue
    if (descA === undefined) {
      changes.push({ category: 'parameters', kind: 'added', detail: name, risk: 'low' })
    } else if (descB === undefined) {
      changes.push({ category: 'parameters', kind: 'removed', detail: name, risk: 'low' })
    } else {
      changes.push({
        category: 'parameters',
        kind: 'modified',
        detail: `${name}: leírás módosult`,
        risk: 'low',
      })
    }
  }
  return changes
}

function diffRequires(before: SkillRequirement[], after: SkillRequirement[]): SkillDiffChange[] {
  const changes: SkillDiffChange[] = []
  const byTool = (items: SkillRequirement[]) => new Map(items.map((r) => [r.toolName, r.reason]))
  const a = byTool(before)
  const b = byTool(after)
  for (const tool of new Set([...a.keys(), ...b.keys()])) {
    const reasonA = a.get(tool)
    const reasonB = b.get(tool)
    if (reasonA === reasonB) continue
    if (reasonA === undefined) {
      changes.push({
        category: 'requires',
        kind: 'added',
        detail: tool,
        risk: 'high',
      })
    } else if (reasonB === undefined) {
      changes.push({
        category: 'requires',
        kind: 'removed',
        detail: tool,
        risk: 'high',
      })
    } else {
      changes.push({
        category: 'requires',
        kind: 'modified',
        detail: `${tool}: indoklás módosult`,
        risk: 'medium',
      })
    }
  }
  return changes
}

/**
 * Futási keret változása. A jóváhagyó ezt LÁTNIA kell: a keret emelése több időt
 * és több eszközhívást — tehát több költséget — enged egy fordulónak, a
 * `preferredMode: task` pedig átteszi a futást a boardra.
 */
function diffRuntimeHints(
  before: SkillContent['runtimeHints'],
  after: SkillContent['runtimeHints'],
): SkillDiffChange[] {
  const changes: SkillDiffChange[] = []
  const fields = ['maxWallClockMs', 'maxToolCalls', 'preferredMode', 'allowAttachments'] as const
  for (const field of fields) {
    const a = before?.[field]
    const b = after?.[field]
    if (a === b) continue
    const label = (value: string | number | boolean | undefined) =>
      value === undefined
        ? field === 'allowAttachments'
          ? 'engedett (alapérték)'
          : 'nincs megadva'
        : field === 'maxWallClockMs'
          ? `${Math.round(Number(value) / 1000)} mp`
          : field === 'allowAttachments'
            ? value === false
              ? 'tiltott'
              : 'engedett'
            : String(value)
    changes.push({
      category: 'runtimeHints',
      kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      detail: `${field}: ${label(a)} → ${label(b)}`,
      risk: 'medium',
    })
  }
  return changes
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/** Két skill-verzió tartalmának összehasonlítása (content + requires). */
export function diffSkillVersions(
  base: { content: SkillContent; requires: SkillRequirement[] },
  target: { content: SkillContent; requires: SkillRequirement[] },
): SkillDiff {
  const changes: SkillDiffChange[] = [
    ...diffStringLists('instructions', base.content.instructions, target.content.instructions),
    ...diffStringLists('triggerKeywords', base.content.triggerKeywords, target.content.triggerKeywords),
    ...diffParameters(base.content.parameters, target.content.parameters),
    ...diffRuntimeHints(base.content.runtimeHints, target.content.runtimeHints),
    ...diffRequires(base.requires, target.requires),
  ]

  let highestRisk: SkillDiffChange['risk'] = 'none'
  const counts: Record<string, number> = {}
  for (const c of changes) {
    highestRisk = maxRisk(highestRisk, c.risk)
    counts[c.category] = (counts[c.category] ?? 0) + 1
  }

  return { changes, highestRisk, counts }
}
