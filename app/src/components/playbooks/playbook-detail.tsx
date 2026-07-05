'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createPlaybookVersionV2,
  updatePlaybookVersionV2,
  updatePlaybookMetaV2,
  validatePlaybookVersionV2,
  submitPlaybookVersionV2,
  publishPlaybookVersionV2,
  rejectPlaybookVersionV2,
  assignPlaybookV2,
  listStepTemplates,
} from '@/app/actions/playbook'
import type { CanvasStepTemplate } from '@/components/playbooks/playbook-canvas'
import type { LayoutStore } from '@/lib/playbook-v2/canvas-mapping'
import { PlaybookAuthorPanel } from '@/components/playbooks/playbook-author-panel'
import { summarizeSpecCriticality } from '@/components/playbooks/playbook-criticality-ui'
import {
  PlaybookSpecEditor,
  type PlaybookDraftSpec,
  type PlaybookValidationResult,
  syncPlaybookSpecInputSlots,
  validatePlaybookDraftSpec,
} from '@/components/playbooks/playbook-spec-editor'

type ValidationResult = {
  valid: boolean
  errors: Array<{ code: string; path: string; message: string }>
  warnings: Array<{ code: string; path: string; message: string }>
}

export type VersionView = {
  id: string
  version: number
  status: string
  changeSummary: string
  contentHash: string
  spec: unknown
  layout: unknown
  validationResult: unknown
  publishedAt: string | null
  createdAt: string
}

function asLayout(v: unknown): LayoutStore | null {
  if (!v || typeof v !== 'object') return null
  return v as LayoutStore
}

export type PlaybookHead = {
  id: string
  key: string
  name: string
  description: string | null
  processType: string
  status: string
}

const VERSION_LABEL: Record<string, string> = {
  draft: 'Piszkozat',
  pending_approval: 'Jóváhagyásra vár',
  published: 'Publikált',
  rejected: 'Elutasított',
  retired: 'Visszavont',
}

const VERSION_TONE: Record<string, string> = {
  draft: 'bg-ink/8 text-ink-soft',
  pending_approval: 'bg-honey/15 text-honey',
  published: 'bg-sage/15 text-sage',
  rejected: 'bg-coral/15 text-coral',
  retired: 'bg-ink/8 text-ink-soft',
}

const STARTER_SPEC = (key: string, processType: string): PlaybookDraftSpec =>
  ({
    schemaVersion: '1.0',
    key,
    name: key,
    processType,
    entryStepId: 'extract',
    roles: [
      { key: 'extractor', type: 'agent_role' },
      { key: 'approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
    ],
    steps: [
      {
        id: 'extract',
        name: 'Adatkinyerés',
        ticketType: 'interaction',
        assignedRole: 'extractor',
        allowedStates: ['ready', 'in_progress', 'done'],
        onComplete: [{ condition: 'default', nextStepId: 'approval' }],
      },
      {
        id: 'approval',
        name: 'Jóváhagyás',
        ticketType: 'interaction',
        assignedRole: 'approver',
        allowedStates: ['awaiting_human', 'approved'],
        requiredGateIds: ['approve_posting'],
      },
    ],
    gates: [
      {
        id: 'approve_posting',
        type: 'human_approval',
        requiredActorRole: 'approver',
        blocking: true,
        criticality: 'L2',
        evidenceRequired: true,
      },
    ],
    transitions: [{ fromStepId: 'extract', toStepId: 'approval', trigger: 'step.completed' }],
    outputContract: { requiredFields: ['decision'] },
  }) as unknown as PlaybookDraftSpec

function asValidation(v: unknown): ValidationResult | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<ValidationResult>
  if (typeof r.valid !== 'boolean') return null
  return { valid: r.valid, errors: r.errors ?? [], warnings: r.warnings ?? [] }
}

function VersionSpecEditor({
  mode,
  versionLabel,
  spec,
  changeSummary,
  validation,
  pending,
  layout,
  onLayoutChange,
  templates,
  onSpecChange,
  onValidationChange,
  onSummaryChange,
  onSaveDraft,
  onCreateNew,
  onClose,
}: {
  mode: 'edit' | 'new' | 'fork'
  versionLabel: string
  spec: PlaybookDraftSpec
  changeSummary: string
  validation: PlaybookValidationResult
  pending: boolean
  layout: LayoutStore | null
  onLayoutChange: (layout: LayoutStore) => void
  templates: CanvasStepTemplate[]
  onSpecChange: (spec: PlaybookDraftSpec) => void
  onValidationChange: (v: PlaybookValidationResult) => void
  onSummaryChange: (v: string) => void
  onSaveDraft: () => void
  onCreateNew: () => void
  onClose: () => void
}) {
  const title =
    mode === 'edit'
      ? `Piszkozat szerkesztése — ${versionLabel}`
      : mode === 'fork'
        ? `Új verzió — ${versionLabel} alapján`
        : 'Új verzió'

  const description =
    mode === 'fork'
      ? 'A publikált verzió nem módosítható — a változtatások csak új piszkozat-verzióként menthetők.'
      : 'Húzd a palettáról az elemeket a vászonra, kösd össze őket, és a jobb oldali szerkesztőben állítsd be a részleteket. JSON csak debug célra.'

  return (
    <section className="atelier-card p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-ink-soft">{description}</p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink"
        >
          Bezárás
        </button>
      </div>

      <PlaybookSpecEditor
        spec={spec}
        onSpecChange={onSpecChange}
        onValidationChange={onValidationChange}
        layout={layout}
        onLayoutChange={onLayoutChange}
        templates={templates}
      />

      <div className="mt-4 space-y-2">
        <input
          value={changeSummary}
          onChange={(e) => onSummaryChange(e.target.value)}
          placeholder="Változás összefoglaló (kötelező)"
          className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          {mode === 'edit' && (
            <button
              onClick={onSaveDraft}
              disabled={pending || !validation.valid}
              className="rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? 'Mentés…' : 'Mentés'}
            </button>
          )}
          {(mode === 'new' || mode === 'fork' || mode === 'edit') && (
            <button
              onClick={onCreateNew}
              disabled={pending || !validation.valid}
              className={
                mode === 'new' || mode === 'fork'
                  ? 'rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
                  : 'rounded-lg border border-ink/20 px-4 py-2 text-sm text-ink disabled:opacity-50'
              }
            >
              {pending ? 'Létrehozás…' : 'Mentés új verzióként'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export function PlaybookDetail({
  playbook,
  versions,
  canEdit,
  canApprove,
}: {
  playbook: PlaybookHead
  versions: VersionView[]
  canEdit: boolean
  canApprove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const editorRef = useRef<HTMLDivElement>(null)

  const [editorMode, setEditorMode] = useState<'edit' | 'new' | 'fork' | null>(null)
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null)
  const [spec, setSpec] = useState<PlaybookDraftSpec | null>(null)
  const [layout, setLayout] = useState<LayoutStore | null>(null)
  const [validation, setValidation] = useState<PlaybookValidationResult | null>(null)
  const [changeSummary, setChangeSummary] = useState('')
  const [templates, setTemplates] = useState<CanvasStepTemplate[]>([])

  useEffect(() => {
    if (!canEdit) return
    let active = true
    listStepTemplates().then((res) => {
      if (active && res.success) setTemplates(res.data as CanvasStepTemplate[])
    })
    return () => {
      active = false
    }
  }, [canEdit])

  const [editingMeta, setEditingMeta] = useState(false)
  const [metaName, setMetaName] = useState(playbook.name)
  const [metaDescription, setMetaDescription] = useState(playbook.description ?? '')

  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    setMessage(null)
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        setMessage({ tone: 'ok', text: okText })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error ?? 'Hiba' })
      }
    })
  }

  function openEdit(v: VersionView) {
    const loaded = syncPlaybookSpecInputSlots(v.spec as PlaybookDraftSpec)
    setEditorMode('edit')
    setEditingVersionId(v.id)
    setSpec(loaded)
    setLayout(asLayout(v.layout))
    setValidation(asValidation(v.validationResult) ?? validatePlaybookDraftSpec(loaded))
    setChangeSummary(v.changeSummary)
    setMessage(null)
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function openFork(v: VersionView) {
    const loaded = syncPlaybookSpecInputSlots(v.spec as PlaybookDraftSpec)
    setEditorMode('fork')
    setEditingVersionId(v.id)
    setSpec(loaded)
    setLayout(asLayout(v.layout))
    setValidation(asValidation(v.validationResult) ?? validatePlaybookDraftSpec(loaded))
    setChangeSummary('')
    setMessage(null)
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function openNew() {
    const starter = STARTER_SPEC(playbook.key, playbook.processType)
    setEditorMode('new')
    setEditingVersionId(null)
    setSpec(starter)
    setLayout(null)
    setValidation(validatePlaybookDraftSpec(starter))
    setChangeSummary('')
    setMessage(null)
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function closeEditor() {
    setEditorMode(null)
    setEditingVersionId(null)
    setSpec(null)
    setLayout(null)
    setValidation(null)
    setChangeSummary('')
    setMessage(null)
  }

  function validateBeforeSave(): boolean {
    if (!spec) {
      setMessage({ tone: 'err', text: 'Nincs spec a mentéshez.' })
      return false
    }
    if (!changeSummary.trim()) {
      setMessage({ tone: 'err', text: 'Adj meg változás-összefoglalót.' })
      return false
    }
    if (!validation?.valid) {
      setMessage({ tone: 'err', text: 'A spec nem valid — javítsd a hibákat mentés előtt.' })
      return false
    }
    return true
  }

  function saveDraft() {
    if (!validateBeforeSave() || !editingVersionId || !spec) return
    startTransition(async () => {
      const res = await updatePlaybookVersionV2({
        playbookVersionId: editingVersionId,
        spec,
        changeSummary,
        layout: layout ?? undefined,
      })
      if (res.success) {
        const v = asValidation(res.data.validation)
        setMessage({
          tone: v?.valid ? 'ok' : 'err',
          text: v?.valid
            ? `v${res.data.version} mentve, validáció zöld.`
            : `v${res.data.version} mentve, de szemantikai hibák: ${v?.errors.map((e) => e.code).join(', ') ?? '—'}`,
        })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error ?? 'Hiba' })
      }
    })
  }

  function createNew() {
    if (!validateBeforeSave() || !spec) return
    startTransition(async () => {
      const res = await createPlaybookVersionV2({
        playbookId: playbook.id,
        spec,
        changeSummary,
        layout: layout ?? undefined,
      })
      if (res.success) {
        const v = asValidation(res.data.validation)
        setMessage({
          tone: v?.valid ? 'ok' : 'err',
          text: v?.valid
            ? `v${res.data.version} létrehozva, validáció zöld.`
            : `v${res.data.version} létrehozva, de szemantikai hibák: ${v?.errors.map((e) => e.code).join(', ') ?? '—'}`,
        })
        closeEditor()
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error ?? 'Hiba' })
      }
    })
  }

  const editingVersion = versions.find((v) => v.id === editingVersionId)

  return (
    <div className="space-y-6">
      <div className="atelier-card p-5">
        {editingMeta ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                value={metaName}
                onChange={(e) => setMetaName(e.target.value)}
                className="flex-1 rounded-lg border border-ink/15 bg-transparent px-3 py-1.5 text-sm font-semibold"
                placeholder="Név"
              />
              <span className="font-mono text-xs text-ink-soft">{playbook.key}</span>
            </div>
            <textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              rows={3}
              placeholder="Leírás (opcionális)"
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!metaName.trim()) {
                    setMessage({ tone: 'err', text: 'A név nem lehet üres.' })
                    return
                  }
                  run(
                    () =>
                      updatePlaybookMetaV2({
                        playbookId: playbook.id,
                        name: metaName.trim(),
                        description: metaDescription.trim() || null,
                      }),
                    'Playbook frissítve.',
                  )
                  setEditingMeta(false)
                }}
                disabled={pending}
                className="rounded-lg bg-coral px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Mentés
              </button>
              <button
                onClick={() => {
                  setMetaName(playbook.name)
                  setMetaDescription(playbook.description ?? '')
                  setEditingMeta(false)
                }}
                className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink"
              >
                Mégse
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-semibold">{playbook.name}</h2>
                <span className="font-mono text-xs text-ink-soft">{playbook.key}</span>
              </div>
              {playbook.description && (
                <p className="mt-1 text-sm text-ink-soft">{playbook.description}</p>
              )}
              <p className="mt-1 text-xs text-ink-faint">Folyamattípus: {playbook.processType}</p>
            </div>
            {canEdit && (
              <button
                onClick={() => setEditingMeta(true)}
                className="shrink-0 rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink"
              >
                Szerkesztés
              </button>
            )}
          </div>
        )}
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>
          {message.text}
        </p>
      )}

      {canEdit && <PlaybookAuthorPanel playbookId={playbook.id} />}

      <section className="atelier-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Verziók</h2>
          {canEdit && (
            <button
              onClick={openNew}
              disabled={pending}
              className="rounded-lg bg-coral px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              + Új verzió
            </button>
          )}
        </div>

        {versions.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Még nincs verzió.{' '}
            {canEdit && (
              <button onClick={openNew} className="text-coral underline">
                Hozz létre egyet.
              </button>
            )}
          </p>
        ) : (
          <ul className="space-y-3">
            {versions.map((v) => {
              const versionValidation = asValidation(v.validationResult)
              const isBeingEdited = editingVersionId === v.id
              const crit = summarizeSpecCriticality(v.spec)
              return (
                <li
                  key={v.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    isBeingEdited ? 'border-coral/40 bg-coral/5' : 'border-ink/10'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">v{v.version}</span>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          VERSION_TONE[v.status] ?? 'bg-ink/8 text-ink-soft'
                        }`}
                      >
                        {VERSION_LABEL[v.status] ?? v.status}
                      </span>
                      {versionValidation && (
                        <span
                          className={`text-xs ${versionValidation.valid ? 'text-sage' : 'text-coral'}`}
                        >
                          {versionValidation.valid ? '✓ valid' : `${versionValidation.errors.length} hiba`}
                        </span>
                      )}
                      {crit.level && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            crit.fourEyes ? 'bg-honey/15 text-honey' : 'bg-ink/8 text-ink-soft'
                          }`}
                          title={crit.fourEyes ? 'Four-eyes kötelező publikáláskor' : undefined}
                        >
                          {crit.level}
                          {crit.fourEyes ? ' · four-eyes' : ''}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-ink-faint">
                      {v.contentHash.slice(0, 16)}…
                    </span>
                  </div>

                  {v.changeSummary && (
                    <p className="mt-1 text-xs text-ink-soft">{v.changeSummary}</p>
                  )}

                  {versionValidation && !versionValidation.valid && versionValidation.errors.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {versionValidation.errors.map((e, i) => (
                        <li key={i} className="font-mono text-[11px] text-coral">
                          {e.code} @ {e.path}: {e.message}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {canEdit && v.status === 'draft' && (
                      <>
                        <button
                          onClick={() => (isBeingEdited ? closeEditor() : openEdit(v))}
                          disabled={pending}
                          className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${
                            isBeingEdited
                              ? 'border-coral/50 text-coral'
                              : 'border-ink/20 text-ink'
                          }`}
                        >
                          {isBeingEdited ? 'Szerkesztő bezárása' : 'Szerkesztés'}
                        </button>
                        <button
                          onClick={() =>
                            run(
                              () => validatePlaybookVersionV2({ playbookVersionId: v.id }),
                              'Validáció lefutott.',
                            )
                          }
                          disabled={pending}
                          className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink disabled:opacity-50"
                        >
                          Validálás
                        </button>
                        <button
                          onClick={() =>
                            run(
                              () => submitPlaybookVersionV2({ playbookVersionId: v.id }),
                              'Jóváhagyásra küldve.',
                            )
                          }
                          disabled={pending}
                          className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink disabled:opacity-50"
                        >
                          Jóváhagyásra küldés
                        </button>
                      </>
                    )}
                    {canApprove && v.status === 'pending_approval' && (
                      <>
                        <button
                          onClick={() =>
                            run(
                              () => publishPlaybookVersionV2({ playbookVersionId: v.id }),
                              'Verzió publikálva.',
                            )
                          }
                          disabled={pending}
                          className="rounded-lg bg-coral px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Publikálás
                        </button>
                        <button
                          onClick={() => {
                            const reason = prompt('Elutasítás indoka:')
                            if (reason)
                              run(
                                () => rejectPlaybookVersionV2({ playbookVersionId: v.id, reason }),
                                'Verzió elutasítva.',
                              )
                          }}
                          disabled={pending}
                          className="rounded-lg border border-coral/40 px-3 py-1.5 text-xs text-coral disabled:opacity-50"
                        >
                          Elutasítás
                        </button>
                      </>
                    )}
                    {canEdit && v.status === 'published' && (
                      <>
                        <button
                          onClick={() => (isBeingEdited ? closeEditor() : openFork(v))}
                          disabled={pending}
                          className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${
                            isBeingEdited
                              ? 'border-coral/50 text-coral'
                              : 'border-ink/20 text-ink'
                          }`}
                        >
                          {isBeingEdited ? 'Szerkesztő bezárása' : 'Szerkesztés'}
                        </button>
                        <button
                          onClick={() =>
                            run(
                              () =>
                                assignPlaybookV2({
                                  playbookVersionId: v.id,
                                  assignmentType: 'process_type',
                                  assignmentKey: playbook.processType,
                                  isDefault: true,
                                }),
                              `Alapértelmezett Playbook beállítva: ${playbook.processType}.`,
                            )
                          }
                          disabled={pending}
                          className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs text-ink disabled:opacity-50"
                        >
                          Beállítás alapértelmezettnek ({playbook.processType})
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {editorMode && spec && validation && (
        <div ref={editorRef}>
          <VersionSpecEditor
            mode={editorMode}
            versionLabel={editingVersion ? `v${editingVersion.version}` : ''}
            spec={spec}
            changeSummary={changeSummary}
            validation={validation}
            pending={pending}
            layout={layout}
            onLayoutChange={setLayout}
            templates={templates}
            onSpecChange={setSpec}
            onValidationChange={setValidation}
            onSummaryChange={setChangeSummary}
            onSaveDraft={saveDraft}
            onCreateNew={createNew}
            onClose={closeEditor}
          />
        </div>
      )}
    </div>
  )
}
