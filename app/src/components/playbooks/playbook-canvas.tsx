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
  addStep,
  addGate,
  insertTemplateFragment,
  connectNodes,
  deleteEdgeFromSpec,
  deleteNodeFromSpec,
  replaceStep,
  replaceGate,
} from '@/lib/playbook-v2/canvas-spec-ops'
import { CANVAS_NODE_TYPES } from '@/components/playbooks/playbook-canvas-nodes'
import type {
  PlaybookDraftSpec,
  PlaybookValidationResult,
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

function toRfEdge(e: CanvasEdge): Edge {
  const style = EDGE_STYLE[e.kind]
  const data: EdgeData = {
    kind: e.kind,
    ruleIndex: e.ruleIndex,
    transitionIndex: e.transitionIndex,
    fromRequiredGate: e.fromRequiredGate,
    target: e.target,
  }
  return {
    id: e.id,
    source: e.source,
    target: e.target,
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
  const [form, setForm] = useState<StepFormState>(() => stepFormFromRaw(step, spec.roles))
  const [error, setError] = useState<string | null>(null)
  const stepIds = (spec.steps ?? []).map((s) => s.id).filter((id): id is string => Boolean(id) && id !== step.id)
  const gateIds = (spec.gates ?? []).map((g) => g.id).filter((id): id is string => Boolean(id))
  const isDecision =
    form.onCompleteRules.length >= 2 ||
    form.onCompleteRules.some((r) => r.conditionKind === 'field') ||
    /"decision"/.test(form.outputContractJson)

  function save() {
    const { stepPatch, jsonError } = buildStepFromForm(step, form)
    if (jsonError) {
      setError(jsonError)
      return
    }
    setError(null)
    let next = replaceStep(spec, step.id as string, stepPatch)
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
    onSpecChange(next)
  }

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
      />
      {error && <p className="text-xs text-coral">{error}</p>}
      <button
        onClick={save}
        className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
      >
        Alkalmaz a lépésre
      </button>
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

  function save() {
    const patch = buildGateFromForm(gate, form)
    onSpecChange(replaceGate(spec, gate.id as string, patch))
  }

  return (
    <div className="space-y-3">
      <PlaybookGateEditorForm form={form} onChange={setForm} roles={spec.roles as PlaybookRole[] | undefined} />
      <button
        onClick={save}
        className="w-full rounded-lg bg-honey px-3 py-2 text-sm font-medium text-white"
      >
        Alkalmaz a kapura
      </button>
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
  const [jsonOpen, setJsonOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)

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

  // Hiba-highlight frissítése re-seed nélkül.
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
    setSelectedId(node.id === START_NODE_ID || node.id === END_NODE_ID ? null : node.id)
  }, [])

  function addAndSelect(result: { spec: PlaybookDraftSpec; id: string }) {
    setSelectedId(result.id)
    onSpecChange(result.spec)
  }

  const selectedStep = (spec.steps ?? []).find((s) => s.id === selectedId)
  const selectedGate = (spec.gates ?? []).find((g) => g.id === selectedId)

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

      <div className="grid grid-cols-[170px_1fr_320px] max-[1100px]:grid-cols-1">
        {/* Paletta */}
        <div className="space-y-1.5 border-r border-ink/10 p-2 max-[1100px]:border-b max-[1100px]:border-r-0">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Elemek
          </p>
          <PaletteButton
            icon="🤖"
            label="Agent lépés"
            hint="Automatikus, agent által végzett lépés"
            onClick={() => addAndSelect(addStep(spec, 'agent'))}
          />
          <PaletteButton
            icon="👤"
            label="Emberi feladat"
            hint="Emberi szerep interakciója (jóváhagyás, kitöltés)"
            onClick={() => addAndSelect(addStep(spec, 'human'))}
          />
          <PaletteButton
            icon="◈"
            label="Döntési lépés"
            hint="Multi-outcome elágazás — az agent strukturáltan dönt"
            onClick={() => addAndSelect(addStep(spec, 'decision'))}
          />
          <PaletteButton
            icon="◆"
            label="Jóváhagyási kapu"
            hint="Emberi jóváhagyási / policy ellenőrzési pont"
            onClick={() => addAndSelect(addGate(spec))}
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
            Húzz élt a node-ok pöttyei között az összekötéshez. Node kijelölése → jobb oldali szerkesztő.
            Del billentyű: törlés.
          </p>
        </div>

        {/* Vászon */}
        <div className="h-[600px] max-[1100px]:h-[440px]">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={CANVAS_NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={persistLayout}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelectedId(null)}
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
                key={`step:${selectedId}:${structureKey.length}`}
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
                key={`gate:${selectedId}:${structureKey.length}`}
                spec={spec}
                gate={selectedGate}
                onSpecChange={onSpecChange}
              />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-ink-faint">
              <span className="text-2xl">👈</span>
              <p>Válassz ki egy node-ot a szerkesztéshez, vagy adj hozzá elemet a palettáról.</p>
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
