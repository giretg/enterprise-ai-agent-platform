'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import type { ProcessStatus } from '@prisma/client'
import {
  createDiscussionFromTicket,
  transitionTicket,
  deleteBoardTicket,
  runRecurringTicketNow,
} from '@/app/actions/platform'
import { setTicketProjectKey } from '@/app/actions/work-projects'
import { AssignableWorkProjectSelect } from '@/components/work-projects/work-project-select'
import { effectiveWorkProjectKey } from '@/lib/work-project'
import { exportTicketDebugLog } from '@/app/actions/debug-log'
import { startProcessFromTicket, transitionProcessTicket } from '@/app/actions/process'
import { authorizeTicketRunAs, revokeTicketRunAs } from '@/app/actions/connector-grants'
import { openAgentChat } from '@/components/agents/agent-chat-session-store'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Badge, Card } from '@/components/ui/shell'
import { ProcessBadge } from '@/components/processes/process-badge'
import { RunAnalysisButton } from '@/components/run-analysis/run-analysis-button'
import {
  TICKET_STATE_HINTS,
  TICKET_STATE_LABELS,
  TICKET_STATE_TONE,
  TICKET_TONE_DOT_CLASS,
} from '@/lib/ticket-labels'
import { canStartTicketDispatch, formatTicketDateTime } from '@/lib/ticket-display'
import { readTicketSchedule } from '@/lib/ticket-schedule'
import {
  assessTicketRunLiveness,
  presentTicketRunStatus,
  readTicketRuntimeProgress,
} from '@/domain/agent/ticket-runtime-progress'
import { isRunAsAuthorized } from '@/lib/run-as-payload'
import { resolveTicketTriggerInputPayload } from '@/lib/playbook-v2/trigger-input'
import { readStepOutcome } from '@/lib/playbook-v2/process-step-payload'
import { readTicketCallCapMessageFromPayload } from '@/lib/ticket-call-cap'
import { PROCESS_STEP_STATUS_LABELS } from '@/lib/process-labels'
import {
  buildProcessStallNotice,
  extraProcessTickets,
  isProcessStalled,
  processStepTraceStatus,
  siblingTicketKindLabel,
  stalledStepStatusLabel,
  STEP_FAILURE_REASON_TEXT,
  ticketIdForProcessNode,
  type ProcessSiblingTicket,
} from '@/lib/process-stall'
import { ChatMarkdown } from '@/components/chat/chat-markdown'
import {
  PlaybookFlowGraph,
  type NodeClickPayload,
  type TraceOverlay,
} from '@/components/playbooks/playbook-flow-graph'
import { compactProcessSupportTicketLabel } from '@/lib/work-traceability'

type TicketView = {
  id: string
  title: string
  type: string
  state: string
  payload: unknown
  sourceDocumentId: string | null
  conversationId?: string | null
  projectKey?: string | null
  createdAt: string | Date
  updatedAt: string | Date
  executeAfter?: string | Date | null
  lockedAt?: string | Date | null
  cancelRequested?: boolean
  assigneeType?: string | null
  assigneeId?: string | null
  agentId?: string | null
  processInstanceId?: string | null
  playbookStepId?: string | null
  requiredGateId?: string | null
  taskDescription?: string | null
  /** Nyitott következmény-kapu kártyák — ticket-szintű Approve elrejtéséhez. */
  pendingConsequenceApprovals?: unknown[] | null
  /** Nyitott Gmail/delegált OAuth-grant kártyák — ticket-szintű Approve elrejtéséhez. */
  pendingConnectorGrants?: unknown[] | null
  assignee?: {
    type: string | null
    label: string
    detail: string | null
  }
  creator?: {
    id: string
    label: string
  }
  reproduction?: {
    agentVersion: number
    memoryVersion: number | null
    model: unknown
    recipe: { name: string; version: number; status: string } | null
  } | null
  process?: { id: string; processType: string; status: ProcessStatus } | null
}

const PROCESS_STEP_STATUS_CLASS: Record<string, string> = {
  pending: 'bg-ink/[0.05] text-ink-faint',
  ready: 'bg-sky/10 text-sky',
  in_progress: 'bg-sky/15 text-sky',
  awaiting_gate: 'bg-honey/15 text-honey',
  completed: 'bg-sage/15 text-sage',
  skipped: 'bg-ink/[0.05] text-ink-faint',
  failed: 'bg-coral/15 text-coral',
}

function ProcessStepMarker({ status, position }: { status: string; position: number }) {
  if (status === 'completed') return <span aria-hidden>✓</span>
  if (status === 'failed') return <span aria-hidden>!</span>
  if (status === 'skipped') return <span aria-hidden>–</span>
  return <span>{position}</span>
}

/**
 * A ticket folyamatbeli helye. A folyamat-gráf a Playbook lépéseit és a
 * hozzájuk tartozó ticketeket együtt mutatja: a kockára kattintva a lépés
 * ticketje nyílik. A még el nem indult lépések sem tűnnek el.
 *
 * A panel KIMONDJA, ha a folyamat elakadt: enélkül egy `done` lépés-ticketen a
 * felület azt üzente, hogy „Elkészült, nincs több teendő", miközben a runtime
 * egy MÁSIK ticketen (emberi felülvizsgálat) várt a felhasználóra, a következő
 * lépés pedig sosem indult el.
 */
export function TicketProcessPanel({
  ticket,
  data,
}: {
  ticket: Pick<TicketView, 'id' | 'playbookStepId'>
  data: {
    process: { id: string; processType: string; status: ProcessStatus }
    steps: Array<{
      stepId: string
      stepName: string
      status: string
      ticketId: string | null
    }>
    intendedSteps: Array<{ stepId: string; stepName: string }>
    siblingTickets?: ProcessSiblingTicket[]
    spec?: unknown
    traversedEdges?: string[]
    deviationEdges?: string[]
    blocked?: {
      stepId: string | null
      humanSummary: string | null
      outcomeReason: string | null
      routingReason: string | null
    } | null
  }
}) {
  const router = useRouter()
  const instanceStepById = new Map(data.steps.map((step) => [step.stepId, step]))
  const intendedSteps = data.intendedSteps
  const steps =
    intendedSteps.length > 0
      ? intendedSteps.map((step) => ({
          stepId: step.stepId,
          stepName: step.stepName,
          status: instanceStepById.get(step.stepId)?.status ?? 'pending',
          ticketId: instanceStepById.get(step.stepId)?.ticketId ?? null,
        }))
      : data.steps

  const siblings = data.siblingTickets ?? []
  const stalled = isProcessStalled(data.process.status)
  const ticketStepId =
    ticket.playbookStepId ?? steps.find((step) => step.ticketId === ticket.id)?.stepId ?? null
  const currentStepIndex = steps.findIndex((step) => step.stepId === ticketStepId)
  const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : null
  // A felülvizsgálati/kapu-ticket ugyanannak a lépésnek az azonosítóját viseli,
  // mint a lépés saját ticketje — ilyenkor NEM a lépés dobozát jelöljük meg.
  const currentKind = siblings.find((s) => s.ticketId === ticket.id)?.kind ?? 'step'
  const isFollowUpTicket = currentKind !== 'step'

  const firstUnstartedIndex = steps.findIndex(
    (step) => step.status === 'pending' || step.status === 'ready',
  )
  const pendingNextStep =
    stalled && firstUnstartedIndex >= 0
      ? { position: firstUnstartedIndex + 1, stepName: steps[firstUnstartedIndex].stepName }
      : null
  const blockedStepIndex = data.blocked?.stepId
    ? steps.findIndex((step) => step.stepId === data.blocked?.stepId)
    : -1
  const blockedStep =
    stalled && blockedStepIndex >= 0
      ? {
          position: blockedStepIndex + 1,
          stepId: steps[blockedStepIndex].stepId,
          stepName: steps[blockedStepIndex].stepName,
        }
      : null
  const stalledStepIndex = blockedStepIndex >= 0 ? blockedStepIndex : firstUnstartedIndex

  const stallNotice = buildProcessStallNotice({
    processStatus: data.process.status,
    currentTicketId: ticket.id,
    currentStepId: ticketStepId,
    siblings,
    blocked: data.blocked ?? null,
    blockedStep,
    pendingNextStep,
  })

  const specLooksRenderable =
    Boolean(data.spec) &&
    typeof data.spec === 'object' &&
    Array.isArray((data.spec as { steps?: unknown }).steps) &&
    (data.spec as { steps: unknown[] }).steps.some(
      (step) => step && typeof step === 'object' && 'id' in step && Boolean((step as { id?: unknown }).id),
    )
  const graphNodeIds = specLooksRenderable
    ? [
        ...steps.map((step) => step.stepId),
        ...siblings.filter((s) => s.kind === 'gate' && s.gateId).map((s) => s.gateId as string),
      ]
    : undefined
  const otherTickets = extraProcessTickets(siblings, ticket.id, graphNodeIds)
  const stepNameById = new Map(steps.map((step) => [step.stepId, step.stepName]))
  const currentGraphNodeId =
    currentKind === 'gate'
      ? (siblings.find((s) => s.ticketId === ticket.id)?.gateId ?? ticketStepId)
      : ticketStepId
  const clickableGraphIds = [
    ...steps.filter((step) => step.ticketId && step.ticketId !== ticket.id).map((step) => step.stepId),
    ...siblings
      .filter((s) => s.kind === 'gate' && s.gateId && s.ticketId !== ticket.id)
      .map((s) => s.gateId as string),
  ]
  const traceOverlay: TraceOverlay = {
    nodeStatus: Object.fromEntries(
      steps.map((step, index) => [
        step.stepId,
        processStepTraceStatus(step.status, {
          stalledHere: stalled && index === stalledStepIndex,
          processFailed: data.process.status === 'failed',
        }),
      ]),
    ),
    traversedEdges: data.traversedEdges,
    deviationEdges: data.deviationEdges,
  }

  function openProcessNode(payload: NodeClickPayload) {
    const nextTicketId = ticketIdForProcessNode({
      nodeId: payload.id,
      nodeKind: payload.type,
      steps,
      siblings,
    })
    if (!nextTicketId || nextTicketId === ticket.id) return
    router.push(`/control-plane/tickets/${nextTicketId}`)
  }

  return (
    <section className="atelier-card overflow-hidden" aria-labelledby="ticket-process-heading">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            Folyamat része
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 id="ticket-process-heading" className="font-display text-lg font-semibold">
              {data.process.processType}
            </h2>
            <ProcessBadge
              processInstanceId={data.process.id}
              processType={data.process.processType}
              status={data.process.status as ProcessStatus}
            />
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            {currentStep
              ? isFollowUpTicket
                ? `Ez a feladat a ${currentStepIndex + 1}. lépés utómunkája (${siblingTicketKindLabel(currentKind).toLowerCase()}): ${currentStep.stepName}.`
                : `Ez a feladat a folyamat ${currentStepIndex + 1}. lépése a ${steps.length}-ből: ${currentStep.stepName}.`
              : 'Ez a feladat ehhez a folyamathoz tartozik.'}
          </p>
        </div>
        <Link
          href={`/control-plane/processes/${data.process.id}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky/30 bg-sky/10 px-4 py-2 text-sm font-semibold text-sky transition-colors hover:bg-sky/20"
        >
          Folyamat részletei <span aria-hidden>→</span>
        </Link>
      </div>

      {stallNotice && (
        <div
          role="status"
          className={`border-b px-5 py-4 sm:px-6 ${
            stallNotice.tone === 'danger'
              ? 'border-coral/25 bg-coral/[0.07]'
              : 'border-honey/30 bg-honey/[0.09]'
          }`}
        >
          <p
            className={`font-display text-base font-semibold ${
              stallNotice.tone === 'danger' ? 'text-coral' : 'text-honey'
            }`}
          >
            <span aria-hidden>⚠ </span>
            {stallNotice.headline}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink">{stallNotice.reason}</p>
          {stallNotice.consequence && (
            <p className="mt-1 text-sm text-ink-soft">{stallNotice.consequence}</p>
          )}
          {stallNotice.action ? (
            <Link
              href={stallNotice.action.href}
              className="mt-3 inline-flex items-center gap-1 rounded-full bg-honey px-4 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110"
            >
              {stallNotice.action.label} <span aria-hidden>→</span>
            </Link>
          ) : (
            <p className="mt-2 text-sm font-medium text-ink">
              A teendő ezen a feladaton van: nézd át, majd hagyd jóvá vagy dobd vissza.
            </p>
          )}
        </div>
      )}

      {specLooksRenderable ? (
        <div className="px-5 py-4 sm:px-6">
          <PlaybookFlowGraph
            spec={data.spec}
            traceOverlay={traceOverlay}
            currentNodeId={currentGraphNodeId}
            clickableIds={clickableGraphIds}
            showEditGlyph={false}
            clickHint="kattints a feladat megnyitásához"
            onNodeClick={openProcessNode}
          />
        </div>
      ) : steps.length > 0 ? (
        <ol className="flex gap-3 overflow-x-auto px-5 py-4 sm:px-6" aria-label="A folyamat lépései">
          {steps.map((step, index) => {
            const isTicketStep = step.stepId === ticketStepId && !isFollowUpTicket
            const isStalledHere = stalled && index === stalledStepIndex
            const statusLabel = stalledStepStatusLabel(
              step.status,
              stalled,
              PROCESS_STEP_STATUS_LABELS[step.status] ?? step.status,
            )
            const href =
              step.ticketId && step.ticketId !== ticket.id
                ? `/control-plane/tickets/${step.ticketId}`
                : null
            const cardClass = `relative h-full rounded-xl border p-3 transition-colors ${
              isTicketStep
                ? 'border-sky/45 bg-sky/[0.07] shadow-[inset_0_0_0_1px_rgba(79,146,168,0.12)]'
                : isStalledHere
                  ? 'border-dashed border-honey/50 bg-honey/[0.05]'
                  : 'border-line bg-card'
            }${href ? ' hover:border-sky/50 hover:bg-sky/[0.06]' : ''}`
            const body = (
              <>
                <div className="flex items-center gap-2">
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
                      isTicketStep
                        ? 'bg-sky text-white'
                        : isStalledHere
                          ? 'bg-honey/20 text-honey'
                          : PROCESS_STEP_STATUS_CLASS[step.status] ?? 'bg-ink/[0.05] text-ink-soft'
                    }`}
                  >
                    <ProcessStepMarker status={step.status} position={index + 1} />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                    {index + 1}. lépés
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold leading-snug text-ink">{step.stepName}</p>
                <span
                  className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    isStalledHere
                      ? 'bg-honey/15 text-honey'
                      : PROCESS_STEP_STATUS_CLASS[step.status] ?? 'bg-ink/[0.05] text-ink-soft'
                  }`}
                >
                  {isTicketStep ? 'Ez a feladat · ' : ''}
                  {statusLabel}
                </span>
                {isStalledHere && (
                  <p className="mt-1.5 text-[11px] leading-snug text-honey">
                    {step.status === 'pending' || step.status === 'ready'
                      ? 'Addig áll, amíg a felülvizsgálat le nem zárul.'
                      : 'Itt vár emberi döntésre.'}
                  </p>
                )}
              </>
            )
            return (
              <li key={step.stepId} className="min-w-[11rem] flex-1">
                {href ? (
                  <Link
                    href={href}
                    aria-label={`${step.stepName} megnyitása`}
                    className={`block ${cardClass}`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div aria-current={isTicketStep ? 'step' : undefined} className={cardClass}>
                    {body}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="px-5 py-4 text-sm text-ink-soft sm:px-6">
          A folyamat lépései még nem érhetők el.
        </p>
      )}

      {otherTickets.length > 0 && (
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            További feladatok
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Ezek a ticketek a folyamathoz tartoznak, de nem külön lépésként jelennek meg a
            fenti ábrán (például emberi felülvizsgálat).
          </p>
          <ul className="mt-3 space-y-2">
            {otherTickets.map((sibling) => (
              <li key={sibling.ticketId}>
                <Link
                  href={`/control-plane/tickets/${sibling.ticketId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm transition-colors hover:border-honey/45 hover:bg-honey/[0.06]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">
                      {compactProcessSupportTicketLabel(
                        { title: sibling.title, playbookStepId: sibling.stepId },
                        stepNameById,
                      )}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      {siblingTicketKindLabel(sibling.kind)}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      TICKET_STATE_TONE[sibling.state as keyof typeof TICKET_STATE_TONE] ??
                      'bg-ink/[0.05] text-ink-soft'
                    }`}
                  >
                    {TICKET_STATE_LABELS[sibling.state as keyof typeof TICKET_STATE_LABELS] ??
                      sibling.state}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

type TicketProcessTrigger = {
  id: string
  type: string
  enabled: boolean
  inputMap: unknown
}

export type TicketStartableProcessDefinition = {
  id: string
  name: string
  description: string | null
  triggers: TicketProcessTrigger[]
}

const REJECTABLE_STATES = new Set(['ready', 'in_progress', 'awaiting_human', 'done'])

function hasWikiAnswer(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'answer' in payload &&
    typeof (payload as { answer?: unknown }).answer === 'string'
  )
}

function hasRunAsAuthorization(payload: Record<string, unknown> | null): boolean {
  return isRunAsAuthorized(payload)
}

export function TicketRunAsAuthorization({
  ticket,
  canManageRunAs = false,
}: {
  ticket: TicketView
  canManageRunAs?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const payload =
    typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
      ? (ticket.payload as Record<string, unknown>)
      : null
  const authorized = hasRunAsAuthorization(payload)
  const canAuthorize =
    canManageRunAs &&
    ticket.assigneeType === 'agent' &&
    ['backlog', 'ready', 'in_progress'].includes(ticket.state) &&
    !authorized

  if (!canAuthorize && !authorized) return null

  const authorize = () => {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const res = await authorizeTicketRunAs({ ticketId: ticket.id })
      if (!res.success) {
        setError(res.error)
        return
      }
      setMessage('Kész. Az AI munkatárs a te fiókoddal dolgozhat ezen a feladaton, akkor is, ha épp nem vagy a gépnél.')
      router.refresh()
    })
  }

  const revoke = () => {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const res = await revokeTicketRunAs({ ticketId: ticket.id })
      if (!res.success) {
        setError(res.error)
        return
      }
      setMessage('Az engedélyt visszavontuk.')
      router.refresh()
    })
  }

  return (
    <Card title="Futhat a nevemben">
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      {message && <p className="mb-3 text-sm text-sage">{message}</p>}
      {authorized ? (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            Engedélyezve: ezen a feladaton az AI munkatárs a te fiókoddal dolgozhat (például Gmail), akkor is, ha épp nem
            vagy a gépnél.
          </p>
          {canManageRunAs && (
            <button
              type="button"
              disabled={pending}
              onClick={revoke}
              className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
            >
              Engedély visszavonása
            </button>
          )}
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            Ha az AI munkatárs akkor is a te fiókoddal dolgozna, amikor te nem vagy a gépnél (például ütemezett feladat),
            itt engedélyezheted. Bármikor visszavonhatod.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={authorize}
            className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky hover:bg-sky/30 disabled:opacity-50"
          >
            Engedélyezés
          </button>
        </>
      )}
    </Card>
  )
}

export function TicketProcessStartPanel({
  ticket,
  definitions,
}: {
  ticket: TicketView
  definitions: TicketStartableProcessDefinition[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const ticketDefinitions = definitions
    .map((definition) => ({
      ...definition,
      triggers: definition.triggers.filter((trigger) => trigger.type === 'ticket' && trigger.enabled),
    }))
    .filter((definition) => definition.triggers.length > 0)
  const [selectedDefinitionId, setSelectedDefinitionId] = useState(ticketDefinitions[0]?.id ?? '')
  const selectedDefinition = ticketDefinitions.find((definition) => definition.id === selectedDefinitionId)
  const [selectedTriggerId, setSelectedTriggerId] = useState(selectedDefinition?.triggers[0]?.id ?? '')
  const selectedTrigger =
    selectedDefinition?.triggers.find((trigger) => trigger.id === selectedTriggerId) ??
    selectedDefinition?.triggers[0]
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string; processId?: string } | null>(null)

  if (ticketDefinitions.length === 0) return null

  const preview = selectedTrigger
    ? resolveTicketTriggerInputPayload(selectedTrigger.inputMap, {
        id: ticket.id,
        title: ticket.title,
        type: ticket.type,
        state: ticket.state,
        payload: ticket.payload,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      })
    : {}

  const start = () => {
    if (!selectedDefinition || !selectedTrigger) {
      setMessage({ tone: 'err', text: 'Válassz feladat-triggerrel rendelkező Folyamatot.' })
      return
    }

    setMessage(null)
    startTransition(async () => {
      const res = await startProcessFromTicket({
        processDefinitionId: selectedDefinition.id,
        triggerId: selectedTrigger.id,
        ticketId: ticket.id,
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({ tone: 'ok', text: 'Futás elindítva feladat-triggerből.', processId: res.data.id })
      router.refresh()
    })
  }

  return (
    <Card title="Futás indítása feladatból">
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Folyamat</span>
          <select
            value={selectedDefinitionId}
            onChange={(event) => {
              const nextDefinition = ticketDefinitions.find((definition) => definition.id === event.target.value)
              setSelectedDefinitionId(event.target.value)
              setSelectedTriggerId(nextDefinition?.triggers[0]?.id ?? '')
              setMessage(null)
            }}
            className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
          >
            {ticketDefinitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name}
              </option>
            ))}
          </select>
          {selectedDefinition?.description && (
            <span className="mt-1 block text-xs text-ink-faint">{selectedDefinition.description}</span>
          )}
        </label>

        {selectedDefinition && selectedDefinition.triggers.length > 1 && (
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">Feladat-trigger</span>
            <select
              value={selectedTrigger?.id ?? ''}
              onChange={(event) => {
                setSelectedTriggerId(event.target.value)
                setMessage(null)
              }}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            >
              {selectedDefinition.triggers.map((trigger) => (
                <option key={trigger.id} value={trigger.id}>
                  {trigger.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="rounded-lg border border-ink/10 bg-night-2/70 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Feloldott trigger-input
          </p>
          <pre className="max-h-48 overflow-auto text-xs text-ink-soft">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>

        {message && (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>
            {message.text}{' '}
            {message.processId && (
              <Link href={`/control-plane/processes/${message.processId}`} className="font-semibold underline">
                Futás megnyitása
              </Link>
            )}
          </p>
        )}

        <button
          type="button"
          disabled={pending}
          onClick={start}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Indítás...' : 'Futás indítása'}
        </button>
      </div>
    </Card>
  )
}

/**
 * Folyamat-ticket emberi lezárása — kapu-jóváhagyás VAGY emberi lépés befejezése.
 *
 * A generikus állapotgomb itt tilos: az a playbook állapotgépét megkerülve írja a
 * ticketet, így a döntés nem lépteti tovább a futást — a felhasználó „döntött", a
 * folyamat meg nem tud róla (pontosan ez történt a felülvizsgálatra váró
 * ticketeknél és az emberi lépéseknél is).
 */
function ProcessTicketActions({ ticket }: { ticket: TicketView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const isGate = Boolean(ticket.requiredGateId)
  const approveState = isGate ? 'approved' : 'done'
  const approveLabel = isGate ? 'Jóváhagyás' : 'Kész, mehet tovább'

  const act = (toState: string) => {
    if (toState === 'rejected' && !note.trim()) {
      setError('Indoklás megadása kötelező a visszadobáshoz.')
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await transitionProcessTicket({
        ticketId: ticket.id,
        toState,
        note: note.trim() || undefined,
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      setNote('')
      router.refresh()
    })
  }

  return (
    <Card title="Döntés">
      <p className="-mt-2 mb-4 text-sm text-ink-soft">
        {isGate
          ? 'Ez egy folyamat-kapu: a jóváhagyásod lépteti tovább a futást, a visszadobás megállítja.'
          : 'Ez a lépés rád vár. Ha végeztél, jelöld késznek — a folyamat innen lép tovább magától.'}
      </p>
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      <textarea
        className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
        placeholder="Indoklás (visszadobásnál kötelező)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => act(approveState)}
          className="rounded-full bg-sage px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:brightness-95 disabled:opacity-50"
        >
          {approveLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => act('rejected')}
          className="rounded-full border border-coral/40 bg-coral/12 px-5 py-2.5 text-sm font-semibold text-coral-deep transition-colors hover:bg-coral/22 disabled:opacity-50"
        >
          Visszadobás
        </button>
      </div>
    </Card>
  )
}

export function TicketActions({
  ticket,
  hideDecisions = false,
}: {
  ticket: TicketView
  /** A folyamat-felülvizsgálati panel már megjeleníti a döntéseket ezen a ticketen. */
  hideDecisions?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const isTrainingTicket = ticket.type === 'training'
  const pendingConsequence = (ticket.pendingConsequenceApprovals ?? []) as Array<{
    expired?: boolean
    failedReason?: string
  }>
  const pendingConnectorGrants = ticket.pendingConnectorGrants ?? []
  const hasActionableConsequence = pendingConsequence.some(
    (a) => !a.expired || Boolean(a.failedReason),
  )
  const hasExpiredConsequence = pendingConsequence.some(
    (a) => Boolean(a.expired) && !a.failedReason,
  )
  const hasPendingConnectorGrant = pendingConnectorGrants.length > 0
  // Consequence-kapu mellett a ticket-szintű Approve bezárná a feladatot API
  // futtatás nélkül (cade35e7) — élő kapunál csak a „Mind jóváhagyom" a helyes út.
  // Lejárt kapunál sem Approve: az sem futtatná az API-t, csak hazudna.
  // Grant-hiánynál sem Approve: a folytatás az OAuth-gomb után indul.
  const canApprove =
    ticket.state === 'awaiting_human' &&
    !hasActionableConsequence &&
    !hasExpiredConsequence &&
    !hasPendingConnectorGrant
  const canReject = REJECTABLE_STATES.has(ticket.state)
  const callCapMessage = readTicketCallCapMessageFromPayload(ticket.payload)
  const canRerun = ticket.state === 'rejected' && !callCapMessage
  // Call-cap rejected: nincs újraindítás, de a panel kell az üzenethez.
  const showRejectedCallCapNotice = ticket.state === 'rejected' && Boolean(callCapMessage)
  const hasActions = canApprove || canReject || canRerun || showRejectedCallCapNotice
  const isWikiFollowUp = hasWikiAnswer(ticket.payload)
  // A note csak hard-stop / lezárás indoklás — az agentnek szánt pontosítás a
  // feladat-szál „Pontosítás + visszaadás" gombja. Futás közbeni rejectnél
  // (nem wiki) ne jelenjen meg párhuzamos „prompt az agentnek" mező.
  const showNoteField =
    canApprove ||
    canRerun ||
    (canReject &&
      (isWikiFollowUp || ticket.state === 'awaiting_human' || ticket.state === 'done'))

  const act = (toState: string) => {
    if (toState === 'rejected' && isWikiFollowUp && !note.trim()) {
      setError('Indoklás megadása kötelező a visszadobáshoz.')
      return
    }

    setError(null)
    startTransition(async () => {
      const res = await transitionTicket({ id: ticket.id, toState, note: note || undefined })
      if (!res.success) {
        setError(res.error)
        return
      }
      setNote('')
      router.refresh()
    })
  }

  // A folyamat-ticketek NEM kapnak generikus állapotgombot (l. ProcessGateActions
  // fejkommentje). Kapunál a folyamat-tudatos jóváhagyás jön; minden más
  // folyamat-ticketen a döntést a „Mi legyen ezzel a feladattal?" panel viszi.
  if (ticket.processInstanceId) {
    // A nyitott felülvizsgálatot a „Mi legyen ezzel a feladattal?" panel viszi.
    if (hideDecisions) return null
    if (ticket.requiredGateId) {
      return ticket.state === 'awaiting_human' ? <ProcessTicketActions ticket={ticket} /> : null
    }
    // Emberi lépés: a személy maga zárja le. Az AI munkatárs lépés-ticketje nem
    // kap gombot — azt a futás zárja, a hibáját a felülvizsgálati panel kezeli.
    const humanStep =
      ticket.assigneeType === 'human' &&
      !ticket.agentId &&
      ['ready', 'in_progress', 'awaiting_human'].includes(ticket.state)
    return humanStep ? <ProcessTicketActions ticket={ticket} /> : null
  }

  if (!hasActions) return null

  const hint = hasPendingConnectorGrant
    ? 'Gmail/delegált hozzáférés kell — használd a fenti „Hozzáférés megadása” gombot. OAuth után a feladat magától folytatódik.'
    : hasActionableConsequence
    ? ticket.state === 'awaiting_human'
      ? 'Külső műveletek várnak jóváhagyásra — használd a fenti „Mind jóváhagyom” gombot a folytatáshoz. A visszadobás megállítja a feladatot.'
      : 'Külső műveletek gyűlnek a futás alatt; a jóváhagyás a futás vége után lesz elérhető. A visszadobás megállítja a feladatot.'
    : hasExpiredConsequence
      ? 'A fenti külső műveletek jóváhagyási ablaka lejárt. Dobd vissza a feladatot, majd indítsd újra — az agent újra kéri a gombot. A ticket-szintű „Jóváhagyás” itt nem jelenik meg, mert nem futtatná le az API-hívást.'
      : (TICKET_STATE_HINTS[ticket.state] ?? 'Válaszd ki, hogyan folytatódjon a feladat.')

  return (
    <Card title="Döntés">
      <p className="-mt-2 mb-4 text-sm text-ink-soft">{hint}</p>
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      {showNoteField && (
        <textarea
          className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
          placeholder={
            isWikiFollowUp && canReject && !canApprove
              ? 'Indoklás a visszadobáshoz (kötelező)'
              : canApprove
                ? 'Indoklás (opcionális)'
                : 'Indoklás a visszadobáshoz (opcionális)'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approved')}
            className="rounded-full bg-sage px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:brightness-95 disabled:opacity-50"
          >
            {isTrainingTicket ? 'Tanítás jóváhagyása (write-gate)' : 'Jóváhagyás'}
          </button>
        )}
        {canReject && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('rejected')}
            className="rounded-full border border-coral/40 bg-coral/12 px-5 py-2.5 text-sm font-semibold text-coral-deep transition-colors hover:bg-coral/22 disabled:opacity-50"
          >
            Visszadobás
          </button>
        )}
        {canRerun && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('ready')}
            className="rounded-full border border-honey/40 bg-honey/15 px-5 py-2.5 text-sm font-semibold text-honey transition-colors hover:bg-honey/25 disabled:opacity-50"
          >
            Újra feldolgozás
          </button>
        )}
      </div>
      {ticket.state === 'rejected' && callCapMessage && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-coral">{callCapMessage}</p>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        {hasActionableConsequence &&
          'A ticket-szintű jóváhagyás most rejtve van: az nem futtatja le a külső API-műveleteket. '}
        {hasExpiredConsequence &&
          !hasActionableConsequence &&
          'A ticket-szintű jóváhagyás rejtve van: a lejárt kapu alatt nem futtatná az API-t. '}
        {canApprove &&
          isTrainingTicket &&
          'Tanítási feladat: a jóváhagyás write-gate-en keresztül frissíti az AI munkatárs memóriáját, majd done állapotba zár. '}
        {canApprove &&
          !isTrainingTicket &&
          'Jóváhagyás után a szerver automatikusan: approved → done. '}
        {canReject &&
          !callCapMessage &&
          'Visszadobás megállítja a feladatot (rejected). Pontosítással folytatni a feladat-szál alján tudsz. '}
        {canRerun &&
          'Újra feldolgozás azonnal újraindítja az AI munkatársat — nem kell a dispatcherre várni.'}
      </p>
    </Card>
  )
}

function contractReviewFromPayload(payload: Record<string, unknown> | null): {
  message: string
  answer: string | null
  title?: string
} | null {
  if (!payload) return null
  const callCapMessage = readTicketCallCapMessageFromPayload(payload)
  const answer = typeof payload.answer === 'string' ? payload.answer.trim() : null
  if (callCapMessage) {
    return { message: callCapMessage, answer: answer || null, title: 'Keret kimerült' }
  }
  const { message, reason } = readStepOutcome(payload)
  // Contract-sértésnél a közérthető message az elsődleges; ha az nincs, de
  // output_contract_unmet + eredeti válasz van, azt is mutatjuk.
  if (message) return { message, answer: answer || null }
  if (reason === 'output_contract_unmet' && answer) {
    return {
      message: 'A lépés kimenete nem felel meg a várt szerkezetnek.',
      answer,
    }
  }
  // A gépi hibakódokhoz (pl. `tool_denied`) a runtime nem ír `message`-t. Enélkül a
  // felületen SEMMI nem jelezte, miért nem sikeres a lépés — a válasz alatt csak a
  // magabiztos agent-összefoglaló maradt.
  if (reason && STEP_FAILURE_REASON_TEXT[reason]) {
    return { message: STEP_FAILURE_REASON_TEXT[reason], answer: answer || null }
  }
  return null
}

export function TicketMeta({
  ticket,
  isAdmin = false,
  canDispatch = false,
  canDelete = false,
  isAdminDelete = false,
  canRunAnalysis = false,
  runAnalystAgentId = null,
  canEditTask = false,
}: {
  ticket: TicketView
  isAdmin?: boolean
  canDispatch?: boolean
  canDelete?: boolean
  isAdminDelete?: boolean
  canRunAnalysis?: boolean
  runAnalystAgentId?: string | null
  canEditTask?: boolean
}) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const payload = ticket.payload as Record<string, unknown> | null
  const schedule = readTicketSchedule(ticket.payload, ticket.executeAfter)
  const proposal = payload?.proposal as Record<string, unknown> | undefined
  const diff = payload?.diff as Record<string, unknown> | undefined
  const assignee = ticket.assignee
  const contractReview = contractReviewFromPayload(payload)
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [dispatchPending, startDispatchTransition] = useTransition()
  const [runNowPending, startRunNowTransition] = useTransition()
  const [deletePending, startDeleteTransition] = useTransition()
  const [discussPending, startDiscussTransition] = useTransition()
  const [projectPending, startProjectTransition] = useTransition()
  const [headerMessage, setHeaderMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [projectKey, setProjectKey] = useState(() => effectiveWorkProjectKey(ticket.projectKey))

  useEffect(() => {
    if (ticket.state !== 'in_progress') return
    const tick = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(tick)
  }, [ticket.state])

  const discussAgentId =
    ticket.agentId ??
    (ticket.assigneeType === 'agent' && ticket.assigneeId ? ticket.assigneeId : null)
  const assigneeAgentHref =
    assignee?.type === 'agent'
      ? ticket.assigneeId
        ? `/control-plane/agents/${ticket.assigneeId}`
        : ticket.agentId
          ? `/control-plane/agents/${ticket.agentId}`
          : null
      : null

  const canStartDispatch = canDispatch && canStartTicketDispatch(ticket)
  const canRunNow =
    canDispatch &&
    Boolean(schedule?.scheduledTaskId) &&
    schedule?.kind === 'recurring' &&
    schedule.role !== 'occurrence' &&
    (ticket.state === 'ready' || ticket.state === 'backlog')

  function handleExportDebugLog() {
    startDebugLogTransition(async () => {
      setHeaderMessage(null)
      const res = await exportTicketDebugLog({ id: ticket.id })
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        return
      }
      const blob = new Blob([res.data.content], { type: res.data.mediaType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.data.filename
      a.click()
      URL.revokeObjectURL(url)
      setHeaderMessage({ tone: 'ok', text: `Debug-log letöltve: ${res.data.filename}` })
    })
  }

  function handleStartDispatch() {
    startDispatchTransition(async () => {
      setHeaderMessage(null)
      const res = await dispatchTicket(ticket.id)
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        return
      }
      setHeaderMessage({
        tone: res.warning ? 'err' : 'ok',
        text: res.warning ?? 'Feldolgozás elindítva.',
      })
    })
  }

  function handleRunNow() {
    startRunNowTransition(async () => {
      setHeaderMessage(null)
      const res = await runRecurringTicketNow({ ticketId: ticket.id })
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        return
      }
      if (res.data.warning) {
        setHeaderMessage({ tone: 'err', text: res.data.warning })
      }
      router.push(`/control-plane/tickets/${res.data.ticketId}`)
    })
  }

  function handleDelete() {
    void (async () => {
      const confirmed = await confirmDialog({
        title: isAdminDelete ? 'Feladat végleges törlése' : 'Feladat törlése',
        description: isAdminDelete
          ? 'Biztosan véglegesen törlöd ezt a feladatot (admin)? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.'
          : 'Biztosan törlöd ezt a feladatot? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.',
        confirmLabel: 'Törlés',
        tone: 'danger',
      })
      if (!confirmed) return

      startDeleteTransition(async () => {
        setHeaderMessage(null)
        const res = await deleteBoardTicket({ ticketId: ticket.id })
        if (!res.success) {
          setHeaderMessage({ tone: 'err', text: res.error })
          return
        }
        router.replace('/control-plane/board')
      })
    })()
  }

  function handleProjectKeyChange(next: string) {
    setProjectKey(next)
    if (!canDispatch) return
    startProjectTransition(async () => {
      setHeaderMessage(null)
      const res = await setTicketProjectKey({ ticketId: ticket.id, projectKey: next })
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        setProjectKey(effectiveWorkProjectKey(ticket.projectKey))
        return
      }
      router.refresh()
    })
  }

  function handleDiscuss() {
    if (!discussAgentId) return
    startDiscussTransition(async () => {
      setHeaderMessage(null)
      const res = await createDiscussionFromTicket({ ticketId: ticket.id })
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        return
      }
      openAgentChat({
        agent: res.data.agent,
        initialConversationId: res.data.conversationId,
      })
    })
  }

  const stateTone = TICKET_STATE_TONE[ticket.state] ?? 'neutral'
  const workflowLabel = TICKET_STATE_LABELS[ticket.state] ?? ticket.state
  const workflowHint = TICKET_STATE_HINTS[ticket.state] ?? null
  const liveness = assessTicketRunLiveness({
    ticketState: ticket.state,
    cancelRequested: ticket.cancelRequested,
    lockedAt: ticket.lockedAt,
    progress: readTicketRuntimeProgress(ticket.payload),
    nowMs,
  })
  const runStatus = presentTicketRunStatus({
    liveness,
    stateLabel: workflowLabel,
    stateHint: workflowHint ?? '',
  })
  const stateLabel = runStatus.label
  // Lezárt lépés-ticket elakadt folyamatban: a „Kész — nincs több teendő" hint
  // önmagában félrevezet, mert a futás máshol (felülvizsgálati ticketen) áll.
  const processStalledHere =
    isProcessStalled(ticket.process?.status) &&
    ['done', 'approved'].includes(ticket.state)
  // „Végrehajtásra vár", de nincs kihez: a diszpécser csak AI munkatárshoz rendelt
  // feladatot vesz fel, ezért egy gazdátlan `ready` ticket magától SOSEM indul el.
  // Ezt ki kell mondani, különben a felhasználó hiába vár rá.
  const ownerlessReady =
    ticket.state === 'ready' && !ticket.agentId && ticket.assigneeType !== 'agent'
  const stateHint = processStalledHere
    ? 'Ez a feladat lezárult, de a folyamat nem ment tovább — lásd a folyamat-sávot alább.'
    : ownerlessReady
      ? 'Nincs AI munkatárs hozzárendelve, ezért magától nem indul el — emberi döntésre vár.'
      : runStatus.hint || null
  const runLive = runStatus.live
  const headerTone = runStatus.stalled ? 'danger' : runStatus.live ? 'neutral' : stateTone
  const typeLabel = ticket.type === 'training' ? 'Tanítás' : 'Interakció'
  const assigneeHint =
    assignee?.detail ??
    (assignee?.type === 'agent'
      ? runLive
        ? 'AI munkatárs — most éppen ezen dolgozik'
        : runStatus.stalled
          ? 'AI munkatárs — a futás elakadt'
          : 'AI munkatárs a felelős'
      : assignee?.type === 'human'
        ? 'Emberi döntésre vár'
        : 'Még senki nem kapta meg')

  return (
    <>
      <header className="atelier-card overflow-hidden">
        <div className={`h-1 w-full bg-gradient-to-r ${HERO_ACCENT_CLASS[headerTone]}`} aria-hidden />
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                <Link href="/control-plane/board" className="transition-colors hover:text-coral-deep">
                  ← Board
                </Link>
                <span aria-hidden>·</span>
                <span>Feladat #{ticket.id.slice(0, 8)}</span>
              </div>
              <h1 className="mt-2 font-display text-2xl font-semibold leading-tight sm:text-3xl">
                {ticket.title}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                    runLive
                      ? 'animate-activity-run-row text-sky'
                      : STATE_PILL_CLASS[headerTone]
                  }`}
                >
                  {runLive ? (
                    <LiveStatusDot size="md" />
                  ) : (
                    <span
                      className={`h-2 w-2 rounded-full ${TICKET_TONE_DOT_CLASS[headerTone]}`}
                      aria-hidden
                    />
                  )}
                  {stateLabel}
                </span>
                <Badge tone="neutral">{typeLabel}</Badge>
                {ticket.process && (
                  <ProcessBadge
                    processInstanceId={ticket.process.id}
                    processType={ticket.process.processType}
                    status={ticket.process.status}
                  />
                )}
                {schedule ? <Badge tone="warning">{schedule.compactLabel}</Badge> : null}
              </div>
              <div className="mt-3 max-w-sm">
                <AssignableWorkProjectSelect
                  id="ticket-project"
                  compact
                  value={projectKey}
                  onChange={handleProjectKeyChange}
                  disabled={!canDispatch || projectPending || dispatchPending || runNowPending || deletePending}
                />
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {canRunNow && (
                <button
                  type="button"
                  onClick={handleRunNow}
                  disabled={runNowPending || deletePending || discussPending}
                  className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-coral-deep disabled:opacity-40"
                  title="A sorozat következő futását azonnal elindítja. A rákövetkező időpont a megszokott ütemezés szerint marad."
                >
                  {runNowPending ? 'Indítás…' : 'Futtatás most'}
                </button>
              )}
              {canStartDispatch && (
                <button
                  type="button"
                  onClick={handleStartDispatch}
                  disabled={dispatchPending || deletePending || discussPending || runNowPending}
                  className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-coral-deep disabled:opacity-40"
                  title="Kézi feldolgozás indítása — függetlenül a dispatcher állapotától"
                >
                  {dispatchPending ? 'Indítás…' : 'Feldolgozás indítása'}
                </button>
              )}
              {discussAgentId ? (
                <button
                  type="button"
                  onClick={handleDiscuss}
                  disabled={discussPending || deletePending || dispatchPending || runNowPending}
                  className="rounded-full border border-sky/35 bg-sky/10 px-4 py-2.5 text-sm font-semibold text-sky transition-colors hover:bg-sky/20 disabled:opacity-40"
                  title="Új chat az AI munkatárssal — a feladat előzményével a háttérben"
                >
                  {discussPending ? 'Megnyitás…' : 'Megbeszélés'}
                </button>
              ) : null}
              {canRunAnalysis && runAnalystAgentId ? (
                <RunAnalysisButton
                  runAnalystAgentId={runAnalystAgentId}
                  scope={{ kind: 'ticket', ticketId: ticket.id, title: ticket.title }}
                />
              ) : null}
              {canEditTask ? (
                <Link
                  href={`/control-plane/tickets/${ticket.id}?edit=1#feladat-szal`}
                  className="rounded-full border border-honey/35 bg-honey/10 px-4 py-2.5 text-sm font-semibold text-honey transition-colors hover:bg-honey/20"
                  title="Feladat leírása és ütemezés módosítása — csak indítás előtt"
                >
                  Szerkesztés
                </Link>
              ) : null}
              {canDelete && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deletePending || dispatchPending || discussPending}
                  className="rounded-full border border-coral/35 bg-coral/10 px-4 py-2.5 text-sm font-semibold text-coral transition-colors hover:bg-coral/20 disabled:opacity-40"
                  title={
                    isAdminDelete
                      ? 'Admin törlés — bármilyen állapotú feladat'
                      : 'A feladat törlése — csak feldolgozás megkezdése előtt'
                  }
                >
                  {deletePending ? 'Törlés…' : 'Törlés'}
                </button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleExportDebugLog}
                  disabled={debugLogPending}
                  className="rounded-full border border-line bg-card px-4 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:text-honey disabled:opacity-40"
                  title="Teljes feladat-telemetria letöltése elemzéshez (szál, model/tool, audit, kapcsolt beszélgetés)"
                >
                  {debugLogPending ? 'Log…' : 'Debug-log'}
                </button>
              )}
              <Link
                href="/control-plane/board"
                aria-label="Feladat bezárása és vissza a Boardhoz"
                title="Bezárás és vissza a Boardhoz"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-card text-lg leading-none text-ink-soft transition-colors hover:border-coral/35 hover:bg-coral/10 hover:text-coral-deep"
              >
                <span aria-hidden>×</span>
              </Link>
            </div>
          </div>

          {headerMessage && (
            <p
              className={`mt-3 text-sm ${headerMessage.tone === 'ok' ? 'text-sage' : 'text-coral'}`}
              role="status"
            >
              {headerMessage.text}
            </p>
          )}

          <dl className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-line bg-line/70 sm:grid-cols-2 xl:grid-cols-4">
            <HeroFact
              label="Hol tart"
              value={stateLabel}
              hint={stateHint}
              dotClass={
                runLive
                  ? 'bg-sky'
                  : TICKET_TONE_DOT_CLASS[headerTone]
              }
              live={runLive}
            />
            <HeroFact
              label="Ki dolgozik rajta"
              value={assignee?.label ?? 'Nincs hozzárendelve'}
              valueHref={assigneeAgentHref}
              hint={assigneeHint}
            />
            <HeroFact
              label="Ki kérte"
              value={ticket.creator?.label ?? 'Ismeretlen'}
              hint={`Létrehozva: ${formatTicketDateTime(ticket.createdAt)}`}
            />
            <HeroFact
              label="Utolsó mozgás"
              value={formatTicketDateTime(ticket.updatedAt)}
              hint={
                runLive
                  ? 'A lépések élőben frissülnek alább.'
                  : runStatus.stalled
                    ? 'Nincs friss jelzés — a futás elakadhatott.'
                    : `${typeLabel} típusú feladat`
              }
            />
            {schedule ? (
              <HeroFact
                label="Ütemezés"
                value={
                  schedule.kind === 'recurring'
                    ? schedule.compactLabel
                    : formatTicketDateTime(schedule.runAt)
                }
                hint={schedule.label}
              />
            ) : null}
          </dl>
        </div>
      </header>

      {contractReview && (
        <Card title={contractReview.title ?? 'Miért állt meg a lépés'} className="border-coral/25 bg-coral/5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{contractReview.message}</p>
          {contractReview.answer && (
            <div className="mt-3 border-t border-ink/10 pt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Az AI munkatárs eredeti válasza
              </p>
              <ChatMarkdown content={contractReview.answer} variant="agent" />
            </div>
          )}
        </Card>
      )}

      {proposal && <ProposalCard proposal={proposal} />}

      {diff && (
        <Card title="Tanítási diff">
          <pre className="overflow-x-auto text-xs text-ink-soft">{JSON.stringify(diff, null, 2)}</pre>
        </Card>
      )}
    </>
  )
}

const HERO_ACCENT_CLASS: Record<'neutral' | 'success' | 'warning' | 'danger', string> = {
  neutral: 'from-sky via-sky/40 to-transparent',
  success: 'from-sage via-sage/40 to-transparent',
  warning: 'from-honey via-honey/40 to-transparent',
  danger: 'from-coral via-coral/40 to-transparent',
}

const STATE_PILL_CLASS: Record<'neutral' | 'success' | 'warning' | 'danger', string> = {
  neutral: 'bg-ink/8 text-ink-soft',
  success: 'bg-sage/15 text-sage',
  warning: 'bg-honey/15 text-honey',
  danger: 'bg-coral/15 text-coral',
}

/** Élő „radar” pötty — futó feladaton rögtön látszik, hogy dolgozik valami. */
function LiveStatusDot({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2'
  return (
    <span className={`relative flex shrink-0 ${dim}`} aria-hidden>
      <span
        className={`absolute inline-flex h-full w-full rounded-full bg-sky opacity-60 animate-activity-run-dot`}
      />
      <span className={`relative inline-flex rounded-full bg-sky ${dim}`} />
    </span>
  )
}

function HeroFact({
  label,
  value,
  valueHref,
  hint,
  dotClass,
  live = false,
}: {
  label: string
  value: string
  valueHref?: string | null
  hint?: string | null
  dotClass?: string
  live?: boolean
}) {
  return (
    <div className={`bg-card px-4 py-3 ${live ? 'animate-activity-run-row' : ''}`}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </dt>
      <dd
        className={`mt-1 flex items-center gap-2 text-sm font-semibold ${live ? 'text-sky' : 'text-ink'}`}
      >
        {live ? (
          <LiveStatusDot size="md" />
        ) : (
          dotClass && <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />
        )}
        {valueHref ? (
          <Link
            href={valueHref}
            className="truncate text-sky transition-colors hover:text-coral-deep"
            title={value}
          >
            {value}
          </Link>
        ) : (
          <span className="truncate" title={value}>
            {value}
          </span>
        )}
      </dd>
      {hint && <p className="mt-1 text-xs leading-snug text-ink-soft">{hint}</p>}
    </div>
  )
}

/**
 * Technikai kiegészítők (reprodukálhatóság, nyers payload) — az oldalsávban,
 * hogy ne törjék meg a feladat olvasható fő sávját.
 */
export function TicketTechnicalPanels({
  ticket,
  isAdmin = false,
}: {
  ticket: TicketView
  isAdmin?: boolean
}) {
  const payload = ticket.payload as Record<string, unknown> | null
  const hasAnatomy =
    payload?.agentVersion != null ||
    payload?.memoryVersion != null ||
    payload?.model != null ||
    payload?.recipeName != null ||
    payload?.recipeVersion != null ||
    Boolean(ticket.reproduction?.recipe)

  if (!hasAnatomy && !isAdmin) return null

  return (
    <>
      {hasAnatomy && (
        <Card title="Hogyan készült">
          <p className="-mt-2 mb-3 text-xs leading-relaxed text-ink-soft">
            Ezekkel a beállításokkal futott az AI munkatárs — ez teszi a futást reprodukálhatóvá.
          </p>
          <dl className="space-y-2 text-sm">
            {(payload?.agentVersion != null || ticket.reproduction?.agentVersion != null) && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">AI munkatárs verzió</dt>
                <dd className="font-mono text-ink">
                  v{String(payload?.agentVersion ?? ticket.reproduction?.agentVersion)}
                </dd>
              </div>
            )}
            {(payload?.memoryVersion != null || ticket.reproduction?.memoryVersion != null) && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Memória verzió</dt>
                <dd className="font-mono text-ink">
                  v{String(payload?.memoryVersion ?? ticket.reproduction?.memoryVersion)}
                </dd>
              </div>
            )}
            {(payload?.recipeName != null || ticket.reproduction?.recipe?.name) && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Recept</dt>
                <dd className="truncate font-mono text-ink">
                  {String(payload?.recipeName ?? ticket.reproduction?.recipe?.name)} v
                  {String(payload?.recipeVersion ?? ticket.reproduction?.recipe?.version)}
                </dd>
              </div>
            )}
            {payload?.model != null && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Modell</dt>
                <dd className="truncate font-mono text-ink">{String(payload.model as string)}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      {isAdmin && (
        <Card title="Nyers adat (fejlesztői)">
          <details>
            <summary className="cursor-pointer text-xs text-ink-faint">
              Raw JSON megjelenítése
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto text-xs text-ink-soft">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </details>
        </Card>
      )}
    </>
  )
}
