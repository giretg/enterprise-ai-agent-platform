'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { transitionProcessTicket, cancelProcess } from '@/app/actions/process'
import { getTicket, listTicketComments } from '@/app/actions/platform'
import { promptDialog } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'
import { formatTicketDateTime } from '@/lib/ticket-display'
import { PROCESS_STATUS_CLASS, PROCESS_STEP_STATUS_LABELS } from '@/lib/process-labels'
import { compactProcessSupportTicketLabel } from '@/lib/work-traceability'
import { isProcessStalled, processStepTraceStatus } from '@/lib/process-stall'
import { TicketFilesPanel } from '@/components/tickets/ticket-files-panel'
import { TicketThread, type TicketThreadComment } from '@/components/tickets/ticket-thread'
import { PlaybookFlowGraph, type NodeClickPayload, type TraceOverlay } from '@/components/playbooks/playbook-flow-graph'
import { RunAnalysisButton } from '@/components/run-analysis/run-analysis-button'

export type ProcessStepView = {
  id: string
  stepId: string
  stepName: string
  status: string
  assignedRole: string
  assignedAgentId: string | null
  assignedAgentName?: string | null
  ticketId: string | null
  startedAt: string | null
  completedAt: string | null
}

export type DelegationView = {
  id: string
  fromStepId: string
  toStepId: string
  fromActorType: string
  toActorType: string
  status: string
}

export type IntendedFlow = {
  entryStepId: string
  steps: Array<{ stepId: string; stepName: string; ticketType: string; assignedRole: string }>
  routes: Array<{ fromStepId: string; toStepId: string | null; gateId: string | null }>
  gates: Array<{
    gateId: string
    stepId: string
    requiredActorRole: string | null
    criticality: string | null
    evidenceRequired: boolean
    blocking: boolean
  }>
}

export type ActualFlow = {
  actualEdges: Array<{
    fromStepId: string
    toStepId: string
    fromActorType: string
    inIntended: boolean
  }>
  executedSteps: Array<{
    stepId: string
    status: string
    inIntended: boolean
  }>
  deviations: Array<{
    type: 'UNEXPECTED_EDGE' | 'UNEXPECTED_STEP'
    detail: string
  }>
  reproducible: boolean
}

export type GateTicketView = {
  ticketId: string
  stepId: string
  gateId: string
  state: string
  requiredActorRole: string | null
  criticality: string | null
  evidenceRequired: boolean
  blocking: boolean
}

export type ProcessDetailData = {
  process: {
    id: string
    processType: string
    status: string
    processDefinitionId: string | null
    triggerType: string | null
    playbookRef: string
    playbookContentHash: string
    startedByType: string
    startedAt: string
    completedAt: string | null
    rootTicketId: string | null
  }
  steps: ProcessStepView[]
  delegations: DelegationView[]
  gateTickets: GateTicketView[]
  /** Playbook-lépéshez nem kötött folyamat-ticketek (pl. emberi felülvizsgálat fallback). */
  supportTickets: Array<{
    ticketId: string
    title: string
    state: string
    playbookStepId: string | null
  }>
  actualFlow: ActualFlow | null
  blockedReasons: Array<{ createdAt: string; stepId: string | null; reason: string }>
  intended: IntendedFlow | null
  spec: unknown | null
}

const STEP_TONE: Record<string, string> = {
  pending: 'bg-ink/8 text-ink-soft',
  ready: 'bg-sky-500/15 text-sky-300',
  in_progress: 'bg-sky-500/15 text-sky-300',
  awaiting_gate: 'bg-honey/15 text-honey',
  completed: 'bg-sage/15 text-sage',
  skipped: 'bg-ink/8 text-ink-soft',
  failed: 'bg-coral/15 text-coral',
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>
}

export function ProcessDetailView({
  data,
  canAct,
  canRunAnalysis = false,
  runAnalystAgentId = null,
}: {
  data: ProcessDetailData
  canAct: boolean
  canRunAnalysis?: boolean
  runAnalystAgentId?: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [evidenceByTicket, setEvidenceByTicket] = useState<Record<string, string>>({})
  const [openTicketId, setOpenTicketId] = useState<string | null>(null)

  // WP-1 / D10 — Runtime Trace overlay poll (3–5s), amíg a folyamat nem terminális.
  // Terminális állapotban (completed/failed/cancelled) a poll leáll. Push (SSE) későbbi opt.
  // Rejtett fülön nem frissítünk: a `router.refresh()` újrafuttatja a route szerver-lekérdezéseit,
  // vagyis egy nyitva felejtett nézet ébren tartaná a Neon computeot. Visszatéréskor azonnal
  // behozzuk a lemaradást.
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(data.process.status)
  useEffect(() => {
    if (isTerminal) return
    const refreshIfVisible = () => {
      if (document.hidden) return
      router.refresh()
    }
    const id = setInterval(refreshIfVisible, 4000)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [isTerminal, router])

  // A folyamat elakadt-e, és mely TERVEZETT lépésekhez nem jött létre futás-példány.
  const stalled = isProcessStalled(data.process.status)
  const startedStepIds = new Set(data.steps.map((s) => s.stepId))
  const stepNameById = new Map(
    [...data.steps, ...(data.intended?.steps ?? [])].map((s) => [s.stepId, s.stepName]),
  )
  const unstartedSteps = (data.intended?.steps ?? []).filter(
    (step) => !startedStepIds.has(step.stepId),
  )

  const gatesByStep = new Map<string, IntendedFlow['gates']>()
  for (const gate of data.intended?.gates ?? []) {
    gatesByStep.set(gate.stepId, [...(gatesByStep.get(gate.stepId) ?? []), gate])
  }
  const gateTicketByStep = new Map(
    data.gateTickets.map((t) => [`${t.stepId}:${t.gateId}`, t]),
  )

  const actualEdgeByKey = new Map(
    (data.actualFlow?.actualEdges ?? []).map((e) => [`${e.fromStepId}→${e.toStepId}`, e]),
  )
  const actualStepById = new Map((data.actualFlow?.executedSteps ?? []).map((s) => [s.stepId, s]))

  // WP-1 §4 — trace-overlay a folyamat-gráfhoz: node-státusz + bejárt/eltérő élek.
  const intendedStepIds = (data.intended?.steps ?? data.steps).map((s) => s.stepId)
  const stalledStepId =
    data.blockedReasons.find((item) => item.stepId)?.stepId ??
    [...data.steps].reverse().find((s) => s.status === 'failed' || s.status === 'awaiting_gate')
      ?.stepId ??
    null
  const instanceByStepId = new Map(data.steps.map((s) => [s.stepId, s]))
  const traceOverlay: TraceOverlay = {
    nodeStatus: Object.fromEntries(
      intendedStepIds.map((stepId) => {
        const instance = instanceByStepId.get(stepId)
        return [
          stepId,
          processStepTraceStatus(instance?.status ?? 'pending', {
            stalledHere: stalled && stalledStepId === stepId,
            processFailed: data.process.status === 'failed',
          }),
        ]
      }),
    ),
    traversedEdges: (data.actualFlow?.actualEdges ?? []).map((e) => `${e.fromStepId}→${e.toStepId}`),
    deviationEdges: (data.actualFlow?.actualEdges ?? [])
      .filter((e) => !e.inIntended)
      .map((e) => `${e.fromStepId}→${e.toStepId}`),
  }
  const graphClickableIds = [
    ...data.steps.filter((s) => s.ticketId).map((s) => s.stepId),
    ...data.gateTickets.map((g) => g.gateId),
  ]

  function openGraphNode(payload: NodeClickPayload) {
    if (payload.type === 'step') {
      const step = data.steps.find((s) => s.stepId === payload.id)
      if (step?.ticketId) setOpenTicketId(step.ticketId)
      return
    }
    const gate = data.gateTickets.find((g) => g.gateId === payload.id)
    if (gate) setOpenTicketId(gate.ticketId)
  }

  function doTransition(ticketId: string, toState: string, evidenceRequired: boolean) {
    setMessage(null)
    const evidence = evidenceByTicket[ticketId]?.trim() ?? ''
    let approvalEvidence: Record<string, unknown> | undefined
    if (evidenceRequired || evidence) {
      if (evidenceRequired && !evidence) {
        setMessage({ tone: 'err', text: 'A kapu jóváhagyásához bizonyíték szükséges.' })
        return
      }
      if (evidence) approvalEvidence = { note: evidence }
    }
    startTransition(async () => {
      const res = await transitionProcessTicket({ ticketId, toState, approvalEvidence })
      if (res.success) {
        setEvidenceByTicket((prev) => ({ ...prev, [ticketId]: '' }))
        setMessage({ tone: 'ok', text: `Átmenet végrehajtva: → ${toState}` })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function doCancel() {
    void (async () => {
      const reason = await promptDialog({
        title: 'Folyamat visszavonása',
        description: 'Add meg a visszavonás indokát.',
        inputLabel: 'Indok',
        placeholder: 'A folyamat visszavonásának indoka…',
        confirmLabel: 'Visszavonás',
        tone: 'danger',
        required: true,
      })
      if (!reason) return
      setMessage(null)
      startTransition(async () => {
        const res = await cancelProcess({ id: data.process.id, reason })
        if (res.success) {
          setMessage({ tone: 'ok', text: 'Folyamat visszavonva.' })
          router.refresh()
        } else {
          setMessage({ tone: 'err', text: res.error })
        }
      })
    })()
  }

  const isClosed = ['completed', 'failed', 'cancelled'].includes(data.process.status)

  return (
    <div className="space-y-6">
      <div className="atelier-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-semibold">{data.process.processType}</h2>
              <Pill tone={PROCESS_STATUS_CLASS[data.process.status as keyof typeof PROCESS_STATUS_CLASS] ?? 'bg-ink/8 text-ink-soft'}>
                {data.process.status}
              </Pill>
            </div>
            <p className="mt-1 font-mono text-xs text-ink-soft">{data.process.playbookRef}</p>
          </div>
          {canAct && !isClosed && (
            <button
              onClick={doCancel}
              disabled={pending}
              className="rounded-lg border border-coral/40 px-3 py-1.5 text-sm text-coral disabled:opacity-50"
            >
              Folyamat visszavonása
            </button>
          )}
          {canRunAnalysis && runAnalystAgentId ? (
            <RunAnalysisButton
              runAnalystAgentId={runAnalystAgentId}
              scope={{
                kind: 'process',
                processInstanceId: data.process.id,
                processType: data.process.processType,
              }}
              className="rounded-lg border border-honey/35 bg-honey/10 px-3 py-1.5 text-sm font-semibold text-honey transition-colors hover:bg-honey/20"
            />
          ) : null}
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          Indítva: {new Date(data.process.startedAt).toLocaleString('hu-HU')} ({data.process.startedByType})
          {data.process.completedAt
            ? ` · Lezárva: ${new Date(data.process.completedAt).toLocaleString('hu-HU')}`
            : ''}
        </p>
        <dl className="mt-3 grid gap-2 text-xs text-ink-soft sm:grid-cols-3">
          <div>
            <dt className="font-medium text-ink">Forras Folyamat</dt>
            <dd className="mt-0.5 font-mono">{data.process.processDefinitionId ?? 'legacy inditas'}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Trigger</dt>
            <dd className="mt-0.5">{data.process.triggerType ?? 'legacy'}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Root ticket</dt>
            <dd className="mt-0.5 font-mono">{data.process.rootTicketId ?? '-'}</dd>
          </div>
        </dl>
        {(data.process.status === 'blocked' || data.process.status === 'awaiting_human') &&
          data.blockedReasons.length > 0 && (
          <div className="mt-3 rounded-lg border border-coral/25 bg-coral/5 p-3 text-sm text-coral">
            <p className="font-semibold">Elakadás oka</p>
            <ul className="mt-1 space-y-1">
              {data.blockedReasons.map((item, idx) => (
                <li key={`${item.createdAt}-${idx}`}>
                  {item.stepId ? <span className="font-mono">{item.stepId}: </span> : null}
                  {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      )}

      {/* Step timeline + gate panel */}
      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Lépések</h2>
        {stalled && unstartedSteps.length > 0 && (
          <p className="mb-3 rounded-lg border border-honey/30 bg-honey/[0.07] px-3 py-2 text-sm text-ink">
            A futás elakadt: a tervezett lépések közül {unstartedSteps.length} el sem indult. Ezek a
            lista végén, {'„Nem indult el”'} jelöléssel szerepelnek.
          </p>
        )}
        <ol className="space-y-3">
          {data.steps.map((s) => {
            const gates = gatesByStep.get(s.stepId) ?? []
            return (
              <li
                key={s.id}
                className={`rounded-lg border border-ink/10 p-3 ${
                  s.ticketId ? 'cursor-pointer transition-colors hover:border-accent/40 hover:bg-accent/5' : ''
                }`}
                onClick={s.ticketId ? () => setOpenTicketId(s.ticketId) : undefined}
                role={s.ticketId ? 'button' : undefined}
                tabIndex={s.ticketId ? 0 : undefined}
                onKeyDown={
                  s.ticketId
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setOpenTicketId(s.ticketId)
                        }
                      }
                    : undefined
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{s.stepName}</span>
                    <span className="ml-2 font-mono text-xs text-ink-soft">{s.stepId}</span>
                  </div>
                  <Pill tone={STEP_TONE[s.status] ?? 'bg-ink/8 text-ink-soft'}>
                    {PROCESS_STEP_STATUS_LABELS[s.status] ?? s.status}
                  </Pill>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  Szerep: {s.assignedRole}
                  {s.assignedAgentId ? (
                    <>
                      {' · '}Agent: {s.assignedAgentName ? `${s.assignedAgentName} ` : ''}
                      <span className="font-mono">({s.assignedAgentId})</span>
                    </>
                  ) : null}
                  {gates.length > 0 ? (
                    <>
                      {' · '}Kapuk:{' '}
                      {gates.map((gate, idx) => (
                        <span key={gate.gateId}>
                          {idx > 0 ? ', ' : ''}
                          <span className="font-mono">{gate.gateId}</span>
                          {gate.criticality ? ` (${gate.criticality})` : ''}
                          {gate.evidenceRequired ? ' · bizonyíték kötelező' : ''}
                        </span>
                      ))}
                    </>
                  ) : null}
                </p>

                <div className="mt-2 flex flex-wrap gap-2">
                  {gates.map((gate) => {
                    const gateTicket = gateTicketByStep.get(`${s.stepId}:${gate.gateId}`)
                    if (gateTicket?.state !== 'awaiting_human') return null
                    return (
                      <Pill key={gate.gateId} tone="bg-honey/15 text-honey">
                        kapu jóváhagyásra vár: {gate.gateId}
                      </Pill>
                    )
                  })}
                </div>
              </li>
            )
          })}
          {/* A soha el nem indult lépések: enélkül a felületen egyszerűen NEM LÉTEZTEK,
              és úgy tűnt, a folyamat egylépéses. */}
          {unstartedSteps.map((step) => (
            <li
              key={`unstarted-${step.stepId}`}
              className="rounded-lg border border-dashed border-ink/15 bg-ink/[0.02] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-ink-soft">{step.stepName}</span>
                  <span className="ml-2 font-mono text-xs text-ink-faint">{step.stepId}</span>
                </div>
                <Pill tone={stalled ? 'bg-honey/15 text-honey' : 'bg-ink/8 text-ink-soft'}>
                  {stalled ? 'Nem indult el' : 'Következik'}
                </Pill>
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                {stalled
                  ? 'A folyamat elakadt egy korábbi lépésen, ezért ehhez a lépéshez feladat sem jött létre.'
                  : 'A folyamat még nem jutott el eddig a lépésig.'}
              </p>
            </li>
          ))}
          {data.steps.length === 0 && unstartedSteps.length === 0 && (
            <li className="text-sm text-ink-soft">Még nincs lépés.</li>
          )}
        </ol>
      </section>

      {data.supportTickets.length > 0 && (
        <section className="atelier-card p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">További feladatok</h2>
          <p className="mb-3 text-sm text-ink-soft">
            Ezek a ticketek a folyamathoz tartoznak, de nem külön playbook-lépésként futnak (pl. emberi
            felülvizsgálat hiba után).
          </p>
          <ul className="space-y-2">
            {data.supportTickets.map((ticket) => (
              <li key={ticket.ticketId}>
                <Link
                  href={`/control-plane/tickets/${ticket.ticketId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2 text-sm transition-colors hover:border-accent/40 hover:bg-accent/5"
                >
                  <span className="font-medium">
                    {compactProcessSupportTicketLabel(
                      { title: ticket.title, playbookStepId: ticket.playbookStepId },
                      stepNameById,
                    )}
                  </span>
                  <Pill
                    tone={
                      TICKET_STATE_TONE[ticket.state as keyof typeof TICKET_STATE_TONE] ??
                      'bg-ink/8 text-ink-soft'
                    }
                  >
                    {TICKET_STATE_LABELS[ticket.state as keyof typeof TICKET_STATE_LABELS] ??
                      ticket.state}
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Kapuk</h2>
        <ul className="space-y-3">
          {data.gateTickets.map((gate) => {
            const canApprove = canAct && gate.blocking && gate.state === 'awaiting_human' && !isClosed
            return (
              <li key={gate.ticketId} className="rounded-lg border border-ink/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-mono text-xs">{gate.gateId}</span>
                    <span className="ml-2 text-sm text-ink-soft">step: {gate.stepId}</span>
                  </div>
                  <Pill tone={gate.state === 'awaiting_human' ? 'bg-honey/15 text-honey' : 'bg-sage/15 text-sage'}>
                    {gate.state}
                  </Pill>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {gate.requiredActorRole ? `Szerep: ${gate.requiredActorRole}` : 'Nincs külön szerep-kötés'}
                  {gate.criticality ? ` · ${gate.criticality}` : ''}
                  {gate.evidenceRequired ? ' · bizonyíték kötelező' : ''}
                </p>
                {canApprove && (
                  <GateApprovalPanel
                    gate={gate}
                    pending={pending}
                    evidence={evidenceByTicket[gate.ticketId] ?? ''}
                    onEvidenceChange={(value) =>
                      setEvidenceByTicket((prev) => ({ ...prev, [gate.ticketId]: value }))
                    }
                    onTransition={doTransition}
                  />
                )}
              </li>
            )
          })}
          {data.gateTickets.length === 0 && <li className="text-sm text-ink-soft">Nincs nyitott kapu.</li>}
        </ul>
      </section>

      {/* Delegacios élek */}
      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Delegáció</h2>
        <ul className="space-y-2 text-sm">
          {data.delegations.map((d) => {
            const actualEdge = actualEdgeByKey.get(`${d.fromStepId}→${d.toStepId}`)
            const deviates = actualEdge ? !actualEdge.inIntended : false
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">
                  {d.fromStepId} ({d.fromActorType}) → {d.toStepId} ({d.toActorType})
                </span>
                <Pill tone={d.status === 'done' ? 'bg-sage/15 text-sage' : 'bg-sky-500/15 text-sky-300'}>
                  {d.status}
                </Pill>
                {deviates && <Pill tone="bg-coral/15 text-coral">eltérés a Playbooktól</Pill>}
              </li>
            )
          })}
          {data.delegations.length === 0 && <li className="text-ink-soft">Még nincs átadás.</li>}
        </ul>
      </section>

      {/* Szándékolt vs. tényleges flow (§9.2) */}
      {data.intended && (
        <section className="atelier-card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">Szándékolt vs. tényleges</h2>
            {data.actualFlow && (
              <Pill
                tone={
                  data.actualFlow.reproducible
                    ? 'bg-sage/15 text-sage'
                    : 'bg-coral/15 text-coral'
                }
              >
                {data.actualFlow.reproducible ? 'reprodukálható' : 'eltérés'}
              </Pill>
            )}
          </div>
          {data.spec ? (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Folyamat-trace (a tervezett gráfra rárajzolva)
              </p>
              <PlaybookFlowGraph
                spec={data.spec}
                traceOverlay={traceOverlay}
                clickableIds={graphClickableIds}
                showEditGlyph={false}
                clickHint="kattints a feladat megnyitásához"
                onNodeClick={openGraphNode}
              />
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Szándékolt (Playbook)
              </p>
              <ol className="space-y-1 text-sm">
                {data.intended.steps.map((st) => (
                  <li key={st.stepId} className="font-mono text-xs">
                    {st.stepId === data.intended!.entryStepId ? '▶ ' : '· '}
                    {st.stepName}{' '}
                    <span className="text-ink-soft">
                      ({st.stepId}, {st.assignedRole})
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Tényleges (audit/step)
              </p>
              <ol className="space-y-1 text-sm">
                {data.steps.map((s) => (
                  <li key={s.id} className="font-mono text-xs">
                    {s.stepId}{' '}
                    <span className="text-ink-soft">
                      ({s.status})
                    </span>
                    {actualStepById.get(s.stepId)?.inIntended === false && (
                      <span className="ml-2 text-coral">eltérés</span>
                    )}
                  </li>
                ))}
                {data.steps.length === 0 && <li className="text-ink-soft">—</li>}
              </ol>
            </div>
          </div>
          {data.actualFlow && data.actualFlow.deviations.length > 0 && (
            <div className="mt-4 rounded-lg border border-coral/20 bg-coral/5 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-coral">Eltérések</p>
              <ul className="mt-2 space-y-1 text-xs text-ink-soft">
                {data.actualFlow.deviations.map((d, idx) => (
                  <li key={`${d.type}-${idx}`}>{d.detail}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {openTicketId && (
        <TicketDetailModal key={openTicketId} ticketId={openTicketId} onClose={() => setOpenTicketId(null)} />
      )}
    </div>
  )
}

type TicketDetail = Extract<Awaited<ReturnType<typeof getTicket>>, { success: true }>['data']

function TicketDetailModal({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'ok'; ticket: TicketDetail; comments: TicketThreadComment[] }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    // A modal ticketId-nként remountol (key), így a kezdő 'loading' állapot már friss.
    Promise.all([getTicket({ id: ticketId }), listTicketComments({ ticketId })]).then(
      ([ticketRes, commentsRes]) => {
        if (cancelled) return
        if (ticketRes.success) {
          setState({
            status: 'ok',
            ticket: ticketRes.data,
            comments: commentsRes.success ? (commentsRes.data as TicketThreadComment[]) : [],
          })
        } else {
          setState({ status: 'error', error: ticketRes.error })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [ticketId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
    >
      <div
        className="atelier-card max-h-[85vh] w-full max-w-xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold">Ticket részletek</h3>
          <button
            onClick={onClose}
            className="rounded-lg border border-ink/15 px-2.5 py-1 text-sm text-ink-soft hover:bg-ink/5"
          >
            Bezárás
          </button>
        </div>

        {state.status === 'loading' && <p className="text-sm text-ink-soft">Betöltés...</p>}
        {state.status === 'error' && <p className="text-sm text-coral">{state.error}</p>}
        {state.status === 'ok' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{state.ticket.title}</span>
              <Badge tone={TICKET_STATE_TONE[state.ticket.state] ?? 'neutral'}>
                {TICKET_STATE_LABELS[state.ticket.state] ?? state.ticket.state}
              </Badge>
            </div>

            <TicketThread ticket={state.ticket} comments={state.comments} />

            <dl className="grid gap-x-6 gap-y-2 text-xs text-ink-soft sm:grid-cols-2">
              {state.ticket.creator && (
                <>
                  <dt className="font-medium text-ink">Létrehozta</dt>
                  <dd>{state.ticket.creator.label}</dd>
                </>
              )}
              {state.ticket.assignee && (
                <>
                  <dt className="font-medium text-ink">Hozzárendelve</dt>
                  <dd>{state.ticket.assignee.label}</dd>
                </>
              )}
              <dt className="font-medium text-ink">Létrehozva</dt>
              <dd>{formatTicketDateTime(state.ticket.createdAt)}</dd>
              <dt className="font-medium text-ink">Utolsó módosítás</dt>
              <dd>{formatTicketDateTime(state.ticket.updatedAt)}</dd>
            </dl>

            <TicketFilesPanel ticketId={state.ticket.id} ticketState={state.ticket.state} />

            <Link
              href={`/control-plane/tickets/${state.ticket.id}`}
              className="inline-block text-sm font-medium text-accent hover:underline"
            >
              Megnyitás teljes nézetben →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function GateApprovalPanel({
  gate,
  pending,
  evidence,
  onEvidenceChange,
  onTransition,
}: {
  gate: GateTicketView
  pending: boolean
  evidence: string
  onEvidenceChange: (value: string) => void
  onTransition: (ticketId: string, toState: string, evidenceRequired: boolean) => void
}) {
  return (
    <div className="mt-3 bg-honey/5 p-3">
      <p className="text-xs text-ink-soft">
        Kötelező emberi kapu.
        {gate.requiredActorRole ? (
          <>
            {' '}Szükséges szerep: <span className="font-mono">{gate.requiredActorRole}</span>.
          </>
        ) : null}
        {gate.evidenceRequired ? ' Bizonyíték szükséges.' : ''}
      </p>
      <input
        value={evidence}
        onChange={(e) => onEvidenceChange(e.target.value)}
        placeholder={gate.evidenceRequired ? 'Jóváhagyási bizonyíték' : 'Megjegyzés'}
        className="mt-2 w-full rounded-lg border border-ink/15 bg-transparent px-3 py-1.5 text-sm"
      />
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => onTransition(gate.ticketId, 'approved', gate.evidenceRequired)}
          disabled={pending}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Jóváhagyás
        </button>
        <button
          onClick={() => onTransition(gate.ticketId, 'rejected', false)}
          disabled={pending}
          className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Elutasítás
        </button>
      </div>
    </div>
  )
}
