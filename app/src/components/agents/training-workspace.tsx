'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import type { Agent, Ticket } from '@prisma/client'
import {
  approveTraining,
  proposeMemoryItemChange,
  rollbackMemory,
} from '@/app/actions/platform'
import { AgentAssigneeSelect } from '@/components/agents/agent-assignee-select'
import { Badge, Card } from '@/components/ui/shell'
import {
  EMPTY_MEMORY_PLACEHOLDER,
  parseMemoryItems,
} from '@/domain/training/memory-items'

type TrainingPayload = {
  diff?: { before?: string; after?: string; summary?: string }
  proposedContent?: string
  source?: string
}

type ApproveResult = {
  memoryVersion: { version: number }
  writeGateTokenId: string
  evalRun: { passed: boolean; score: number } | null
} | null

type MemoryVersionRow = {
  id: string
  version: number
  content: string | null
  status: string
  createdAt: string | Date
  source: string | null
}

function trainingPayload(ticket: Ticket): TrainingPayload {
  if (typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)) {
    return ticket.payload as TrainingPayload
  }
  return {}
}

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleString('hu-HU')
}

function previewContent(content: string | null | undefined, max = 400): string {
  const text = (content ?? '').trim() || EMPTY_MEMORY_PLACEHOLDER
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function TrainingWorkspace({
  agents,
  trainingTickets,
  selectedAgentId,
  memoryContent,
  memoryVersions,
  currentVersionId,
  lockAgent = false,
}: {
  agents: Agent[]
  trainingTickets: Ticket[]
  selectedAgentId?: string
  memoryContent: string | null
  memoryVersions: MemoryVersionRow[]
  currentVersionId: string | null
  /** Agent-munkaterületen a fül már kijelöli, kit tanítunk — nincs váltó. */
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
  const [lastApprove, setLastApprove] = useState<ApproveResult>(null)
  const [evalBlockedFor, setEvalBlockedFor] = useState<string | null>(null)

  const selectedAgent = agents.find((a) => a.id === agentId)
  const isSelectedAgentLoaded = agentId === selectedAgentId
  const items = useMemo(
    () => (isSelectedAgentLoaded ? parseMemoryItems(memoryContent) : []),
    [isSelectedAgentLoaded, memoryContent],
  )

  function runItemChange(
    input:
      | { operation: 'add'; text: string }
      | { operation: 'update'; itemIndex: number; text: string }
      | { operation: 'remove'; itemIndex: number },
    successMsg: string,
  ) {
    if (!isSelectedAgentLoaded) {
      setMessage('Az új agent szabályai még betöltés alatt vannak.')
      return
    }
    startTransition(async () => {
      setMessage(null)
      setLastApprove(null)
      const res = await proposeMemoryItemChange({
        agentId,
        apply: true,
        ...input,
      })
      if (!res.success) {
        setMessage(res.error ?? 'Hiba')
        return
      }
      const approved = (res.data as { approved: ApproveResult }).approved
      if (approved) {
        setLastApprove(approved)
        setMessage(successMsg)
      } else {
        setMessage(`${successMsg} — feladat létrehozva, jóváhagyásra vár.`)
      }
      setNewItem('')
      setEditingIndex(null)
      setEditText('')
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
                // A szerkesztett tétel indexe az aktuális agent memóriájára
                // vonatkozik. Agentváltáskor nem vihetjük át másik szabálylistára.
                setEditingIndex(null)
                setEditText('')
                setExpandedVersion(null)
                setNewItem('')
                setMessage(null)
                setLastApprove(null)
                setEvalBlockedFor(null)
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

      <Card title="Megtanult dolgok">
        <p className="mb-3 text-sm text-ink-soft">
          Ezeket használja a mindennapi munkában. Itt módosíthatod vagy törölheted a rossz
          szabályokat — minden változás új memória-verziót hoz létre.
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
                      <button
                        type="button"
                        disabled={pending || !isSelectedAgentLoaded || !editText.trim()}
                        className="rounded-full bg-sage/20 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                        onClick={() =>
                          runItemChange(
                            { operation: 'update', itemIndex: index, text: editText },
                            'Szabály frissítve.',
                          )
                        }
                      >
                        Mentés
                      </button>
                      <button
                        type="button"
                        disabled={pending || !isSelectedAgentLoaded}
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
                    <span className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={pending || !isSelectedAgentLoaded}
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
                        disabled={pending || !isSelectedAgentLoaded}
                        className="rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10 disabled:opacity-50"
                        onClick={() => {
                          if (!confirm('Biztosan törlöd ezt a szabályt?')) return
                          runItemChange(
                            { operation: 'remove', itemIndex: index },
                            'Szabály törölve.',
                          )
                        }}
                      >
                        Töröl
                      </button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Új dolog megtanítása">
        <p className="mb-3 text-sm text-ink-soft">
          Írd le ide, hogy mit szeretnél, hogy megtanuljon a munkatárs!
        </p>
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
          onClick={() =>
            runItemChange({ operation: 'add', text: newItem }, 'Új szabály hozzáadva.')
          }
        >
          Hozzáadás
        </button>
      </Card>

      <Card title="Függőben lévő tanítási feladatok">
        {trainingTickets.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs aktív training ticket.</p>
        ) : (
          <ul className="space-y-4">
            {trainingTickets.map((ticket) => {
              const payload = trainingPayload(ticket)
              const diff = payload.diff
              return (
                <li key={ticket.id} className="atelier-soft p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ticket.title}</span>
                    <Badge tone="warning">{ticket.state}</Badge>
                    {payload.source && (
                      <span className="text-xs text-ink-faint">{payload.source}</span>
                    )}
                    <Link
                      href={`/control-plane/tickets/${ticket.id}`}
                      className="text-xs text-sky hover:underline"
                    >
                      Részlet
                    </Link>
                  </div>
                  {diff && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-semibold text-ink-faint">Előtte</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
                          {diff.before || '(üres)'}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-semibold text-ink-faint">Utána</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
                          {diff.after || payload.proposedContent || '—'}
                        </pre>
                      </div>
                    </div>
                  )}
                  {ticket.state === 'awaiting_human' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={pending || !isSelectedAgentLoaded}
                        className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                        onClick={() => {
                          setEvalBlockedFor(null)
                          setLastApprove(null)
                          startTransition(async () => {
                            const res = await approveTraining({ ticketId: ticket.id })
                            if (res.success) {
                              setLastApprove(res.data as ApproveResult)
                              setMessage(null)
                              router.refresh()
                            } else if (res.error?.startsWith('eval_failed')) {
                              setEvalBlockedFor(ticket.id)
                              setMessage(res.error)
                            } else {
                              setMessage(res.error ?? 'Hiba')
                            }
                          })
                        }}
                      >
                        Jóváhagyás (write-gate)
                      </button>

                      {evalBlockedFor === ticket.id && (
                        <button
                          type="button"
                          disabled={pending || !isSelectedAgentLoaded}
                          className="rounded-full bg-coral/15 px-4 py-2 text-sm font-semibold text-coral-deep disabled:opacity-50"
                          onClick={() => {
                            startTransition(async () => {
                              const res = await approveTraining({
                                ticketId: ticket.id,
                                overrideEval: true,
                              })
                              if (res.success) {
                                setLastApprove(res.data as ApproveResult)
                                setEvalBlockedFor(null)
                                setMessage(null)
                                router.refresh()
                              } else {
                                setMessage(res.error ?? 'Hiba')
                              }
                            })
                          }}
                        >
                          Eval override (naplózva)
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Verzió-idővonal / rollback">
        <p className="mb-3 text-sm text-ink-soft">
          Nézd meg, milyen tartalomra állnál vissza, mielőtt megerősíted.
        </p>
        {memoryVersions.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs memória-verzió.</p>
        ) : (
          <ul className="space-y-2">
            {memoryVersions.map((v) => {
              const isCurrent = v.id === currentVersionId || v.status === 'active'
              const open = expandedVersion === v.version
              return (
                <li key={v.id} className="atelier-soft p-3">
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
                      {!isCurrent && (
                        <button
                          type="button"
                          disabled={pending || !isSelectedAgentLoaded || !agentId}
                          className="rounded-full bg-honey/20 px-3 py-1 text-xs font-semibold text-honey disabled:opacity-50"
                          onClick={() => {
                            const preview = previewContent(v.content, 800)
                            if (
                              !confirm(
                                `Biztosan visszaállítod a memóriát a(z) v${v.version} állapotra?\n\n${preview}`,
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
                                  ? `Rollback kész — most a v${v.version} az aktív.`
                                  : (res.error ?? 'Rollback sikertelen'),
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
          className={`text-sm ${message.startsWith('eval_failed') || message.toLowerCase().includes('hiba') || message.toLowerCase().includes('sikertelen') ? 'text-coral-deep' : 'text-ink-soft'}`}
        >
          {message}
        </p>
      )}

      {lastApprove && (
        <div className="atelier-soft rounded-xl p-4 text-sm">
          <p className="mb-1 font-semibold text-sage">
            ✓ Memória frissítve — v{lastApprove.memoryVersion.version}
          </p>
          <p className="font-mono text-xs text-ink-faint">
            Write-gate token: {lastApprove.writeGateTokenId.slice(0, 16)}…
          </p>
          {lastApprove.evalRun && (
            <p
              className={`mt-1 text-xs ${lastApprove.evalRun.passed ? 'text-sage' : 'text-honey'}`}
            >
              Eval: {lastApprove.evalRun.passed ? '✓ átment' : '⚠ figyelmeztetéssel override'} ·
              score {Math.round(lastApprove.evalRun.score * 100)}%
            </p>
          )}
        </div>
      )}
    </div>
  )
}
