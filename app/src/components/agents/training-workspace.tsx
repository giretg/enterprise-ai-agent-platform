'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import type { Agent } from '@prisma/client'
import {
  activateTraining,
  previewTrainingChange,
  rejectTraining,
  rollbackMemory,
  submitTrainingProposal,
} from '@/app/actions/platform'
import { AgentAssigneeSelect } from '@/components/agents/agent-assignee-select'
import { Badge, Card } from '@/components/ui/shell'
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

type PreviewState = {
  previewId: string
  proposedVersion: string
  changeSummary: ChangeSummary
  impactResult: ImpactResult
}

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
        <p key={`${item.from}-${item.to}`} className="mb-2 text-sm text-ink-soft">
          <span className="text-ink-faint">Helyette:</span> {item.from} → {item.to}
        </p>
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
  const [agentId, setAgentId] = useState(selectedAgentId ?? agents[0]?.id ?? '')
  const [newItem, setNewItem] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [compositionMode, setCompositionMode] = useState<TrainingCompositionMode>('build_on_pending')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [showFullVersion, setShowFullVersion] = useState(false)

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

  function runPreview(
    instruction:
      | { kind: 'teach'; text: string }
      | { kind: 'item_change'; change: { operation: 'add'; text: string } | { operation: 'update'; itemIndex: number; text: string } | { operation: 'remove'; itemIndex: number } },
  ) {
    if (!isSelectedAgentLoaded) {
      setMessage('Az új agent szabályai még betöltés alatt vannak.')
      return
    }
    startTransition(async () => {
      setMessage(null)
      setPreview(null)
      const res = await previewTrainingChange({
        agentId,
        instruction,
        compositionMode: workspace?.pendingProposal ? compositionMode : null,
      })
      if (!res.success) {
        setMessage(res.error ?? 'Hiba')
        return
      }
      setPreview(res.data as PreviewState)
      setShowFullVersion(false)
    })
  }

  function runSubmit(activate: boolean) {
    if (!preview) return
    startTransition(async () => {
      const res = await submitTrainingProposal({ previewId: preview.previewId, activate })
      if (!res.success) {
        setMessage(res.error ?? 'Hiba')
        return
      }
      setPreview(null)
      setNewItem('')
      setEditingIndex(null)
      setEditText('')
      setMessage(activate ? 'Az új szabályverzió életbe lépett.' : 'A javaslat jóváhagyásra vár.')
      router.refresh()
    })
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
              disabled={pending}
              onChange={(nextAgentId) => {
                setEditingIndex(null)
                setEditText('')
                setExpandedVersion(null)
                setNewItem('')
                setMessage(null)
                setPreview(null)
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
                          disabled={pending || !editText.trim()}
                          className="rounded-full bg-sage/20 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                          onClick={() =>
                            runPreview({
                              kind: 'item_change',
                              change: { operation: 'update', itemIndex: index, text: editText },
                            })
                          }
                        >
                          Megnézem, mit változtat
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={pending}
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
                          disabled={pending}
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
                          disabled={pending}
                          className="rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10 disabled:opacity-50"
                          onClick={() => {
                            if (!confirm('Biztosan törlöd ezt a szabályt?')) return
                            runPreview({
                              kind: 'item_change',
                              change: { operation: 'remove', itemIndex: index },
                            })
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
          {workspace?.pendingProposal && (
            <fieldset className="mb-3 space-y-2">
              <legend className="text-sm text-ink-soft">Van már egy függő javaslat. Mit tegyünk vele?</legend>
              {(allowed.has('build_on_pending') || allowed.has('replace_pending')) && (
                <div className="space-y-1 text-sm">
                  {allowed.has('build_on_pending') && (
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="composition"
                        checked={compositionMode === 'build_on_pending'}
                        onChange={() => setCompositionMode('build_on_pending')}
                      />
                      Beépítem a meglévő javaslatba
                    </label>
                  )}
                  {allowed.has('replace_pending') && (
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="composition"
                        checked={compositionMode === 'replace_pending'}
                        onChange={() => setCompositionMode('replace_pending')}
                      />
                      Lecserélem a meglévő javaslatot
                    </label>
                  )}
                </div>
              )}
            </fieldset>
          )}
          <textarea
            className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm"
            rows={4}
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            placeholder="Pl. Számláknál mindig ellenőrizd az ÁFA-kulcsot…"
          />
          <button
            type="button"
            disabled={pending || !isSelectedAgentLoaded || !newItem.trim() || !agentId}
            className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
            onClick={() => runPreview({ kind: 'teach', text: newItem })}
          >
            Megnézem, mit változtat
          </button>
        </Card>
      )}

      {preview && (
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
            {showFullVersion ? 'Teljes új verzió elrejtése' : 'Teljes új verzió megtekintése'}
          </button>
          {showFullVersion && (
            <pre className="mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-3 text-xs text-ink-soft">
              {preview.proposedVersion}
            </pre>
          )}
          {preview.impactResult.verdict !== 'blocked' && (
            <div className="flex flex-wrap gap-2">
              {allowed.has('activate') && (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                  onClick={() => runSubmit(true)}
                >
                  Aktiválom az új verziót
                </button>
              )}
              {allowed.has('submit_for_approval') && !allowed.has('activate') && (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
                  onClick={() => runSubmit(false)}
                >
                  Jóváhagyásra küldöm
                </button>
              )}
            </div>
          )}
        </Card>
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
            <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
              {workspace.pendingProposal.proposedVersion}
            </pre>
            <div className="flex flex-wrap gap-2">
              {allowed.has('activate') && (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                  onClick={() => {
                    startTransition(async () => {
                      const res = await activateTraining({
                        ticketId: workspace.pendingProposal!.ticketId,
                        revisionId: workspace.pendingProposal!.revisionId,
                      })
                      setMessage(res.success ? 'Az új szabályverzió életbe lépett.' : (res.error ?? 'Hiba'))
                      if (res.success) router.refresh()
                    })
                  }}
                >
                  Jóváhagyom és aktiválom
                </button>
              )}
              {allowed.has('reject') && (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full border border-coral/30 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
                  onClick={() => {
                    const reason = prompt('Miért küldöd vissza a javaslatot?')
                    if (!reason?.trim()) return
                    startTransition(async () => {
                      const res = await rejectTraining({
                        ticketId: workspace.pendingProposal!.ticketId,
                        reason: reason.trim(),
                      })
                      setMessage(res.success ? 'A javaslatot visszaküldted.' : (res.error ?? 'Hiba'))
                      if (res.success) router.refresh()
                    })
                  }}
                >
                  Visszaküldöm
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
                          disabled={pending || !agentId}
                          className="rounded-full bg-honey/20 px-3 py-1 text-xs font-semibold text-honey disabled:opacity-50"
                          onClick={() => {
                            const snippet = previewContent(v.content, 800)
                            if (
                              !confirm(
                                `Biztosan visszaállítod a szabályokat a(z) v${v.version} állapotra?\n\n${snippet}`,
                              )
                            ) {
                              return
                            }
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

      {message && (
        <p
          className={`text-sm ${message.toLowerCase().includes('hiba') || message.toLowerCase().includes('sikertelen') || message.toLowerCase().includes('nem') ? 'text-coral-deep' : 'text-ink-soft'}`}
        >
          {message}
        </p>
      )}
    </div>
  )
}
