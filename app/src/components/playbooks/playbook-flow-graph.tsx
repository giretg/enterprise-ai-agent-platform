'use client'

/**
 * PlaybookFlowGraph — a Playbook-spec (§9.2) tervezett folyamatának SVG-gráfja.
 *
 * A spec `steps` / `gates` / `transitions` + `onComplete` mezőiből determinisztikus,
 * rétegelt (longest-path) elrendezésű node-él gráfot rajzol. Szándékosan DEFENZÍV:
 * nyers `unknown` specet fogad, saját minimál-parse-szal (nincs zod/crypto a kliens-
 * bundle-ben), és `null`-t ad vissza, ha a spec még nem rajzolható.
 */

type Condition =
  | 'default'
  | { field?: string; op?: string; value?: string | number | boolean }

type RawRule = { condition?: Condition; nextStepId?: string; gateId?: string }
type RawStep = {
  id?: string
  name?: string
  assignedRole?: string
  requiredGateIds?: string[]
  onComplete?: RawRule[]
}
type RawGate = { id?: string; type?: string; criticality?: string; blocking?: boolean }
type RawTransition = { fromStepId?: string; toStepId?: string; trigger?: string }
type RawSpec = {
  entryStepId?: string
  steps?: RawStep[]
  gates?: RawGate[]
  transitions?: RawTransition[]
}

type NodeKind = 'step' | 'gate'
type GraphNode = {
  id: string
  label: string
  sub: string
  kind: NodeKind
  isEntry: boolean
  criticality?: string
  layer: number
  row: number
}
type EdgeKind = 'flow' | 'gate' | 'requires'
type GraphEdge = { from: string; to: string; label: string; kind: EdgeKind }

const NODE_W = 164
const NODE_H = 56
const COL_GAP = 96
const ROW_GAP = 30
const PAD = 20

function conditionLabel(c: Condition | undefined): string {
  if (c == null || c === 'default') return 'alap'
  if (typeof c === 'object' && c.field) {
    return `${c.field} ${c.op ?? '=='} ${String(c.value ?? '')}`.trim()
  }
  return ''
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Nyers spec → node/él modell, vagy null ha nincs mit rajzolni. */
function buildModel(raw: RawSpec): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  const steps = Array.isArray(raw.steps) ? raw.steps.filter((s) => s && s.id) : []
  if (steps.length === 0) return null
  const gates = Array.isArray(raw.gates) ? raw.gates.filter((g) => g && g.id) : []

  const nodes = new Map<string, GraphNode>()
  for (const s of steps) {
    nodes.set(s.id as string, {
      id: s.id as string,
      label: truncate(s.name || (s.id as string), 22),
      sub: s.assignedRole ? truncate(s.assignedRole, 22) : '',
      kind: 'step',
      isEntry: raw.entryStepId === s.id,
      layer: 0,
      row: 0,
    })
  }
  for (const g of gates) {
    nodes.set(g.id as string, {
      id: g.id as string,
      label: truncate(g.id as string, 22),
      sub: g.type ? truncate(g.type.replace(/_/g, ' '), 22) : 'kapu',
      kind: 'gate',
      isEntry: false,
      criticality: g.criticality,
      layer: 0,
      row: 0,
    })
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const addEdge = (from: string, to: string, label: string, kind: EdgeKind) => {
    if (!nodes.has(from) || !nodes.has(to)) return
    const key = `${from}→${to}:${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, label, kind })
  }

  for (const s of steps) {
    const sid = s.id as string
    for (const r of Array.isArray(s.onComplete) ? s.onComplete : []) {
      const target = r?.nextStepId ?? r?.gateId
      if (!target) continue
      addEdge(sid, target, conditionLabel(r?.condition), r?.gateId ? 'gate' : 'flow')
    }
    for (const gid of Array.isArray(s.requiredGateIds) ? s.requiredGateIds : []) {
      addEdge(sid, gid, 'kapu', 'requires')
    }
  }
  for (const t of Array.isArray(raw.transitions) ? raw.transitions : []) {
    if (t?.fromStepId && t?.toStepId) {
      addEdge(t.fromStepId, t.toStepId, t.trigger || '', 'flow')
    }
  }

  // Rétegkiosztás: longest-path relaxáció a routing-élek mentén (flow + gate + requires).
  const entry = raw.entryStepId && nodes.has(raw.entryStepId) ? raw.entryStepId : steps[0].id
  const nodeCount = nodes.size
  for (let i = 0; i < nodeCount; i++) {
    let changed = false
    for (const e of edges) {
      const u = nodes.get(e.from)!
      const v = nodes.get(e.to)!
      if (v.layer < u.layer + 1) {
        v.layer = u.layer + 1
        changed = true
      }
    }
    if (!changed) break
  }
  const entryNode = nodes.get(entry as string)
  if (entryNode) entryNode.layer = 0

  // Sorok rétegen belül, beszúrási sorrendben.
  const byLayer = new Map<number, GraphNode[]>()
  for (const n of nodes.values()) {
    const list = byLayer.get(n.layer) ?? []
    list.push(n)
    byLayer.set(n.layer, list)
  }
  for (const list of byLayer.values()) {
    list.forEach((n, idx) => (n.row = idx))
  }

  return { nodes: [...nodes.values()], edges }
}

function nodePos(n: GraphNode) {
  const x = PAD + n.layer * (NODE_W + COL_GAP)
  const y = PAD + n.row * (NODE_H + ROW_GAP)
  return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 }
}

export function PlaybookFlowGraph({ spec }: { spec: unknown }) {
  if (!spec || typeof spec !== 'object') return null
  const model = buildModel(spec as RawSpec)
  if (!model) return null
  const { nodes, edges } = model

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const maxLayer = Math.max(...nodes.map((n) => n.layer))
  const maxRow = Math.max(...nodes.map((n) => n.row))
  const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * COL_GAP
  const height = PAD * 2 + (maxRow + 1) * NODE_H + maxRow * ROW_GAP

  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10 bg-paper/40 p-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="max-w-full"
        role="img"
        aria-label="Playbook folyamat-gráf"
      >
        <defs>
          <marker
            id="pb-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-ink/45" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const u = nodeById.get(e.from)!
          const v = nodeById.get(e.to)!
          const a = nodePos(u)
          const b = nodePos(v)
          // Balról jobbra: u jobb-közép → v bal-közép. Vissza-/oldalirányú éleknél is stabil.
          const x1 = a.x + NODE_W
          const y1 = a.cy
          const x2 = b.x
          const y2 = b.cy
          const mx = (x1 + x2) / 2
          const dashed = e.kind === 'requires'
          const stroke =
            e.kind === 'gate'
              ? 'stroke-honey/70'
              : e.kind === 'requires'
                ? 'stroke-ink/30'
                : 'stroke-ink/40'
          return (
            <g key={`e${i}`}>
              <path
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                className={stroke}
                strokeWidth={1.5}
                strokeDasharray={dashed ? '4 3' : undefined}
                markerEnd="url(#pb-arrow)"
              />
              {e.label && (
                <text
                  x={mx}
                  y={(y1 + y2) / 2 - 4}
                  textAnchor="middle"
                  className="fill-ink-soft"
                  style={{ fontSize: 9 }}
                >
                  {truncate(e.label, 18)}
                </text>
              )}
            </g>
          )
        })}

        {nodes.map((n) => {
          const p = nodePos(n)
          const isGate = n.kind === 'gate'
          const fill = isGate ? 'fill-honey/10' : n.isEntry ? 'fill-coral/10' : 'fill-paper'
          const border = isGate
            ? 'stroke-honey/60'
            : n.isEntry
              ? 'stroke-coral/70'
              : 'stroke-ink/20'
          return (
            <g key={n.id}>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={isGate ? 6 : 10}
                className={`${fill} ${border}`}
                strokeWidth={n.isEntry ? 2 : 1.5}
              />
              <text
                x={p.x + 12}
                y={p.y + 22}
                className="fill-ink"
                style={{ fontSize: 12, fontWeight: 600 }}
              >
                {n.label}
              </text>
              <text x={p.x + 12} y={p.y + 39} className="fill-ink-soft" style={{ fontSize: 10 }}>
                {isGate ? '◆ ' : ''}
                {n.sub}
                {n.criticality ? ` · ${n.criticality}` : ''}
              </text>
              {n.isEntry && (
                <text x={p.x + NODE_W - 10} y={p.y + 15} textAnchor="end" className="fill-coral" style={{ fontSize: 8, fontWeight: 700 }}>
                  START
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ink-soft">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded border border-coral/70 bg-coral/10" /> belépő lépés
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-honey/60 bg-honey/10" /> kapu (◆)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0 w-4 border-t border-dashed border-ink/40" /> kötelező kapu
        </span>
      </div>
    </div>
  )
}
