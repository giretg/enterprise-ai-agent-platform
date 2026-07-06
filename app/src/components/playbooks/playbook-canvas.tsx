'use client'

/**
 * Governed Flow Builder — Playbook Canvas (WP-2, D1/D2/D6).
 *
 * React Flow alapú, drag-drop vizuális szerkesztő a Playbook-spec FÖLÉ. A canvas a kanonikus
 * `spec`-ből DERIVÁLT nézet: minden strukturális művelet (paletta, drag-connect, törlés) a
 * spec-et írja; a node-pozíció külön `layout` (a hash-ből kizárva, D2). A JSON-nézet CSAK debug.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  specToCanvasModel,
  extractLayout,
  type CanvasNode,
  type CanvasEdge,
  type CanvasEdgeKind,
  type LayoutStore,
  START_NODE_ID,
  END_NODE_ID,
} from '@/lib/playbook-v2/canvas-mapping'
import {
  addStepAfter,
  addGateAfter,
  insertTemplateFragment,
  connectNodes,
  deleteEdgeFromSpec,
  deleteNodeFromSpec,
  retargetEdge,
  reverseEdge,
  replaceStep,
  replaceGate,
} from '@/lib/playbook-v2/canvas-spec-ops'
import { CANVAS_NODE_TYPES } from '@/components/playbooks/playbook-canvas-nodes'
import {
  readDefaultErrorPolicy,
  type PlaybookDraftSpec,
  type PlaybookValidationResult,
} from '@/components/playbooks/playbook-spec-shared'
import {
  buildStepFromForm,
  stepFormFromRaw,
  PlaybookStepEditorForm,
  type StepFormState,
} from '@/components/playbooks/playbook-step-editor-form'
import {
  buildGateFromForm,
  gateFormFromRaw,
  PlaybookGateEditorForm,
  type GateFormState,
} from '@/components/playbooks/playbook-gate-editor-form'
import { PlaybookDecisionEditor } from '@/components/playbooks/playbook-decision-editor'
import { upsertRoleType } from '@/lib/playbook-v2/role-sync'
import type { PlaybookRole } from '@/lib/playbook-v2/spec'
import type { RawGate, RawStep } from '@/components/playbooks/playbook-flow-graph'

export type CanvasStepTemplate = {
  key: string
  name: string
  description: string | null
  category: string | null
  fragment: { step?: Record<string, unknown>; suggestedGate?: Record<string, unknown> | null }
}

type EdgeData = {
  kind: CanvasEdgeKind
  ruleIndex?: number
  transitionIndex?: number
  fromRequiredGate?: boolean
  target: string
}

const EDGE_STYLE: Record<CanvasEdgeKind, { stroke: string; dash?: string; animated?: boolean }> = {
  entry: { stroke: 'var(--color-sage)', animated: true },
  flow: { stroke: 'var(--color-ink-soft)' },
  decision: { stroke: 'var(--color-grape)' },
  gate: { stroke: 'var(--color-honey)' },
  requires: { stroke: 'var(--color-honey)', dash: '5 4' },
  end: { stroke: 'var(--color-ink-faint)', dash: '2 4' },
}

function nodeErrorIds(spec: PlaybookDraftSpec, validation: PlaybookValidationResult): Set<string> {
  const ids = [
    ...(spec.steps ?? []).map((s) => s.id).filter(Boolean),
    ...(spec.gates ?? []).map((g) => g.id).filter(Boolean),
  ] as string[]
  const out = new Set<string>()
  for (const err of validation.errors) {
    for (const id of ids) {
      if (err.path.includes(id)) out.add(id)
    }
  }
  return out
}

function toRfNode(n: CanvasNode, errorIds: Set<string>, selectedId: string | null): Node {
  const type = n.kind === 'step' ? (n.isDecision ? 'decision' : 'step') : n.kind
  return {
    id: n.id,
    type,
    position: n.position,
    data: { model: n, hasError: errorIds.has(n.id) },
    selected: n.id === selectedId,
    deletable: n.kind !== 'start' && n.kind !== 'end',
    draggable: true,
  }
}

/** A kapu-célú élek (kind 'gate'/'requires') a lépés/döntés ALJÁN lévő `gate-out` pöttyétől a
 * kapu TETEJÉN lévő `gate-in` pöttyéig futnak (nem a fő láncot vivő jobb/bal pöttyön) — D: a kapu
 * a lépéshez tartozó előfeltétel/döntés, nem a folyamat következő láncszeme. */
const GATE_TARGET_EDGE_KINDS: ReadonlySet<CanvasEdgeKind> = new Set(['gate', 'requires'])

function toRfEdge(e: CanvasEdge): Edge {
  const style = EDGE_STYLE[e.kind]
  const data: EdgeData = {
    kind: e.kind,
    ruleIndex: e.ruleIndex,
    transitionIndex: e.transitionIndex,
    fromRequiredGate: e.fromRequiredGate,
    target: e.target,
  }
  const toGate = GATE_TARGET_EDGE_KINDS.has(e.kind)
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: toGate ? 'gate-out' : undefined,
    targetHandle: toGate ? 'gate-in' : undefined,
    label: e.label && e.label !== 'alap' ? e.label : undefined,
    animated: style.animated,
    deletable: e.kind !== 'entry' && e.kind !== 'end',
    data: data as unknown as Record<string, unknown>,
    style: { stroke: style.stroke, strokeWidth: 1.6, strokeDasharray: style.dash },
    labelStyle: { fontSize: 10, fill: 'var(--color-ink-soft)' },
    labelBgStyle: { fill: 'var(--color-paper)', fillOpacity: 0.85 },
    markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 16, height: 16 },
  }
}

// --- Paletta ---------------------------------------------------------------

function PaletteButton({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: string
  label: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className="flex w-full items-center gap-2 rounded-lg border border-ink/15 bg-paper px-2.5 py-2 text-left text-xs transition-colors hover:border-accent/40 hover:bg-accent/5"
    >
      <span aria-hidden className="text-base">{icon}</span>
      <span className="font-medium text-ink">{label}</span>
    </button>
  )
}

function ToolbarButton({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: string
  label: string
  hint: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="flex items-center gap-1.5 rounded-md border border-ink/15 bg-paper px-2 py-1 text-xs text-ink transition-colors hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink/15 disabled:hover:bg-paper"
    >
      <span aria-hidden>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  )
}

// --- Inspector (kulcsolt: selection + struktúra változáskor újraépül) -------

function StepInspector({
  spec,
  step,
  onSpecChange,
}: {
  spec: PlaybookDraftSpec
  step: RawStep
  onSpecChange: (spec: PlaybookDraftSpec) => void
}) {
  const [form, setForm] = useState<StepFormState>(() =>
    stepFormFromRaw(step, spec.roles, readDefaultErrorPolicy(spec)),
  )
  const [error, setError] = useState<string | null>(null)
  const stepIds = (spec.steps ?? []).map((s) => s.id).filter((id): id is string => Boolean(id) && id !== step.id)
  const gateIds = (spec.gates ?? []).map((g) => g.id).filter((id): id is string => Boolean(id))
  const isDecision =
    form.onCompleteRules.length >= 2 ||
    form.onCompleteRules.some((r) => r.conditionKind === 'field') ||
    /"decision"/.test(form.outputContractJson)

  // A legfrissebb spec/onSpecChange/step-et ref-en tartjuk (effektben frissítve), hogy a
  // live-apply effect CSAK a `form` változására fusson, ne minden apply utáni re-renderre.
  const latestRef = useRef({ spec, onSpecChange, step })
  useEffect(() => {
    latestRef.current = { spec, onSpecChange, step }
  })

  // Live-sync: minden form-változás azonnal a specbe (és így a vászonra) íródik.
  // Az első futást (mount/kiválasztás) kihagyjuk, hogy a puszta kijelölés ne írja felül a specet.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    const { spec: curSpec, onSpecChange: curOnChange, step: curStep } = latestRef.current
    const { stepPatch, jsonError } = buildStepFromForm(curStep, form)
    if (jsonError) {
      setError(jsonError)
      return
    }
    setError(null)
    let next = replaceStep(curSpec, curStep.id as string, stepPatch)
    if (form.assignedRole.trim()) {
      next = {
        ...next,
        roles: upsertRoleType(
          next.roles as PlaybookRole[] | undefined,
          form.assignedRole.trim(),
          form.roleType,
          form.requiredCapabilities,
        ),
      }
    }
    curOnChange(next)
  }, [form])

  return (
    <div className="space-y-3">
      {isDecision && (
        <PlaybookDecisionEditor form={form} onChange={setForm} stepIds={stepIds} gateIds={gateIds} />
      )}
      <PlaybookStepEditorForm
        form={form}
        onChange={setForm}
        stepIds={stepIds}
        gateIds={gateIds}
        roles={spec.roles as PlaybookRole[] | undefined}
        defaultErrorPolicy={readDefaultErrorPolicy(spec)}
      />
      {error ? (
        <p className="text-xs text-coral">⚠ {error} — a hibás mező mentése kimarad, a többi frissül.</p>
      ) : (
        <p className="text-[11px] text-ink-faint">✓ A módosítások azonnal megjelennek a vásznon.</p>
      )}
    </div>
  )
}

function GateInspector({
  spec,
  gate,
  onSpecChange,
}: {
  spec: PlaybookDraftSpec
  gate: RawGate
  onSpecChange: (spec: PlaybookDraftSpec) => void
}) {
  const [form, setForm] = useState<GateFormState>(() => gateFormFromRaw(gate))

  const latestRef = useRef({ spec, onSpecChange, gate })
  useEffect(() => {
    latestRef.current = { spec, onSpecChange, gate }
  })

  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    const { spec: curSpec, onSpecChange: curOnChange, gate: curGate } = latestRef.current
    const patch = buildGateFromForm(curGate, form)
    curOnChange(replaceGate(curSpec, curGate.id as string, patch))
  }, [form])

  return (
    <div className="space-y-3">
      <PlaybookGateEditorForm form={form} onChange={setForm} roles={spec.roles as PlaybookRole[] | undefined} />
      <p className="text-[11px] text-ink-faint">✓ A módosítások azonnal megjelennek a vásznon.</p>
    </div>
  )
}

// --- Él-inspector (kapcsolat szerkesztése kézzel) --------------------------

const EDGE_KIND_LABEL: Record<CanvasEdgeKind, string> = {
  entry: 'belépő',
  flow: 'folytatás',
  decision: 'döntési ág',
  gate: 'kapu-routing',
  requires: 'kötelező kapu',
  end: 'befejezés',
}

function EdgeInspector({
  spec,
  source,
  target,
  data,
  targetOptions,
  onRetarget,
  onReverse,
  onDelete,
}: {
  spec: PlaybookDraftSpec
  source: string
  target: string
  data: EdgeData
  targetOptions: Array<{ id: string; label: string }>
  onRetarget: (id: string) => void
  onReverse: () => void
  onDelete: () => void
}) {
  const labelOf = (id: string): string => {
    if (id === START_NODE_ID) return 'Start'
    if (id === END_NODE_ID) return 'Vége'
    const step = (spec.steps ?? []).find((s) => s.id === id)
    if (step) return step.name || (step.id as string)
    return id
  }

  const readOnly = data.kind === 'entry' || data.kind === 'end'
  const canReverse = data.kind === 'flow' || data.kind === 'decision' || data.kind === 'gate'

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-ink">🔗 Kapcsolat</p>
      <div className="rounded-lg border border-ink/12 bg-paper/60 p-2.5 text-xs">
        <p className="flex items-center gap-1.5">
          <span className="font-medium text-ink">{labelOf(source)}</span>
          <span className="text-ink-faint">→</span>
          <span className="font-medium text-ink">{labelOf(target)}</span>
        </p>
        <p className="mt-1 text-[10px] text-ink-faint">Típus: {EDGE_KIND_LABEL[data.kind]}</p>
      </div>

      {readOnly ? (
        <p className="rounded bg-ink/5 px-2 py-1.5 text-[11px] text-ink-faint">
          {data.kind === 'entry'
            ? 'A belépő élt a lépés „belépő" beállítása vagy a Start→lépés összekötés vezérli.'
            : 'A „Vége" felé mutató él automatikus (a lépésnek nincs kimenő folytatása).'}
        </p>
      ) : (
        <>
          <label className="block text-xs">
            <span className="mb-0.5 block text-ink-soft">Célpont átkötése</span>
            <select
              value={targetOptions.some((o) => o.id === target) ? target : ''}
              onChange={(e) => e.target.value && onRetarget(e.target.value)}
              className="w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm"
            >
              <option value="" disabled>
                Válassz célpontot…
              </option>
              {targetOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-2">
            {canReverse && (
              <button
                onClick={onReverse}
                title="A kapcsolat irányának megfordítása"
                className="flex-1 rounded-lg border border-ink/20 px-3 py-2 text-xs font-medium text-ink hover:border-accent/40 hover:text-accent"
              >
                ⇄ Irány megfordítása
              </button>
            )}
            <button
              onClick={onDelete}
              className="flex-1 rounded-lg border border-coral/40 px-3 py-2 text-xs font-medium text-coral hover:bg-coral/5"
            >
              🗑 Kapcsolat törlése
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// --- Fő komponens ----------------------------------------------------------

export function PlaybookCanvas({
  spec,
  onSpecChange,
  layout,
  onLayoutChange,
  validation,
  templates = [],
  statusBadge,
}: {
  spec: PlaybookDraftSpec
  onSpecChange: (spec: PlaybookDraftSpec) => void
  layout: LayoutStore | null
  onLayoutChange: (layout: LayoutStore) => void
  validation: PlaybookValidationResult
  templates?: CanvasStepTemplate[]
  statusBadge?: React.ReactNode
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const rfInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null)

  const errorIds = useMemo(() => nodeErrorIds(spec, validation), [spec, validation])

  // A layout-ot ref-en tartjuk, hogy a drag (layout) NE váltson ki re-seedet (D2).
  const layoutRef = useRef<LayoutStore | null>(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  // A node-lista friss referenciája (drag-stop layout-mentéshez, stale closure nélkül).
  const nodesRef = useRef<Node[]>(rfNodes)
  useEffect(() => {
    nodesRef.current = rfNodes
  }, [rfNodes])

  // Struktúra-aláírás: csak a spec strukturális változása seedeli újra a canvas-t.
  const structureKey = useMemo(
    () =>
      JSON.stringify({
        e: spec.entryStepId,
        s: spec.steps,
        g: spec.gates,
        t: spec.transitions,
        r: spec.roles,
      }),
    [spec],
  )

  useEffect(() => {
    const model = specToCanvasModel(spec, layoutRef.current)
    setRfNodes(model.nodes.map((n) => toRfNode(n, errorIds, selectedId)))
    setRfEdges(model.edges.map(toRfEdge))
    // A frissen kiszámolt layoutot (új node-ok auto-pozíciója is) felküldjük, hogy a mentés ezt vigye.
    onLayoutChange(extractLayout(model.nodes, layoutRef.current?.viewport))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  // Hiba-highlight + kijelölés frissítése re-seed nélkül.
  useEffect(() => {
    setRfNodes((nds) =>
      nds.map((n) => ({
        ...n,
        selected: n.id === selectedId,
        data: { ...n.data, hasError: errorIds.has(n.id) },
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorIds, selectedId])

  useEffect(() => {
    setRfEdges((eds) => eds.map((e) => ({ ...e, selected: e.id === selectedEdgeId })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEdgeId])

  const persistLayout = useCallback(() => {
    onLayoutChange(extractLayout(nodesRef.current, layoutRef.current?.viewport))
  }, [onLayoutChange])

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return
      onSpecChange(connectNodes(spec, conn.source, conn.target))
    },
    [spec, onSpecChange],
  )

  // A `gate-out` (lépés/döntés alja) csak a `gate-in`-nel (kapu teteje) párosítható, és fordítva —
  // a fő lánc pöttyei (jobb/bal) csak egymással. Így húzás közben sem lehet félrekötni.
  const isValidConnection = useCallback((conn: Connection | Edge) => {
    const sourceIsGateOut = (conn as Connection).sourceHandle === 'gate-out'
    const targetIsGateIn = (conn as Connection).targetHandle === 'gate-in'
    return sourceIsGateOut === targetIsGateIn
  }, [])

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      let next = spec
      for (const d of deleted) {
        if (d.id === START_NODE_ID || d.id === END_NODE_ID) continue
        next = deleteNodeFromSpec(next, d.id)
      }
      if (next !== spec) {
        if (selectedId && deleted.some((d) => d.id === selectedId)) setSelectedId(null)
        onSpecChange(next)
      }
    },
    [spec, onSpecChange, selectedId],
  )

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      let next = spec
      for (const e of deleted) {
        const data = e.data as unknown as EdgeData | undefined
        if (!data) continue
        next = deleteEdgeFromSpec(next, {
          source: e.source,
          target: e.target,
          kind: data.kind,
          ruleIndex: data.ruleIndex,
          transitionIndex: data.transitionIndex,
          fromRequiredGate: data.fromRequiredGate,
        })
      }
      if (next !== spec) onSpecChange(next)
    },
    [spec, onSpecChange],
  )

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedEdgeId(null)
    setSelectedId(node.id === START_NODE_ID || node.id === END_NODE_ID ? null : node.id)
  }, [])

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    setSelectedId(null)
    setSelectedEdgeId(edge.id)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedId(null)
    setSelectedEdgeId(null)
  }, [])

  function addAndSelect(result: { spec: PlaybookDraftSpec; id: string }) {
    setSelectedEdgeId(null)
    setSelectedId(result.id)
    onSpecChange(result.spec)
  }

  const selectedStep = (spec.steps ?? []).find((s) => s.id === selectedId)
  const selectedGate = (spec.gates ?? []).find((g) => g.id === selectedId)
  const selectedEdge = rfEdges.find((e) => e.id === selectedEdgeId)
  const selectedEdgeData = selectedEdge?.data as unknown as EdgeData | undefined

  // Toolbar: kijelölt node VAGY él törlése.
  const deleteSelected = useCallback(() => {
    if (selectedId) {
      const next = deleteNodeFromSpec(spec, selectedId)
      if (next !== spec) {
        setSelectedId(null)
        onSpecChange(next)
      }
      return
    }
    if (selectedEdge && selectedEdgeData) {
      const next = deleteEdgeFromSpec(spec, {
        source: selectedEdge.source,
        target: selectedEdge.target,
        kind: selectedEdgeData.kind,
        ruleIndex: selectedEdgeData.ruleIndex,
        transitionIndex: selectedEdgeData.transitionIndex,
        fromRequiredGate: selectedEdgeData.fromRequiredGate,
      })
      if (next !== spec) {
        setSelectedEdgeId(null)
        onSpecChange(next)
      }
    }
  }, [spec, onSpecChange, selectedId, selectedEdge, selectedEdgeData])

  // Toolbar: teljes újrarendezés (rétegzett auto-layout) + illesztés.
  const autoLayout = useCallback(() => {
    const model = specToCanvasModel(spec, null)
    onLayoutChange(extractLayout(model.nodes, layoutRef.current?.viewport))
    setRfNodes(model.nodes.map((n) => toRfNode(n, errorIds, selectedId)))
    setRfEdges(model.edges.map(toRfEdge))
    requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2, duration: 300 }))
  }, [spec, onLayoutChange, errorIds, selectedId, setRfNodes, setRfEdges])

  const fitView = useCallback(() => {
    rfInstance.current?.fitView({ padding: 0.2, duration: 300 })
  }, [])

  const canDelete = Boolean(
    selectedId || (selectedEdgeData && selectedEdgeData.kind !== 'entry' && selectedEdgeData.kind !== 'end'),
  )

  // Az él-szerkesztő célpont-választójának opciói.
  const nodeTargetOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = []
    const requiresGate = selectedEdgeData?.fromRequiredGate || selectedEdgeData?.kind === 'requires'
    if (!requiresGate) {
      for (const s of spec.steps ?? []) {
        if (s.id && s.id !== selectedEdge?.source) opts.push({ id: s.id, label: `🔹 ${s.name || s.id}` })
      }
    }
    for (const g of spec.gates ?? []) {
      if (g.id) opts.push({ id: g.id, label: `◆ ${g.id}` })
    }
    if (!requiresGate) opts.push({ id: END_NODE_ID, label: '⯀ Vége (routing törlése)' })
    return opts
  }, [spec, selectedEdge, selectedEdgeData])

  function retargetSelectedEdge(newTarget: string) {
    if (!selectedEdge || !selectedEdgeData) return
    onSpecChange(
      retargetEdge(
        spec,
        {
          source: selectedEdge.source,
          target: selectedEdge.target,
          kind: selectedEdgeData.kind,
          ruleIndex: selectedEdgeData.ruleIndex,
          transitionIndex: selectedEdgeData.transitionIndex,
          fromRequiredGate: selectedEdgeData.fromRequiredGate,
        },
        newTarget,
      ),
    )
  }

  function reverseSelectedEdge() {
    if (!selectedEdge || !selectedEdgeData) return
    setSelectedEdgeId(null)
    onSpecChange(
      reverseEdge(spec, {
        source: selectedEdge.source,
        target: selectedEdge.target,
        kind: selectedEdgeData.kind,
        ruleIndex: selectedEdgeData.ruleIndex,
        transitionIndex: selectedEdgeData.transitionIndex,
        fromRequiredGate: selectedEdgeData.fromRequiredGate,
      }),
    )
  }

  // A paletta a kiválasztott node UTÁN szúr be (ha van kijelölés).
  const insertAfterId = selectedId
  const insertAfterLabel = selectedStep ? selectedStep.name || selectedId : null

  return (
    <div className="rounded-xl border border-ink/10 bg-paper/40">
      {/* Fejléc */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">Folyamat-vászon</span>
          {statusBadge}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${validation.valid ? 'text-sage' : 'text-coral'}`}>
            {validation.valid ? '✓ valid' : `${validation.errors.length} hiba`}
          </span>
          <button
            onClick={() => setJsonOpen(true)}
            className="rounded border border-ink/20 px-2 py-1 text-xs text-ink-soft hover:border-accent/40 hover:text-accent"
            title="Nyers JSON — csak debug célra"
          >
            {'{ } JSON (debug)'}
          </button>
        </div>
      </div>

      {/* Eszköztár — a vászon műveletei gombokkal (nem csak billentyűvel) */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink/10 bg-paper/60 px-3 py-1.5">
        <ToolbarButton icon="🗑" label="Kijelölt törlése" hint="A kijelölt lépés/kapu vagy kapcsolat törlése (Del)" disabled={!canDelete} onClick={deleteSelected} />
        <ToolbarButton icon="🎯" label="Illesztés" hint="A teljes ábra a nézetbe illesztése" onClick={fitView} />
        <ToolbarButton icon="⤢" label="Auto-elrendezés" hint="Rétegzett újrarendezés (a kézi pozíciók felülíródnak)" onClick={autoLayout} />
        <span className="ml-auto text-[11px] text-ink-faint">
          {selectedId
            ? 'Node kijelölve — jobb oldalon szerkeszd, a paletta mögé szúr be.'
            : selectedEdgeId
              ? 'Kapcsolat kijelölve — jobb oldalon átkötheted/megfordíthatod.'
              : 'Kattints egy dobozra vagy nyílra a szerkesztéshez.'}
        </span>
      </div>

      <div className="grid grid-cols-[170px_1fr_320px] max-[1100px]:grid-cols-1">
        {/* Paletta */}
        <div className="space-y-1.5 border-r border-ink/10 p-2 max-[1100px]:border-b max-[1100px]:border-r-0">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Elemek
          </p>
          {insertAfterLabel ? (
            <p className="mb-1 rounded bg-accent/8 px-1.5 py-1 text-[10px] leading-snug text-accent">
              Beszúrás <span className="font-semibold">„{insertAfterLabel}”</span> után
            </p>
          ) : (
            <p className="mb-1 px-1 text-[10px] leading-snug text-ink-faint">
              Tipp: jelölj ki egy lépést → az új elem MÖGÉ kerül a láncban.
            </p>
          )}
          <PaletteButton
            icon="🤖"
            label="Agent lépés"
            hint="Automatikus, agent által végzett lépés"
            onClick={() => addAndSelect(addStepAfter(spec, 'agent', insertAfterId))}
          />
          <PaletteButton
            icon="👤"
            label="Emberi feladat"
            hint="Emberi szerep interakciója (jóváhagyás, kitöltés)"
            onClick={() => addAndSelect(addStepAfter(spec, 'human', insertAfterId))}
          />
          <PaletteButton
            icon="◈"
            label="Döntési lépés"
            hint="Multi-outcome elágazás — az agent strukturáltan dönt"
            onClick={() => addAndSelect(addStepAfter(spec, 'decision', insertAfterId))}
          />
          <PaletteButton
            icon="◆"
            label="Jóváhagyási kapu"
            hint="Emberi jóváhagyási / policy ellenőrzési pont"
            onClick={() => addAndSelect(addGateAfter(spec, insertAfterId))}
          />

          <button
            onClick={() => setTemplatesOpen((v) => !v)}
            className="mt-2 flex w-full items-center justify-between rounded-lg border border-ink/15 px-2.5 py-2 text-left text-xs hover:border-accent/40"
          >
            <span className="font-medium text-ink">📦 Sablonok</span>
            <span className="text-ink-faint">{templatesOpen ? '▾' : '▸'}</span>
          </button>
          {templatesOpen && (
            <div className="space-y-1">
              {templates.length === 0 && (
                <p className="px-1 py-1 text-[10px] text-ink-faint">Nincs elérhető sablon.</p>
              )}
              {templates.map((t) => (
                <button
                  key={t.key}
                  onClick={() => addAndSelect(insertTemplateFragment(spec, t.fragment))}
                  title={t.description ?? t.name}
                  className="w-full rounded-lg border border-grape/20 bg-grape/5 px-2 py-1.5 text-left text-[11px] hover:border-grape/40"
                >
                  <span className="block font-medium text-ink">{t.name}</span>
                  {t.category && <span className="text-[9px] text-ink-faint">{t.category}</span>}
                </button>
              ))}
            </div>
          )}

          <p className="px-1 pt-2 text-[10px] leading-snug text-ink-faint">
            Húzz élt a node-ok jobb/bal pöttyei között a folytatáshoz. A lépés ALSÓ (sárga) pöttye
            csak kapuhoz köthető — ez jelzi, hogy a kapu a lépéshez tartozó előfeltétel, nem a
            következő láncszem. Node/kapcsolat kijelölése → jobb oldali szerkesztő. Del billentyű
            vagy 🗑 gomb: törlés.
          </p>
        </div>

        {/* Vászon */}
        <div className="h-[600px] max-[1100px]:h-[440px]">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={CANVAS_NODE_TYPES}
            onInit={(inst) => (rfInstance.current = inst)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeDragStop={persistLayout}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={clearSelection}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'default' }}
          >
            <Background color="var(--color-line)" gap={18} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-paper" />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <div className="max-h-[600px] overflow-y-auto border-l border-ink/10 p-3 max-[1100px]:max-h-none max-[1100px]:border-l-0 max-[1100px]:border-t">
          {selectedStep ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold text-accent">
                  📋 Lépés: <span className="font-mono">{selectedStep.id}</span>
                </p>
              </div>
              <StepInspector
                key={`step:${selectedId}`}
                spec={spec}
                step={selectedStep}
                onSpecChange={onSpecChange}
              />
            </>
          ) : selectedGate ? (
            <>
              <p className="mb-2 text-xs font-semibold text-honey">
                ◆ Kapu: <span className="font-mono">{selectedGate.id}</span>
              </p>
              <GateInspector
                key={`gate:${selectedId}`}
                spec={spec}
                gate={selectedGate}
                onSpecChange={onSpecChange}
              />
            </>
          ) : selectedEdge && selectedEdgeData ? (
            <EdgeInspector
              spec={spec}
              source={selectedEdge.source}
              target={selectedEdge.target}
              data={selectedEdgeData}
              targetOptions={nodeTargetOptions}
              onRetarget={retargetSelectedEdge}
              onReverse={reverseSelectedEdge}
              onDelete={deleteSelected}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-ink-faint">
              <span className="text-2xl">👈</span>
              <p>Válassz ki egy node-ot vagy kapcsolatot a szerkesztéshez, vagy adj hozzá elemet a palettáról.</p>
            </div>
          )}
        </div>
      </div>

      {/* Validációs összegzés */}
      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="space-y-0.5 border-t border-ink/10 px-3 py-2 text-[11px]">
          {validation.errors.map((e, i) => (
            <p key={`err-${i}`} className="text-coral">
              <span className="font-mono">{e.path}</span>: {e.message}
            </p>
          ))}
          {validation.warnings.map((w, i) => (
            <p key={`warn-${i}`} className="text-honey">
              <span className="font-mono">{w.path}</span>: {w.message}
            </p>
          ))}
        </div>
      )}

      {jsonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-ink/20 bg-paper p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-semibold">Playbook JSON (debug)</h3>
              <button onClick={() => setJsonOpen(false)} className="text-ink/40 hover:text-ink">
                ✕
              </button>
            </div>
            <p className="text-[11px] text-ink-faint">
              Csak megtekintés/debug — a szerkesztés a vásznon és az űrlapokon történik.
            </p>
            <textarea
              readOnly
              value={JSON.stringify(spec, null, 2)}
              rows={24}
              spellCheck={false}
              className="w-full rounded-lg border border-ink/15 bg-paper/60 px-3 py-2 font-mono text-xs"
            />
          </div>
        </div>
      )}
    </div>
  )
}
