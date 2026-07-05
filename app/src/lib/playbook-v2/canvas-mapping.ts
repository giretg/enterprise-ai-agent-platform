/**
 * Governed Flow Builder — spec ⇄ canvas kétirányú vetület (WP-2, D1/D2).
 *
 * A canvas NEM új adatmodell: a meglévő `steps[] / gates[] / roles[] + onComplete routing`
 * szerkezetből DERIVÁLT nézet (D1). Ez a modul tisztán (React Flow nélkül) állítja elő a
 * node/él modellt és a spec-mutáló műveleteket, hogy a szerkesztő gomb-/drag-műveletei mindig
 * a kanonikus `spec`-et írják — a `layout` (node-pozíció) ettől külön él és a hash-en kívül (D2).
 */
import type { RawGate, RawStep } from '@/components/playbooks/playbook-flow-graph'
import type { PlaybookDraftSpec } from '@/components/playbooks/playbook-spec-shared'
import type { PlaybookRole } from '@/lib/playbook-v2/spec'

export const START_NODE_ID = '__start__'
export const END_NODE_ID = '__end__'

export type CanvasNodeKind = 'start' | 'end' | 'step' | 'gate'

export type CanvasOutcome = {
  label: string
  targetId: string
  targetKind: 'step' | 'gate'
  isDefault: boolean
}

export type CanvasNode = {
  id: string
  kind: CanvasNodeKind
  position: { x: number; y: number }
  step?: RawStep
  gate?: RawGate
  label: string
  isEntry: boolean
  isDecision: boolean
  isTerminal: boolean
  roleType: 'agent_role' | 'human_role'
  roleKey: string
  criticality?: string
  outcomes: CanvasOutcome[]
}

export type CanvasEdgeKind = 'entry' | 'flow' | 'decision' | 'gate' | 'requires' | 'end'

export type CanvasEdge = {
  id: string
  source: string
  target: string
  kind: CanvasEdgeKind
  label?: string
  /** A forrás-step `onComplete` tömbjében az elágazás-index (törléshez). */
  ruleIndex?: number
  /** A `requiredGateIds` referenciából származik. */
  fromRequiredGate?: boolean
  /** A top-level `transitions[]` indexéből származik. */
  transitionIndex?: number
}

export type CanvasModel = { nodes: CanvasNode[]; edges: CanvasEdge[] }

type RawTransition = { fromStepId?: string; toStepId?: string; trigger?: string }

/** A `transitions[]` tipizált olvasása (a PlaybookDraftSpec index-signature miatt kézzel). */
function readTransitions(spec: PlaybookDraftSpec): RawTransition[] {
  const t = (spec as { transitions?: unknown }).transitions
  return Array.isArray(t) ? (t as RawTransition[]) : []
}

export type LayoutStore = {
  nodes?: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

// --- Segédek ---------------------------------------------------------------

type Condition =
  | 'default'
  | { field?: string; op?: string; value?: string | number | boolean }

function conditionLabel(c: Condition | undefined): string {
  if (c == null || c === 'default') return 'alap'
  if (typeof c === 'object' && c.field) {
    return `${c.field} ${c.op ?? '=='} ${String(c.value ?? '')}`.trim()
  }
  return ''
}

function roleTypeOf(
  roles: PlaybookRole[] | undefined,
  roleKey: string | undefined,
): 'agent_role' | 'human_role' {
  const role = (roles ?? []).find((r) => r.key === roleKey)
  return role?.type === 'human_role' ? 'human_role' : 'agent_role'
}

/** Egy step döntési (multi-outcome elágazás) lépés-e: ≥2 onComplete szabály, van field-feltétel,
 * vagy a kimeneti szerződése tartalmazza a `decision` mezőt (Decision Step, WP-8). */
export function isDecisionStep(step: RawStep): boolean {
  const rules = step.onComplete ?? []
  if (rules.length >= 2) return true
  if (rules.some((r) => r.condition != null && r.condition !== 'default')) return true
  const required = (step.outputContract as { requiredFields?: unknown } | undefined)?.requiredFields
  return Array.isArray(required) && required.includes('decision')
}

function outcomesOf(step: RawStep): CanvasOutcome[] {
  return (step.onComplete ?? []).map((r) => {
    const isDefault = r.condition == null || r.condition === 'default'
    return {
      label: conditionLabel(r.condition as Condition),
      targetId: r.gateId ?? r.nextStepId ?? '',
      targetKind: r.gateId ? 'gate' : 'step',
      isDefault,
    }
  })
}

/** Egyedi id előállítása egy bázisból (ütközés esetén `-2`, `-3`, …). */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  const clean = base.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node'
  if (!set.has(clean)) return clean
  let i = 2
  while (set.has(`${clean}_${i}`)) i++
  return `${clean}_${i}`
}

// --- Derivált modell (spec → canvas) ---------------------------------------

const COL_W = 280
const ROW_H = 160
const PAD_X = 60
const PAD_Y = 40

/** Rétegzett auto-layout (leghosszabb-út), a kézzel írt SVG-gráf mintájára. */
export function computeAutoLayout(spec: PlaybookDraftSpec): Record<string, { x: number; y: number }> {
  const steps = (spec.steps ?? []).filter((s) => s.id)
  const gates = (spec.gates ?? []).filter((g) => g.id)
  const ids = new Set<string>([...steps.map((s) => s.id as string), ...gates.map((g) => g.id as string)])

  const layer = new Map<string, number>()
  for (const id of ids) layer.set(id, 0)

  const edges: Array<{ from: string; to: string }> = []
  for (const s of steps) {
    for (const r of s.onComplete ?? []) {
      const to = r.nextStepId ?? r.gateId
      if (to && ids.has(to)) edges.push({ from: s.id as string, to })
    }
    for (const gid of s.requiredGateIds ?? []) {
      if (ids.has(gid)) edges.push({ from: s.id as string, to: gid })
    }
  }
  for (const tt of readTransitions(spec)) {
    if (tt.fromStepId && tt.toStepId && ids.has(tt.fromStepId) && ids.has(tt.toStepId)) {
      edges.push({ from: tt.fromStepId, to: tt.toStepId })
    }
  }

  for (let i = 0; i < ids.size; i++) {
    let changed = false
    for (const e of edges) {
      const lu = layer.get(e.from) ?? 0
      if ((layer.get(e.to) ?? 0) < lu + 1) {
        layer.set(e.to, lu + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  const entry = spec.entryStepId as string | undefined
  if (entry && layer.has(entry)) layer.set(entry, 0)

  const byLayer = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    const list = byLayer.get(l) ?? []
    list.push(id)
    byLayer.set(l, list)
  }
  const pos: Record<string, { x: number; y: number }> = {}
  for (const [l, list] of byLayer) {
    list.forEach((id, row) => {
      pos[id] = { x: PAD_X + (l + 1) * COL_W, y: PAD_Y + row * ROW_H }
    })
  }
  return pos
}

/** A spec + tárolt layout → canvas node/él modell. A start/end node szintetikus. */
export function specToCanvasModel(spec: PlaybookDraftSpec, layout: LayoutStore | null | undefined): CanvasModel {
  const steps = (spec.steps ?? []).filter((s): s is RawStep & { id: string } => Boolean(s.id))
  const gates = (spec.gates ?? []).filter((g): g is RawGate & { id: string } => Boolean(g.id))
  const stepIds = new Set(steps.map((s) => s.id))
  const gateIds = new Set(gates.map((g) => g.id))

  const stored = layout?.nodes ?? {}
  // A stored pozíció elsőbbséget élvez; új (még nem mentett) node-ok az auto-layoutból kapnak helyet.
  const auto = computeAutoLayout(spec)
  const posOf = (id: string, fallback: { x: number; y: number }) =>
    stored[id] ?? auto[id] ?? fallback

  const entryId = (spec.entryStepId as string | undefined) ?? steps[0]?.id

  // Terminál-step felismerés: nincs kimenő step-célú routingja.
  const hasStepTarget = new Set<string>()
  for (const s of steps) {
    const goesToStep =
      (s.onComplete ?? []).some((r) => r.nextStepId && stepIds.has(r.nextStepId)) ||
      readTransitions(spec).some((t) => t.fromStepId === s.id)
    if (goesToStep) hasStepTarget.add(s.id)
  }

  const nodes: CanvasNode[] = []

  // Start node
  nodes.push({
    id: START_NODE_ID,
    kind: 'start',
    position: posOf(START_NODE_ID, { x: PAD_X, y: PAD_Y }),
    label: 'Start',
    isEntry: false,
    isDecision: false,
    isTerminal: false,
    roleType: 'agent_role',
    roleKey: '',
    outcomes: [],
  })

  let maxX = PAD_X
  for (const s of steps) {
    const p = posOf(s.id, { x: PAD_X + COL_W, y: PAD_Y })
    maxX = Math.max(maxX, p.x)
    nodes.push({
      id: s.id,
      kind: 'step',
      position: p,
      step: s,
      label: s.name || s.id,
      isEntry: s.id === entryId,
      isDecision: isDecisionStep(s),
      isTerminal: !hasStepTarget.has(s.id),
      roleType: roleTypeOf(spec.roles, s.assignedRole),
      roleKey: s.assignedRole ?? '',
      outcomes: outcomesOf(s),
    })
  }
  for (const g of gates) {
    const p = posOf(g.id, { x: PAD_X + 2 * COL_W, y: PAD_Y })
    maxX = Math.max(maxX, p.x)
    nodes.push({
      id: g.id,
      kind: 'gate',
      position: p,
      gate: g,
      label: g.id,
      isEntry: false,
      isDecision: false,
      isTerminal: false,
      roleType: 'human_role',
      roleKey: g.requiredActorRole ?? '',
      criticality: g.criticality,
      outcomes: [],
    })
  }

  // End node
  nodes.push({
    id: END_NODE_ID,
    kind: 'end',
    position: posOf(END_NODE_ID, { x: maxX + COL_W, y: PAD_Y }),
    label: 'Vége',
    isEntry: false,
    isDecision: false,
    isTerminal: false,
    roleType: 'agent_role',
    roleKey: '',
    outcomes: [],
  })

  // --- Élek ---
  const edges: CanvasEdge[] = []
  const seen = new Set<string>()
  const push = (e: CanvasEdge) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    edges.push(e)
  }

  // Start → entry step
  if (entryId && stepIds.has(entryId)) {
    push({ id: `e_start_${entryId}`, source: START_NODE_ID, target: entryId, kind: 'entry' })
  }

  for (const s of steps) {
    const rules = s.onComplete ?? []
    const decision = isDecisionStep(s)
    rules.forEach((r, ruleIndex) => {
      const target = r.nextStepId ?? r.gateId
      if (!target || !(stepIds.has(target) || gateIds.has(target))) return
      const toGate = Boolean(r.gateId)
      push({
        id: `e_${s.id}_${ruleIndex}_${target}`,
        source: s.id,
        target,
        kind: toGate ? 'gate' : decision ? 'decision' : 'flow',
        label: conditionLabel(r.condition as Condition),
        ruleIndex,
      })
    })
    for (const gid of s.requiredGateIds ?? []) {
      if (!gateIds.has(gid)) continue
      push({ id: `e_req_${s.id}_${gid}`, source: s.id, target: gid, kind: 'requires', fromRequiredGate: true })
    }
  }

  readTransitions(spec).forEach((tt, idx) => {
    if (!tt.fromStepId || !tt.toStepId) return
    if (!stepIds.has(tt.fromStepId) || !stepIds.has(tt.toStepId)) return
    const covered = edges.some(
      (e) => e.source === tt.fromStepId && e.target === tt.toStepId && e.kind !== 'requires',
    )
    if (covered) return
    push({
      id: `e_t${idx}_${tt.fromStepId}_${tt.toStepId}`,
      source: tt.fromStepId,
      target: tt.toStepId,
      kind: 'flow',
      label: tt.trigger ?? '',
      transitionIndex: idx,
    })
  })

  // Terminál step → End
  for (const s of steps) {
    if (!hasStepTarget.has(s.id)) {
      push({ id: `e_end_${s.id}`, source: s.id, target: END_NODE_ID, kind: 'end' })
    }
  }

  return { nodes, edges }
}

/** Node-pozíciók kinyerése a canvas node-listából a `layout.nodes`-hoz (szintetikusakat is tartja). */
export function extractLayout(
  nodes: Array<{ id: string; position: { x: number; y: number } }>,
  viewport?: { x: number; y: number; zoom: number },
): LayoutStore {
  const out: Record<string, { x: number; y: number }> = {}
  for (const n of nodes) {
    out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
  }
  return viewport ? { nodes: out, viewport } : { nodes: out }
}
