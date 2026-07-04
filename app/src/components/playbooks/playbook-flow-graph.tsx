'use client'

/**
 * PlaybookFlowGraph — a Playbook-spec (§9.2) tervezett folyamatának SVG-gráfja.
 * Szándékosan DEFENZÍV: nyers `unknown` specet fogad, saját minimál-parse-szal,
 * és `null`-t ad vissza, ha a spec még nem rajzolható.
 *
 * Ha `onNodeClick` prop van, a node-ok kattinthatók (szerkesztési mód).
 */

type Condition =
  | 'default'
  | { field?: string; op?: string; value?: string | number | boolean }

type RawRule = { condition?: Condition; nextStepId?: string; gateId?: string }
export type RawStep = {
  id?: string
  name?: string
  ticketType?: string
  assignedRole?: string
  description?: string
  requiredGateIds?: string[]
  allowedStates?: string[]
  onComplete?: RawRule[]
  instructionTemplate?: string
  inputSlots?: unknown[]
  timeoutMinutes?: number
  retryPolicy?: { maxAttempts?: number; onExhausted?: 'fail_process' | 'manual_review' }
  inputContract?: Record<string, unknown>
  outputContract?: Record<string, unknown>
}
export type RawGate = {
  id?: string
  type?: string
  criticality?: string
  blocking?: boolean
  requiredActorRole?: string
  condition?: Condition
  approvalMode?: 'single' | 'four_eyes' | 'multi_level'
  evidenceRequired?: boolean
}
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
  subLines: string[]  // max 2 sor az agent szerepnek
  templateLines: string[]  // max 5 sor az instructionTemplate-ből
  kind: NodeKind
  isEntry: boolean
  criticality?: string
  layer: number
  row: number
  height: number
}
type EdgeKind = 'flow' | 'gate' | 'requires'
type GraphEdge = { from: string; to: string; labelLines: string[]; kind: EdgeKind }

const NODE_W = 180
const NODE_H_MIN = 72
const COL_GAP = 100
const ROW_GAP = 36
const PAD = 24
const TEMPLATE_LINE_H = 10

function conditionLabel(c: Condition | undefined): string {
  if (c == null || c === 'default') return 'alap'
  if (typeof c === 'object' && c.field) {
    return `${c.field} ${c.op ?? '=='} ${String(c.value ?? '')}`.trim()
  }
  return ''
}

/** Szöveget szavakra vágja, és max maxLen karakteres sorokba tördeli. */
function wrapText(text: string, maxLen: number, maxLines: number): string[] {
  if (!text) return []
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (lines.length >= maxLines) break
    if (cur.length === 0) {
      cur = w.length > maxLen ? w.slice(0, maxLen - 1) + '…' : w
    } else if (cur.length + 1 + w.length <= maxLen) {
      cur += ' ' + w
    } else {
      lines.push(cur)
      if (lines.length >= maxLines) break
      cur = w.length > maxLen ? w.slice(0, maxLen - 1) + '…' : w
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  return lines
}

/** Az instructionTemplate első maxLines sora (sortörés + tördelés). */
function templatePreviewLines(text: string, maxLines: number, maxLen: number): string[] {
  if (!text.trim()) return []
  const result: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (result.length >= maxLines) break
    result.push(...wrapText(raw.trim(), maxLen, maxLines - result.length))
  }
  return result.slice(0, maxLines)
}

function nodeHeight(n: GraphNode): number {
  const roleBlock = 36 + n.subLines.length * 14
  const templateBlock =
    n.templateLines.length > 0
      ? 14 + (n.templateLines.length - 1) * TEMPLATE_LINE_H + 10
      : 0
  return Math.max(NODE_H_MIN, roleBlock + templateBlock)
}

function buildModel(raw: RawSpec): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  const steps = Array.isArray(raw.steps) ? raw.steps.filter((s) => s && s.id) : []
  if (steps.length === 0) return null
  const gates = Array.isArray(raw.gates) ? raw.gates.filter((g) => g && g.id) : []

  const nodes = new Map<string, GraphNode>()
  for (const s of steps) {
    const roleText = s.assignedRole ?? ''
    const templateLines = templatePreviewLines(s.instructionTemplate ?? '', 5, 26)
    const stepNode: GraphNode = {
      id: s.id as string,
      label: wrapText(s.name || (s.id as string), 20, 1)[0] ?? (s.id as string),
      subLines: wrapText(roleText, 22, 2),
      templateLines,
      kind: 'step',
      isEntry: raw.entryStepId === s.id,
      layer: 0,
      row: 0,
      height: NODE_H_MIN,
    }
    stepNode.height = nodeHeight(stepNode)
    nodes.set(s.id as string, stepNode)
  }
  for (const g of gates) {
    const gateNode: GraphNode = {
      id: g.id as string,
      label: wrapText(g.id as string, 20, 1)[0] ?? (g.id as string),
      subLines: g.type ? wrapText(g.type.replace(/_/g, ' '), 22, 2) : ['kapu'],
      templateLines: [],
      kind: 'gate',
      isEntry: false,
      criticality: g.criticality,
      layer: 0,
      row: 0,
      height: NODE_H_MIN,
    }
    gateNode.height = nodeHeight(gateNode)
    nodes.set(g.id as string, gateNode)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const addEdge = (from: string, to: string, label: string, kind: EdgeKind) => {
    if (!nodes.has(from) || !nodes.has(to)) return
    const key = `${from}→${to}:${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, labelLines: wrapText(label, 16, 2), kind })
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
  const entry = raw.entryStepId && nodes.has(raw.entryStepId) ? raw.entryStepId : steps[0].id
  const entryNode = nodes.get(entry as string)
  if (entryNode) entryNode.layer = 0

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

function layoutNodes(nodes: GraphNode[]): Map<string, { x: number; y: number; cx: number; cy: number }> {
  const byLayer = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const list = byLayer.get(n.layer) ?? []
    list.push(n)
    byLayer.set(n.layer, list)
  }
  const positions = new Map<string, { x: number; y: number; cx: number; cy: number }>()
  for (const [layer, list] of byLayer) {
    list.sort((a, b) => a.row - b.row)
    let y = PAD
    for (const n of list) {
      const x = PAD + layer * (NODE_W + COL_GAP)
      positions.set(n.id, { x, y, cx: x + NODE_W / 2, cy: y + n.height / 2 })
      y += n.height + ROW_GAP
    }
  }
  return positions
}

function svgBounds(nodes: GraphNode[], positions: Map<string, { x: number; y: number }>) {
  let maxX = PAD
  let maxY = PAD
  for (const n of nodes) {
    const p = positions.get(n.id)!
    maxX = Math.max(maxX, p.x + NODE_W)
    maxY = Math.max(maxY, p.y + n.height)
  }
  return { width: maxX + PAD, height: maxY + PAD }
}

export type NodeClickPayload =
  | { type: 'step'; id: string; data: RawStep }
  | { type: 'gate'; id: string; data: RawGate }

export function PlaybookFlowGraph({
  spec,
  onNodeClick,
}: {
  spec: unknown
  onNodeClick?: (payload: NodeClickPayload) => void
}) {
  if (!spec || typeof spec !== 'object') return null
  const raw = spec as RawSpec
  const model = buildModel(raw)
  if (!model) return null
  const { nodes, edges } = model

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const positions = layoutNodes(nodes)
  const { width, height } = svgBounds(nodes, positions)

  function handleNodeClick(n: GraphNode) {
    if (!onNodeClick) return
    if (n.kind === 'step') {
      const data = (raw.steps ?? []).find((s) => s.id === n.id) ?? { id: n.id }
      onNodeClick({ type: 'step', id: n.id, data })
    } else {
      const data = (raw.gates ?? []).find((g) => g.id === n.id) ?? { id: n.id }
      onNodeClick({ type: 'gate', id: n.id, data })
    }
  }

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
          const a = positions.get(e.from)!
          const b = positions.get(e.to)!
          const uH = u.height
          const vH = v.height
          const x1 = a.x + NODE_W
          const y1 = a.y + uH / 2
          const x2 = b.x
          const y2 = b.y + vH / 2
          const mx = (x1 + x2) / 2
          const my = (y1 + y2) / 2
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
              {e.labelLines.length > 0 && (
                <text
                  x={mx}
                  y={my - (e.labelLines.length > 1 ? 8 : 4)}
                  textAnchor="middle"
                  className="fill-ink-soft"
                  style={{ fontSize: 9 }}
                >
                  {e.labelLines.map((line, li) => (
                    <tspan key={li} x={mx} dy={li === 0 ? 0 : 11}>
                      {line}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          )
        })}

        {nodes.map((n) => {
          const p = positions.get(n.id)!
          const isGate = n.kind === 'gate'
          const roleEndY = p.y + 36 + n.subLines.length * 14
          const fill = isGate ? 'fill-honey/10' : n.isEntry ? 'fill-coral/10' : 'fill-paper'
          const border = isGate
            ? 'stroke-honey/60'
            : n.isEntry
              ? 'stroke-coral/70'
              : 'stroke-ink/20'
          const clickable = !!onNodeClick
          return (
            <g
              key={n.id}
              onClick={() => handleNodeClick(n)}
              style={clickable ? { cursor: 'pointer' } : undefined}
              role={clickable ? 'button' : undefined}
              aria-label={clickable ? `${n.label} szerkesztése` : undefined}
            >
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={n.height}
                rx={isGate ? 6 : 10}
                className={`${fill} ${border}${clickable ? ' hover:stroke-accent/70' : ''}`}
                strokeWidth={n.isEntry ? 2 : 1.5}
              />
              {/* Lépés/kapu neve */}
              <text
                x={p.x + 10}
                y={p.y + 20}
                className="fill-ink"
                style={{ fontSize: 12, fontWeight: 600 }}
              >
                {n.label}
              </text>
              {/* Agent szerep — 2 sor */}
              {n.subLines.map((line, li) => (
                <text
                  key={li}
                  x={p.x + 10}
                  y={p.y + 36 + li * 14}
                  className="fill-ink-soft"
                  style={{ fontSize: 10 }}
                >
                  {li === 0 && isGate ? '◆ ' : ''}{line}
                  {li === 0 && n.criticality ? ` · ${n.criticality}` : ''}
                </text>
              ))}
              {n.templateLines.length > 0 && (
                <>
                  <text
                    x={p.x + 10}
                    y={roleEndY + 4}
                    className="fill-ink/35"
                    style={{ fontSize: 7 }}
                  >
                    prompt sablon
                  </text>
                  {n.templateLines.map((line, li) => (
                    <text
                      key={`t${li}`}
                      x={p.x + 10}
                      y={roleEndY + 14 + li * TEMPLATE_LINE_H}
                      className="fill-ink-soft"
                      style={{ fontSize: 8 }}
                    >
                      {line}
                    </text>
                  ))}
                </>
              )}
              {clickable && (
                <text
                  x={p.x + NODE_W - 8}
                  y={p.y + n.height - 8}
                  textAnchor="end"
                  className="fill-ink/25"
                  style={{ fontSize: 8 }}
                >
                  ✎
                </text>
              )}
              {n.isEntry && (
                <text
                  x={p.x + NODE_W - 10}
                  y={p.y + 13}
                  textAnchor="end"
                  className="fill-coral"
                  style={{ fontSize: 8, fontWeight: 700 }}
                >
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
        {onNodeClick && (
          <span className="inline-flex items-center gap-1">
            <span className="text-ink/40">✎</span> kattints a szerkesztéshez
          </span>
        )}
      </div>
    </div>
  )
}
