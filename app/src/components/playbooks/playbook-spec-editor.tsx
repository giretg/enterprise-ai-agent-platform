'use client'

/**
 * Vizuális Playbook-spec szerkesztő — folyamatábra, lépés/kapu kattintás,
 * prompt sablon, kritikusság, JSON modal. A létrehozás és draft-szerkesztés
 * közös UI-ja.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlaybookFlowGraph, type NodeClickPayload, type RawStep, type RawGate } from '@/components/playbooks/playbook-flow-graph'
import {
  applySpecCriticality,
  PLAYBOOK_CRITICALITY_OPTIONS,
  readEffectiveCriticality,
  summarizeSpecCriticality,
} from '@/components/playbooks/playbook-criticality-ui'
import { PlaybookAgentAssist } from '@/components/playbooks/playbook-agent-assist'
import {
  buildStepFromForm,
  PlaybookStepEditorForm,
  stepFormFromRaw,
  type StepFormState,
} from '@/components/playbooks/playbook-step-editor-form'
import {
  buildGateFromForm,
  gateFormFromRaw,
  PlaybookGateEditorForm,
  type GateFormState,
} from '@/components/playbooks/playbook-gate-editor-form'
import {
  readDefaultErrorPolicy,
  syncPlaybookSpecInputSlots,
  validatePlaybookDraftSpec,
  type PlaybookDraftSpec,
  type PlaybookValidationResult,
} from '@/components/playbooks/playbook-spec-shared'
import { upsertRoleType } from '@/lib/playbook-v2/role-sync'
import type { PlaybookRole } from '@/lib/playbook-v2/spec'
import { PlaybookCanvas, type CanvasStepTemplate } from '@/components/playbooks/playbook-canvas'
import type { LayoutStore } from '@/lib/playbook-v2/canvas-mapping'

export type { PlaybookDraftSpec, PlaybookValidationResult } from '@/components/playbooks/playbook-spec-shared'
export { syncPlaybookSpecInputSlots, validatePlaybookDraftSpec } from '@/components/playbooks/playbook-spec-shared'

type EditingNode =
  | { type: 'step'; id: string; data: RawStep }
  | { type: 'gate'; id: string; data: RawGate }

export function PlaybookSpecEditor({
  spec,
  onSpecChange,
  onValidationChange,
  layout,
  onLayoutChange,
  templates = [],
  statusBadge,
}: {
  spec: PlaybookDraftSpec
  onSpecChange: (spec: PlaybookDraftSpec) => void
  onValidationChange?: (validation: PlaybookValidationResult) => void
  layout?: LayoutStore | null
  onLayoutChange?: (layout: LayoutStore) => void
  templates?: CanvasStepTemplate[]
  statusBadge?: React.ReactNode
}) {
  const validation = useMemo(() => validatePlaybookDraftSpec(spec), [spec])
  const [view, setView] = useState<'canvas' | 'classic'>('canvas')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [editingNode, setEditingNode] = useState<EditingNode | null>(null)
  const [stepForm, setStepForm] = useState<StepFormState | null>(null)
  const [gateForm, setGateForm] = useState<GateFormState | null>(null)
  const [stepFormError, setStepFormError] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameForm, setNameForm] = useState('')

  useEffect(() => {
    onValidationChange?.(validation)
  }, [validation, onValidationChange])

  function updateSpec(next: PlaybookDraftSpec) {
    onSpecChange(next)
  }

  function openJsonEditor() {
    setJsonText(JSON.stringify(spec, null, 2))
    setJsonError(null)
    setJsonOpen(true)
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText) as PlaybookDraftSpec
      const synced = syncPlaybookSpecInputSlots(parsed)
      updateSpec(synced)
      setJsonOpen(false)
      setJsonError(null)
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Érvénytelen JSON')
    }
  }

  const handleNodeClick = useCallback((payload: NodeClickPayload) => {
    setStepFormError(null)
    if (payload.type === 'step') {
      setStepForm(stepFormFromRaw(payload.data as RawStep, spec.roles, readDefaultErrorPolicy(spec)))
      setGateForm(null)
    } else {
      const g = payload.data as RawGate
      setStepForm(null)
      setGateForm(gateFormFromRaw(g))
    }
    setEditingNode(payload)
  }, [spec])

  function saveNodeEdit() {
    if (!editingNode) return
    const newSpec = structuredClone(spec) as PlaybookDraftSpec

    if (editingNode.type === 'step') {
      if (!stepForm) return
      const existing = (newSpec.steps ?? []).find((s) => s.id === editingNode.id)
      if (!existing) return
      const { stepPatch, jsonError } = buildStepFromForm(existing, stepForm)
      if (jsonError) {
        setStepFormError(jsonError)
        return
      }
      setStepFormError(null)
      const assignedRole = stepPatch.assignedRole
      newSpec.steps = (newSpec.steps ?? []).map((s) => (s.id === editingNode.id ? stepPatch : s))
      if (assignedRole) {
        newSpec.roles = upsertRoleType(
          newSpec.roles as PlaybookRole[] | undefined,
          assignedRole,
          stepForm.roleType,
          stepForm.requiredCapabilities,
        )
      }
    } else {
      if (!gateForm) return
      const existing = (newSpec.gates ?? []).find((g) => g.id === editingNode.id)
      if (!existing) return
      newSpec.gates = (newSpec.gates ?? []).map((g) =>
        g.id === editingNode.id ? buildGateFromForm(existing, gateForm) : g,
      )
    }

    updateSpec(newSpec)
    setEditingNode(null)
    setStepForm(null)
    setGateForm(null)
  }

  const stepIds = (spec.steps ?? []).map((s) => s.id).filter(Boolean) as string[]
  const gateIds = (spec.gates ?? []).map((g) => g.id).filter(Boolean) as string[]

  function applyAgentResult(result: {
    spec: PlaybookDraftSpec
    validation: PlaybookValidationResult
  }) {
    updateSpec(result.spec)
    if (editingNode?.type === 'step') {
      const updated = result.spec.steps?.find((s) => s.id === editingNode.id)
      if (updated) {
        setStepForm(stepFormFromRaw(updated, result.spec.roles, readDefaultErrorPolicy(result.spec)))
      }
    } else if (editingNode?.type === 'gate') {
      const updated = result.spec.gates?.find((g) => g.id === editingNode.id)
      if (updated) {
        setGateForm(gateFormFromRaw(updated))
      }
    }
  }

  function saveName() {
    if (!nameForm.trim()) {
      setEditingName(false)
      return
    }
    updateSpec({ ...spec, name: nameForm.trim() })
    setEditingName(false)
  }

  return (
    <>
      <div className="space-y-3 rounded-lg border border-ink/10 p-3">
        <div className="flex items-center gap-2">
          {editingName ? (
            <>
              <input
                autoFocus
                value={nameForm}
                onChange={(e) => setNameForm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName()
                  if (e.key === 'Escape') setEditingName(false)
                }}
                className="flex-1 rounded border border-accent/40 bg-transparent px-2 py-1 text-sm font-semibold"
              />
              <button onClick={saveName} className="rounded bg-accent px-2 py-1 text-xs text-white">
                OK
              </button>
              <button
                onClick={() => setEditingName(false)}
                className="rounded border border-ink/20 px-2 py-1 text-xs"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setNameForm(spec.name ?? '')
                setEditingName(true)
              }}
              className="group flex items-center gap-1 text-sm"
              title="Folyamatnév szerkesztése"
            >
              <span className="font-semibold">{spec.name ?? '(névtelen)'}</span>{' '}
              <span className="font-mono text-xs text-ink-soft">{spec.key}</span>
              <span className="ml-1 text-ink/30 opacity-0 transition-opacity group-hover:opacity-100">
                ✎
              </span>
            </button>
          )}

          <button
            onClick={openJsonEditor}
            className="ml-auto rounded border border-ink/20 px-2.5 py-1 text-xs text-ink-soft hover:border-accent/40 hover:text-accent"
            title="JSON megtekintése / szerkesztése"
          >
            {'{ } JSON'}
          </button>
        </div>

        <label className="block text-xs">
          <span className="text-ink-soft mb-0.5 block">Playbook kritikusság</span>
          <select
            value={readEffectiveCriticality(spec)}
            onChange={(e) => updateSpec(applySpecCriticality(spec, e.target.value))}
            className="w-full max-w-xs rounded border border-ink/15 bg-transparent px-2 py-1 text-sm"
          >
            <option value="">— nincs megadva —</option>
            {PLAYBOOK_CRITICALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-ink-faint">
            A playbook és az összes kapu kritikusságát egyszerre állítja.
          </p>
          {summarizeSpecCriticality(spec).fourEyes && (
            <p className="mt-1 text-honey">
              L2/L3 esetén a publikáló nem lehet ugyanaz, aki a draftot készítette (four-eyes).
            </p>
          )}
        </label>

        <PlaybookAgentAssist
          scope="spec"
          spec={spec}
          validation={validation}
          onApply={applyAgentResult}
        />

        <div className="flex items-center gap-1 text-xs">
          <span className="mr-1 text-ink-soft">Nézet:</span>
          <button
            onClick={() => setView('canvas')}
            className={
              view === 'canvas'
                ? 'rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-ink/20 px-2.5 py-1 text-xs text-ink-soft'
            }
          >
            🎛 Vászon
          </button>
          <button
            onClick={() => setView('classic')}
            className={
              view === 'classic'
                ? 'rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-ink/20 px-2.5 py-1 text-xs text-ink-soft'
            }
          >
            📊 Klasszikus
          </button>
        </div>

        {view === 'canvas' ? (
          <PlaybookCanvas
            spec={spec}
            onSpecChange={updateSpec}
            layout={layout ?? null}
            onLayoutChange={onLayoutChange ?? (() => {})}
            validation={validation}
            templates={templates}
            statusBadge={statusBadge}
          />
        ) : (
          <>
            <PlaybookFlowGraph spec={spec} onNodeClick={handleNodeClick} />

        {editingNode && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-accent">
                {editingNode.type === 'step' ? '📋 Lépés szerkesztése' : '◆ Kapu szerkesztése'}:{' '}
                {editingNode.id}
              </p>
              <button
                onClick={() => setEditingNode(null)}
                className="text-ink/40 hover:text-ink text-sm"
              >
                ✕
              </button>
            </div>

            <PlaybookAgentAssist
              scope={editingNode.type === 'step' ? 'step' : 'gate'}
              focusId={editingNode.id}
              focusLabel={
                editingNode.type === 'step'
                  ? (stepForm?.name || editingNode.id)
                  : editingNode.id
              }
              spec={spec}
              validation={validation}
              onApply={applyAgentResult}
              compact
            />

            {editingNode.type === 'step' && stepForm ? (
              <>
                <PlaybookStepEditorForm
                  form={stepForm}
                  onChange={setStepForm}
                  stepIds={stepIds.filter((id) => id !== editingNode.id)}
                  gateIds={gateIds}
                  roles={spec.roles}
                  defaultErrorPolicy={readDefaultErrorPolicy(spec)}
                />
                {stepFormError && <p className="text-xs text-coral">{stepFormError}</p>}
              </>
            ) : gateForm ? (
              <PlaybookGateEditorForm
                form={gateForm}
                onChange={setGateForm}
                roles={spec.roles}
              />
            ) : null}

            <div className="flex gap-2 pt-1">
              <button
                onClick={saveNodeEdit}
                className="rounded bg-accent px-3 py-1 text-xs text-white"
              >
                Mentés
              </button>
              <button
                onClick={() => setEditingNode(null)}
                className="rounded border border-ink/20 px-3 py-1 text-xs"
              >
                Mégsem
              </button>
            </div>
          </div>
        )}

        <div className="space-y-1 text-xs">
          <p className={validation.valid ? 'font-semibold text-sage' : 'font-semibold text-coral'}>
            {validation.valid ? 'Valid — menthető.' : 'Nem valid — javítsd a hibákat.'}
          </p>
          {validation.errors.map((e, i) => (
            <p key={`err-${i}`} className="text-coral">
              {e.path}: {e.message}
            </p>
          ))}
          {validation.warnings.map((w, i) => (
            <p key={`warn-${i}`} className="text-honey">
              {w.path}: {w.message}
            </p>
          ))}
        </div>
          </>
        )}
      </div>

      {jsonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-ink/20 bg-paper p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-semibold">Playbook JSON</h3>
              <button onClick={() => setJsonOpen(false)} className="text-ink/40 hover:text-ink">
                ✕
              </button>
            </div>
            <textarea
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value)
                setJsonError(null)
              }}
              rows={24}
              spellCheck={false}
              className="w-full rounded-lg border border-ink/15 bg-paper/60 px-3 py-2 font-mono text-xs"
            />
            {jsonError && <p className="text-xs text-coral">{jsonError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setJsonOpen(false)}
                className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm"
              >
                Mégse
              </button>
              <button
                onClick={applyJson}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
              >
                Alkalmaz
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
