'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { Agent } from '@prisma/client'
import {
  activateTraining,
  previewTrainingChange,
  rejectTraining,
  rollbackMemory,
  submitTrainingProposal,
} from '@/app/actions/platform'
import { AgentAssigneeSelect } from '@/components/agents/agent-assignee-select'
import {
  clearTrainingPreviewSession,
  previewStateFromActionData,
  useTrainingPreviewSession,
  writeTrainingPreviewSession,
} from '@/components/agents/training-preview-session'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Badge, Card } from '@/components/ui/shell'
import { Spinner } from '@/components/ui/spinner'
import {
  EMPTY_MEMORY_PLACEHOLDER,
  parseMemoryItems,
} from '@/domain/training/memory-items'
import type {
  ChangeSummary,
  ImpactResult,
  TrainingCompositionMode,
} from '@/domain/training/training-composition'
import type { TrainingWorkspaceView } from '@/domain/training/training-workspace-contract'
import { TRAINING_USER_ERRORS } from '@/domain/training/durable-memory-policy'

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleString('hu-HU')
}

function previewContent(content: string | null | undefined, max = 400): string {
  const text = (content ?? '').trim() || EMPTY_MEMORY_PLACEHOLDER
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function ChangeImpactSummary({
  changeSummary,
  impactResult,
}: {
  changeSummary: ChangeSummary
  impactResult: ImpactResult
}) {
  const tone =
    impactResult.verdict === 'blocked'
      ? 'text-coral-deep'
      : impactResult.verdict === 'changes'
        ? 'text-honey'
        : 'text-sage'

  return (
    <div className="mb-3">
      <p className={`mb-3 text-sm font-semibold ${tone}`}>
        {impactResult.verdict === 'complements' && 'Kiegészíti a meglévő szabályokat'}
        {impactResult.verdict === 'changes' && 'Megváltoztatja a meglévő szabályokat'}
        {impactResult.verdict === 'blocked' && 'Ez a tanítás nem engedhető meg'}
      </p>
      {changeSummary.added.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-semibold text-ink-faint">Új szabályok</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {changeSummary.added.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {changeSummary.rewritten.map((item) => (
        <div key={`${item.from}-${item.to}`} className="mb-3 space-y-1">
          <p className="text-xs font-semibold text-ink-faint">Régi szabály</p>
          <p className="text-sm text-ink-soft">{item.from}</p>
          <p className="text-xs font-semibold text-ink-faint">Új szabály</p>
          <p className="text-sm text-ink">{item.to}</p>
        </div>
      ))}
      {changeSummary.removed.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-semibold text-ink-faint">Megszűnő szabályok</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {changeSummary.removed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {impactResult.nextStep && (
        <p className="text-sm text-ink-soft">{impactResult.nextStep}</p>
      )}
    </div>
  )
}

export function TrainingWorkspace({
  agents,
  selectedAgentId,
  workspace,
  lockAgent = false,
}: {
  agents: Agent[]
  selectedAgentId?: string
  workspace: TrainingWorkspaceView<string | Date> | null
  lockAgent?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [previewPending, setPreviewPending] = useState(false)
  const [agentId, setAgentId] = useState(selectedAgentId ?? agents[0]?.id ?? '')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [compositionMode, setCompositionMode] = useState<TrainingCompositionMode>('build_on_pending')
  const [showFullVersion, setShowFullVersion] = useState(false)
  const [submitPending, setSubmitPending] = useState(false)
  const [submitResult, setSubmitResult] = useState<{
    ticketId: string
    outcome: 'activated' | 'awaiting_approval'
    targetMemoryVersion: number
    revision: number
  } | null>(null)
  const [rejectDialog, setRejectDialog] = useState<{ own: boolean; ticketId: string } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)
  const rejectButtonRef = useRef<HTMLButtonElement>(null)
  const previewSession = useTrainingPreviewSession(agentId)
  const preview = previewSession.preview
  const previewError = previewSession.error
  const newItem = previewSession.draft
  const busy = pending || previewPending || submitPending
  const showCompositionChoice = Boolean(workspace?.pendingProposal)

  useEffect(() => {
    if (workspace?.pendingProposal) return
    if (previewError !== TRAINING_USER_ERRORS.composition_required) return
    writeTrainingPreviewSession(agentId, { preview, error: null })
  }, [agentId, preview, previewError, workspace?.pendingProposal])

  const selectedAgent = agents.find((a) => a.id === agentId)
  const isSelectedAgentLoaded = agentId === selectedAgentId
  const allowed = new Set(workspace?.allowedActions ?? [])
  const canPreview = allowed.has('preview')
  const memoryContent = workspace?.activeVersion?.content ?? ''
  const items = useMemo(
    () => (isSelectedAgentLoaded ? parseMemoryItems(memoryContent) : []),
    [isSelectedAgentLoaded, memoryContent],
  )
  const memoryVersions = workspace?.timeline ?? []
  const currentVersionId = workspace?.activeVersion?.id ?? null

  async function runPreview(
    instruction:
      | { kind: 'teach'; text: string }
      | { kind: 'item_change'; change: { operation: 'add'; text: string } | { operation: 'update'; itemIndex: number; text: string } | { operation: 'remove'; itemIndex: number } },
    mode: TrainingCompositionMode | null = compositionMode,
  ) {
    if (!isSelectedAgentLoaded) {
      setMessage('Az új agent szabályai még betöltés alatt vannak.')
      return
    }
    setMessage(null)
    setPreviewPending(true)
    try {
      const res = await previewTrainingChange({
        agentId,
        instruction,
        compositionMode: showCompositionChoice ? mode : null,
      })
      if (!res.success) {
        writeTrainingPreviewSession(agentId, { preview: null, error: res.error ?? 'Hiba' })
        return
      }
      const next = previewStateFromActionData(res.data)
      if (!next) {
        writeTrainingPreviewSession(agentId, {
          preview: null,
          error: 'Az előnézet nem jeleníthető meg. Próbáld újra.',
        })
        return
      }
      writeTrainingPreviewSession(agentId, { preview: next, error: null })
      setShowFullVersion(false)
      requestAnimationFrame(() => {
        previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    } catch (e) {
      writeTrainingPreviewSession(agentId, {
        preview: null,
        error: e instanceof Error ? e.message : 'Az előnézet nem sikerült',
      })
    } finally {
      setPreviewPending(false)
    }
  }

  async function runSubmit(activate: boolean) {
    if (!preview) return
    setMessage(null)
    setSubmitPending(true)
    try {
      const res = await submitTrainingProposal({ previewId: preview.previewId, activate })
      if (!res.success) {
        setMessage(res.error ?? 'Hiba')
        return
      }
      clearTrainingPreviewSession(agentId)
      setEditingIndex(null)
      setEditText('')
      setSubmitResult({
        ticketId: res.data.ticketId,
        outcome: res.data.outcome,
        targetMemoryVersion: res.data.targetMemoryVersion,
        revision: res.data.revision,
      })
      router.refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'A javaslat beküldése nem sikerült')
    } finally {
      setSubmitPending(false)
    }
  }

  const closeRejectDialog = useCallback(() => {
    if (submitPending) return
    setRejectDialog(null)
    setRejectReason('')
  }, [submitPending])

  async function confirmReject() {
    if (!rejectDialog) return
    const reason = rejectReason.trim()
    const own = rejectDialog.own
    setSubmitPending(true)
    try {
      const res = await rejectTraining({
        ticketId: rejectDialog.ticketId,
        ...(reason ? { reason } : {}),
      })
      setMessage(
        res.success
          ? own
            ? 'A javaslatot visszavontad.'
            : 'A javaslatot visszaküldted.'
          : (res.error ?? 'Hiba'),
      )
      if (res.success) {
        setRejectDialog(null)
        setRejectReason('')
        router.refresh()
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'A visszaküldés nem sikerült')
    } finally {
      setSubmitPending(false)
    }
  }

  return (
    <div className="space-y-6">
      {lockAgent ? null : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] max-w-md flex-1">
            <label htmlFor="training-agent" className="text-sm text-ink-soft">
              AI munkatárs
            </label>
            <AgentAssigneeSelect
              id="training-agent"
              agents={agents}
              value={agentId}
              disabled={busy}
              onChange={(nextAgentId) => {
                setEditingIndex(null)
                setEditText('')
                setExpandedVersion(null)
                setMessage(null)
                setSubmitResult(null)
                setRejectDialog(null)
                setRejectReason('')
                setAgentId(nextAgentId)
                router.push(`/control-plane/agents/${nextAgentId}/training`)
              }}
            />
          </div>
          {selectedAgent && (
            <Link
              href={`/control-plane/agents/${selectedAgent.id}/profile`}
              className="mb-2 text-sm text-sky hover:underline"
            >
              Adatlap →
            </Link>
          )}
        </div>
      )}

      <Card title="Betanított működési szabályok">
        <p className="mb-3 text-sm text-ink-soft">
          Ezeket a munkatárs minden releváns feladatnál betartja. A változtatás új, jóváhagyott
          szabályverziót készít — a korábbi verzió megmarad, és visszaállítható.
        </p>
        {!isSelectedAgentLoaded ? (
          <p className="text-sm text-ink-faint">Az agent szabályainak betöltése…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs rögzített szabály.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, index) => (
              <li key={`${index}-${item.slice(0, 24)}`} className="atelier-soft p-3">
                {editingIndex === index ? (
                  <div className="space-y-2">
                    <textarea
                      className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm"
                      rows={3}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      {canPreview && (
                        <button
                          type="button"
                          disabled={busy || !editText.trim()}
                          className="rounded-full bg-sage/20 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                          onClick={() =>
                            void runPreview({
                              kind: 'item_change',
                              change: { operation: 'update', itemIndex: index, text: editText },
                            })
                          }
                        >
                          {previewPending ? (
                            <span className="inline-flex items-center gap-2">
                              <Spinner size="sm" />
                              Elemzem a meglévő szabályokat…
                            </span>
                          ) : (
                            'Megnézem, mit változtat'
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft"
                        onClick={() => {
                          setEditingIndex(null)
                          setEditText('')
                        }}
                      >
                        Mégse
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap text-sm text-ink-soft">{item}</p>
                    {canPreview && (
                      <span className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30 disabled:opacity-50"
                          onClick={() => {
                            setEditingIndex(index)
                            setEditText(item)
                          }}
                        >
                          Szerkeszt
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10 disabled:opacity-50"
                          onClick={() => {
                            void (async () => {
                              const confirmed = await confirmDialog({
                                title: 'Szabály törlése',
                                description: 'Biztosan törlöd ezt a szabályt?',
                                confirmLabel: 'Törlés',
                                tone: 'danger',
                              })
                              if (!confirmed) return
                              runPreview({
                                kind: 'item_change',
                                change: { operation: 'remove', itemIndex: index },
                              })
                            })()
                          }}
                        >
                          Töröl
                        </button>
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canPreview && (
        <Card title="Új dolog megtanítása">
          <p className="mb-3 text-sm text-ink-soft">
            Írd le, mit szeretnél, hogy a munkatárs a továbbiakban tartson be.
          </p>
          <textarea
            className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm"
            rows={4}
            value={newItem}
            onChange={(e) => {
              writeTrainingPreviewSession(agentId, { draft: e.target.value })
            }}
            placeholder="Pl. Számláknál mindig ellenőrizd az ÁFA-kulcsot…"
          />
          {showCompositionChoice && workspace?.pendingProposal && (
            <div className="mb-3 space-y-3">
              <div className="atelier-soft p-3">
                <p className="mb-2 text-xs font-semibold text-ink-faint">
                  Ebbe a függő javaslatba építenél, vagy ezt cserélnéd le
                </p>
                <ChangeImpactSummary
                  changeSummary={workspace.pendingProposal.changeSummary}
                  impactResult={workspace.pendingProposal.impactResult}
                />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">
                  Van már egy függő javaslat. Mit tegyünk vele?
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {allowed.has('build_on_pending') && (
                    <button
                      type="button"
                      disabled={busy}
                      className={`rounded-xl border px-3 py-2 text-left text-sm ${
                        compositionMode === 'build_on_pending'
                          ? 'border-sky bg-sky/10 font-semibold text-sky'
                          : 'border-line text-ink-soft hover:bg-line/30'
                      }`}
                      onClick={() => setCompositionMode('build_on_pending')}
                    >
                      Beépítem a meglévő javaslatba
                    </button>
                  )}
                  {allowed.has('replace_pending') && (
                    <button
                      type="button"
                      disabled={busy}
                      className={`rounded-xl border px-3 py-2 text-left text-sm ${
                        compositionMode === 'replace_pending'
                          ? 'border-honey bg-honey/10 font-semibold text-honey'
                          : 'border-line text-ink-soft hover:bg-line/30'
                      }`}
                      onClick={() => setCompositionMode('replace_pending')}
                    >
                      Lecserélem a meglévő javaslatot
                    </button>
                  )}
                </div>
              </fieldset>
            </div>
          )}
          <button
            type="button"
            disabled={busy || !isSelectedAgentLoaded || !newItem.trim() || !agentId}
            className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
            onClick={() => void runPreview({ kind: 'teach', text: newItem })}
          >
            {previewPending ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" />
                Elemzem a meglévő szabályokat…
              </span>
            ) : (
              'Megnézem, mit változtat'
            )}
          </button>
          {previewError && previewError !== TRAINING_USER_ERRORS.composition_required && (
            <p className="mt-3 text-sm text-coral-deep">{previewError}</p>
          )}
        </Card>
      )}

      {preview && (
        <div ref={previewRef}>
          <Card title="A változás hatása">
            <ChangeImpactSummary
              changeSummary={preview.changeSummary}
              impactResult={preview.impactResult}
            />
            <button
              type="button"
              className="mb-3 text-xs text-sky hover:underline"
              onClick={() => setShowFullVersion((open) => !open)}
            >
              {showFullVersion ? 'Teljes javasolt verzió elrejtése' : 'Teljes javasolt verzió megtekintése'}
            </button>
            {showFullVersion && (
              <div className="mb-3">
                <p className="mb-1 text-xs font-semibold text-ink-faint">
                  Így nézne ki a teljes szabályverzió aktiválás után
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-3 text-xs text-ink-soft">
                  {preview.proposedVersion}
                </pre>
              </div>
            )}
            {preview.impactResult.verdict !== 'blocked' && (
              <div className="flex flex-wrap gap-2">
                {allowed.has('activate') && (
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                    onClick={() => void runSubmit(true)}
                  >
                    {submitPending ? (
                      <span className="inline-flex items-center gap-2">
                        <Spinner size="sm" />
                        Beküldés…
                      </span>
                    ) : (
                      'Aktiválom az új verziót'
                    )}
                  </button>
                )}
                {allowed.has('submit_for_approval') && !allowed.has('activate') && (
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
                    onClick={() => void runSubmit(false)}
                  >
                    {submitPending ? (
                      <span className="inline-flex items-center gap-2">
                        <Spinner size="sm" />
                        Beküldés…
                      </span>
                    ) : (
                      'Jóváhagyásra küldöm'
                    )}
                  </button>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      <Card title="Függőben lévő javaslat">
        {!workspace?.pendingProposal ? (
          <p className="text-sm text-ink-faint">Nincs jóváhagyásra váró tanítás.</p>
        ) : (
          <div className="atelier-soft p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium">
                Következő verzió v{workspace.pendingProposal.targetMemoryVersion}/r
                {workspace.pendingProposal.revision}
              </span>
              <Badge tone="warning">
                {workspace.pendingProposal.nextStep ?? 'Jóváhagyásra vár'}
              </Badge>
              <Link
                href={`/control-plane/tickets/${workspace.pendingProposal.ticketId}`}
                className="text-xs text-sky hover:underline"
              >
                Részlet
              </Link>
            </div>
            <ChangeImpactSummary
              changeSummary={workspace.pendingProposal.changeSummary}
              impactResult={workspace.pendingProposal.impactResult}
            />
            <p className="mb-1 text-xs font-semibold text-ink-faint">
              A javasolt teljes szabályverzió
            </p>
            <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
              {workspace.pendingProposal.proposedVersion}
            </pre>
            <div className="flex flex-wrap gap-2">
              {allowed.has('activate') && (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                  onClick={() => {
                    void (async () => {
                      setSubmitPending(true)
                      const res = await activateTraining({
                        ticketId: workspace.pendingProposal!.ticketId,
                        revisionId: workspace.pendingProposal!.revisionId,
                      })
                      setSubmitPending(false)
                      setMessage(res.success ? 'Az új szabályverzió életbe lépett.' : (res.error ?? 'Hiba'))
                      if (res.success) router.refresh()
                    })()
                  }}
                >
                  Jóváhagyom és aktiválom
                </button>
              )}
              {allowed.has('reject') && (
                <button
                  ref={rejectButtonRef}
                  type="button"
                  disabled={busy}
                  className="rounded-full border border-coral/30 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
                  onClick={() => {
                    setRejectReason('')
                    setRejectDialog({
                      own: Boolean(workspace.pendingProposal!.fourEyesWaiting),
                      ticketId: workspace.pendingProposal!.ticketId,
                    })
                  }}
                >
                  {workspace.pendingProposal.fourEyesWaiting ? 'Visszavonom' : 'Visszaküldöm'}
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Szabályverziók">
        <p className="mb-3 text-sm text-ink-soft">
          Nézd meg, milyen tartalomra állnál vissza, mielőtt megerősíted.
        </p>
        {memoryVersions.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs szabályverzió.</p>
        ) : (
          <ul className="space-y-2">
            {memoryVersions.map((v) => {
              const isCurrent = v.id === currentVersionId
              const open = expandedVersion === v.version
              return (
                <li key={`${v.version}-${v.createdAt}`} className="atelier-soft p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm text-ink-soft">
                      <span className="font-medium text-ink">v{v.version}</span>
                      {' — '}
                      {fmtDate(v.createdAt)}
                      {isCurrent && (
                        <span className="ml-2 inline-block">
                          <Badge tone="success">aktuális</Badge>
                        </span>
                      )}
                    </div>
                    <span className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30"
                        onClick={() => setExpandedVersion(open ? null : v.version)}
                      >
                        {open ? 'Előnézet bezárása' : 'Tartalom előnézet'}
                      </button>
                      {!isCurrent && allowed.has('rollback') && (
                        <button
                          type="button"
                          disabled={busy || !agentId}
                          className="rounded-full bg-honey/20 px-3 py-1 text-xs font-semibold text-honey disabled:opacity-50"
                          onClick={() => {
                            void (async () => {
                              const snippet = previewContent(v.content, 800)
                              const confirmed = await confirmDialog({
                                title: `Visszaállítás: v${v.version}`,
                                description: `Biztosan visszaállítod a szabályokat a(z) v${v.version} állapotra?\n\n${snippet}`,
                                confirmLabel: 'Visszaállítás',
                                tone: 'danger',
                              })
                              if (!confirmed) return
                              startTransition(async () => {
                                const res = await rollbackMemory({
                                  agentId,
                                  toVersion: v.version,
                                })
                                setMessage(
                                  res.success
                                    ? `Visszaállítás kész — most a v${v.version} az aktív.`
                                    : (res.error ?? 'A visszaállítás sikertelen'),
                                )
                                if (res.success) router.refresh()
                              })
                            })()
                          }}
                        >
                          Vissza erre
                        </button>
                      )}
                    </span>
                  </div>
                  {open && (
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-3 text-xs text-ink-soft">
                      {(v.content ?? '').trim() || EMPTY_MEMORY_PLACEHOLDER}
                    </pre>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {(message || (previewError && previewError !== TRAINING_USER_ERRORS.composition_required)) && (
        <p
          className={`text-sm ${(message ?? previewError ?? '').toLowerCase().includes('hiba') || (message ?? previewError ?? '').toLowerCase().includes('sikertelen') || (message ?? previewError ?? '').toLowerCase().includes('nem') ? 'text-coral-deep' : 'text-ink-soft'}`}
        >
          {message ?? previewError}
        </p>
      )}

      {rejectDialog && (
        <TrainingRejectModal
          own={rejectDialog.own}
          pending={submitPending}
          reason={rejectReason}
          returnFocusRef={rejectButtonRef}
          onReasonChange={setRejectReason}
          onCancel={closeRejectDialog}
          onConfirm={() => {
            void confirmReject()
          }}
        />
      )}

      {submitResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setSubmitResult(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-submit-title"
            className="atelier-card w-full max-w-md p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="training-submit-title" className="font-display text-lg font-semibold">
              {submitResult.outcome === 'activated'
                ? 'Az új szabályverzió életbe lépett'
                : 'Tanítási ticket létrejött'}
            </h3>
            {submitResult.outcome === 'activated' ? (
              <p className="mt-2 text-sm text-ink-soft">
                A v{submitResult.targetMemoryVersion} szabályverzió mostantól érvényes.
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">
                A tanítási javaslat ticketként létrejött (v{submitResult.targetMemoryVersion}/r
                {submitResult.revision}). Egy megfelelő joggal rendelkező jóváhagyó vagy
                adminisztrátor hagyhatja jóvá — ha te magad nem vagy jóváhagyó, a saját
                javaslatodat nem aktiválhatod.
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Link
                href={`/control-plane/tickets/${submitResult.ticketId}`}
                className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky"
                onClick={() => setSubmitResult(null)}
              >
                Ticket megnyitása
              </Link>
              <button
                type="button"
                className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft"
                onClick={() => setSubmitResult(null)}
              >
                Bezár
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TrainingRejectModal({
  own,
  pending,
  reason,
  returnFocusRef,
  onReasonChange,
  onCancel,
  onConfirm,
}: {
  own: boolean
  pending: boolean
  reason: string
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onReasonChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const reasonId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const returnFocusTarget = returnFocusRef.current
    textareaRef.current?.focus()
    return () => returnFocusTarget?.focus()
  }, [mounted, returnFocusRef])

  if (!mounted) return null

  const title = own ? 'Javaslat visszavonása' : 'Javaslat visszaküldése'
  const question = own ? 'Miért vonod vissza a javaslatot?' : 'Miért küldöd vissza a javaslatot?'
  const confirmLabel = own ? 'Visszavonom' : 'Visszaküldöm'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={() => !pending && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="atelier-card w-full max-w-md p-5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const order: HTMLElement[] = []
          if (textareaRef.current) order.push(textareaRef.current)
          if (cancelRef.current) order.push(cancelRef.current)
          if (confirmRef.current) order.push(confirmRef.current)
          if (order.length === 0) return
          const first = order[0]
          const last = order[order.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <h3 id={titleId} className="font-display text-lg font-semibold">
          {title}
        </h3>
        <p id={descriptionId} className="mt-2 text-sm text-ink-soft">
          {question}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          Az indoklás opcionális. Ha megadod, a ticket állapot-előzményében jelenik meg.
        </p>
        <label htmlFor={reasonId} className="sr-only">
          Indoklás (opcionális)
        </label>
        <textarea
          id={reasonId}
          ref={textareaRef}
          value={reason}
          maxLength={500}
          rows={3}
          disabled={pending}
          placeholder="Indoklás (opcionális)"
          className="mt-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink disabled:opacity-50"
          onChange={(event) => onReasonChange(event.target.value)}
        />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-night-2 disabled:opacity-50"
          >
            Mégse
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="rounded-full border border-coral/40 bg-coral/12 px-4 py-2 text-sm font-semibold text-coral-deep hover:bg-coral/22 disabled:opacity-50"
          >
            {pending ? 'Mentés…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
