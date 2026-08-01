'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import type { ProcessStatus } from '@prisma/client'
import { transitionTicket } from '@/app/actions/platform'
import { exportTicketDebugLog } from '@/app/actions/debug-log'
import { startProcessFromTicket } from '@/app/actions/process'
import { authorizeTicketRunAs, revokeTicketRunAs } from '@/app/actions/connector-grants'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge, Card } from '@/components/ui/shell'
import { ProcessBadge } from '@/components/processes/process-badge'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'
import { formatTicketDateTime } from '@/lib/ticket-display'
import { isRunAsAuthorized } from '@/lib/run-as-payload'
import { resolveTicketTriggerInputPayload } from '@/lib/playbook-v2/trigger-input'
import { readStepOutcome } from '@/lib/playbook-v2/process-step-payload'
import { readTicketCallCapMessageFromPayload } from '@/lib/ticket-call-cap'
import {
  assessTicketRunLiveness,
  formatTicketProgressAge,
  readTicketRuntimeProgress,
} from '@/domain/agent/ticket-runtime-progress'

type TicketView = {
  id: string
  title: string
  type: string
  state: string
  payload: unknown
  sourceDocumentId: string | null
  conversationId?: string | null
  createdAt: string | Date
  updatedAt: string | Date
  lockedAt?: string | Date | null
  cancelRequested?: boolean
  assigneeType?: string | null
  assigneeId?: string | null
  agentId?: string | null
  processInstanceId?: string | null
  taskDescription?: string | null
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
      setMessage('Run-as felhatalmazás rögzítve — az AI munkatárs a te fiókoddal járhat el autonóm futásnál.')
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
      setMessage('Run-as felhatalmazás visszavonva.')
      router.refresh()
    })
  }

  return (
    <Card title="Run-as felhatalmazás">
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      {message && <p className="mb-3 text-sm text-sage">{message}</p>}
      {authorized ? (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            Autonóm futáshoz engedélyezve: a per-user connectorok a te fiókoddal futnak ezen a feladaton.
          </p>
          {canManageRunAs && (
            <button
              type="button"
              disabled={pending}
              onClick={revoke}
              className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
            >
              Run-as visszavonása
            </button>
          )}
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            Ha az AI munkatárs autonóm futáskor (pl. ütemezett feladat) a te Gmail-fiókodat használja, itt adhatod meg
            előre a felhatalmazást. Implicit öröklés nélkül — csak explicit, visszavonható engedély.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={authorize}
            className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky hover:bg-sky/30 disabled:opacity-50"
          >
            Run-as engedélyezése
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

export function TicketActions({ ticket }: { ticket: TicketView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [stopPending, setStopPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const isTrainingTicket = ticket.type === 'training'
  const canApprove = ticket.state === 'awaiting_human'
  const canReject = REJECTABLE_STATES.has(ticket.state)
  const callCapMessage = readTicketCallCapMessageFromPayload(ticket.payload)
  const canRerun = ticket.state === 'rejected' && !callCapMessage
  const canStop = ticket.state === 'in_progress'
  // Call-cap rejected: nincs újraindítás, de a panel kell az üzenethez.
  const showRejectedCallCapNotice = ticket.state === 'rejected' && Boolean(callCapMessage)
  const hasActions = canApprove || canReject || canRerun || canStop || showRejectedCallCapNotice
  const isWikiFollowUp = hasWikiAnswer(ticket.payload)

  const runtimeProgress = readTicketRuntimeProgress(ticket.payload)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!canStop) return
    const timer = window.setInterval(() => {
      router.refresh()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [canStop, router])

  useEffect(() => {
    if (!canStop) return
    const tick = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(tick)
  }, [canStop])

  const runLiveness = assessTicketRunLiveness({
    ticketState: ticket.state,
    cancelRequested: ticket.cancelRequested,
    lockedAt: ticket.lockedAt,
    progress: runtimeProgress,
    nowMs,
  })

  const act = (toState: string) => {
    if (toState === 'rejected' && isWikiFollowUp && !note.trim()) {
      setError('Pontosító kérdés vagy indoklás megadása kötelező a visszadobáshoz.')
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

  const stopProcessing = () => {
    if (stopPending) return
    setStopPending(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(`/api/v1/tickets/${ticket.id}/cancel`, { method: 'POST' })
        if (!res.ok) {
          setError(
            res.status === 404
              ? 'A feladat már nem fut — lehet, hogy befejeződött.'
              : 'Leállítás sikertelen.',
          )
        }
        router.refresh()
      } catch {
        setError('Leállítás sikertelen.')
      } finally {
        setStopPending(false)
      }
    })()
  }

  if (!hasActions) {
    return (
      <Card title="Műveletek">
        <p className="text-sm text-ink-soft">
          Jelenleg nincs elvégezhető művelet ezen az állapoton ({TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
          ).
        </p>
      </Card>
    )
  }

  return (
    <Card title="Műveletek">
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      {canStop && (
        <div
          className={`mb-4 rounded-xl border px-3 py-3 ${
            runLiveness.kind === 'stalled'
              ? 'border-coral/40 bg-coral/5'
              : runLiveness.kind === 'quiet' || runLiveness.kind === 'cancelling'
                ? 'border-honey/40 bg-honey/5'
                : 'border-sky/30 bg-sky/5'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-ink">
                {runLiveness.kind === 'stalled'
                  ? 'Feldolgozás — úgy tűnik megállt'
                  : runLiveness.kind === 'cancelling'
                    ? 'Feldolgozás — leállítás folyamatban'
                    : runLiveness.kind === 'quiet'
                      ? 'Feldolgozás — lassú jelzés'
                      : 'Feldolgozás folyamatban'}
              </p>
              <p className="text-xs text-ink-faint">
                {runLiveness.kind === 'stalled'
                  ? `Nincs friss aktivitás ${formatTicketProgressAge(runLiveness.ageMs)}. Beragadás esetén leállíthatod.`
                  : runLiveness.kind === 'active' && runLiveness.currentStep
                    ? `Most: ${runLiveness.currentStep}`
                    : runLiveness.kind === 'quiet' && runLiveness.currentStep
                      ? `Utolsó lépés: ${runLiveness.currentStep} · ${formatTicketProgressAge(runLiveness.ageMs)}`
                      : 'Az AI munkatárs a háttérben dolgozik. A részletes lépések az Eseménytörténetben.'}
              </p>
            </div>
            <button
              type="button"
              disabled={stopPending}
              onClick={stopProcessing}
              className="rounded-full border border-coral/40 bg-coral/15 px-4 py-2 text-sm font-semibold text-coral-deep hover:bg-coral/25 disabled:opacity-50"
            >
              {stopPending ? 'Leállítás…' : 'Feldolgozás leállítása'}
            </button>
          </div>
        </div>
      )}
      <textarea
        className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
        placeholder={
          isWikiFollowUp && canReject
            ? 'Pontosító kérdés vagy indoklás (visszadobáshoz kötelező)'
            : 'Indoklás vagy pontosító kérdés (opcionális)'
        }
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approved')}
            className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
          >
            {isTrainingTicket ? 'Tanítás jóváhagyása (write-gate)' : 'Jóváhagyás'}
          </button>
        )}
        {canReject && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('rejected')}
            className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
          >
            Visszadobás
          </button>
        )}
        {canRerun && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('ready')}
            className="rounded-full bg-honey/20 px-4 py-2 text-sm font-semibold text-honey disabled:opacity-50"
          >
            Újra feldolgozás
          </button>
        )}
      </div>
      {ticket.state === 'rejected' && callCapMessage && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-coral">{callCapMessage}</p>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        {canApprove &&
          isTrainingTicket &&
          'Tanítási feladat: a jóváhagyás write-gate-en keresztül frissíti az AI munkatárs memóriáját, majd done állapotba zár. '}
        {canApprove &&
          !isTrainingTicket &&
          'Jóváhagyás után a szerver automatikusan: approved → done. '}
        {canReject &&
          !callCapMessage &&
          'Visszadobás után az «Újra feldolgozás» gombbal indíthatod újra az AI munkatársat — a pontosító kérdés bekerül a kontextusba. '}
        {canRerun && 'Újra feldolgozás után a feladat ready állapotba kerül, és a dispatcher újraindítja az AI munkatársat.'}
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
  return null
}

export function TicketMeta({
  ticket,
  isAdmin = false,
  canDispatch = false,
}: {
  ticket: TicketView
  isAdmin?: boolean
  canDispatch?: boolean
}) {
  const dispatchTicket = useTicketDispatch()
  const payload = ticket.payload as Record<string, unknown> | null
  const proposal = payload?.proposal as Record<string, unknown> | undefined
  const diff = payload?.diff as Record<string, unknown> | undefined
  const assignee = ticket.assignee
  const contractReview = contractReviewFromPayload(payload)
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [dispatchPending, startDispatchTransition] = useTransition()
  const [headerMessage, setHeaderMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  )

  const canStartDispatch =
    canDispatch &&
    ticket.state === 'ready' &&
    ticket.assigneeType === 'agent' &&
    Boolean(ticket.assigneeId)

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

  const headerButtonClass =
    'rounded-xl border border-line px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40'

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">{ticket.title}</h1>
        <Badge tone={TICKET_STATE_TONE[ticket.state] ?? 'neutral'}>
          {TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
        </Badge>
        <Badge tone="neutral">{ticket.type === 'training' ? 'Tanítás' : 'Interakció'}</Badge>
        {ticket.process && (
          <ProcessBadge
            processInstanceId={ticket.process.id}
            processType={ticket.process.processType}
            status={ticket.process.status}
          />
        )}
        {canStartDispatch && (
          <button
            type="button"
            onClick={handleStartDispatch}
            disabled={dispatchPending}
            className={`${headerButtonClass} text-ink-soft hover:border-accent/50 hover:bg-accent/10 hover:text-accent`}
            title="Kézi feldolgozás indítása — függetlenül a dispatcher állapotától"
          >
            {dispatchPending ? 'Indítás…' : 'Feldolgozás indítása'}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={handleExportDebugLog}
            disabled={debugLogPending}
            className={`${headerButtonClass} text-ink-soft hover:border-honey/50 hover:bg-honey/10 hover:text-honey`}
            title="Teljes feladat-telemetria letöltése elemzéshez (szál, model/tool, audit, kapcsolt beszélgetés)"
          >
            {debugLogPending ? 'Log…' : 'Debug-log'}
          </button>
        )}
      </div>
      {headerMessage && (
        <p
          className={`mt-2 text-xs ${headerMessage.tone === 'ok' ? 'text-sage' : 'text-coral'}`}
          role="status"
        >
          {headerMessage.text}
        </p>
      )}

      {contractReview && (
        <Card title={contractReview.title ?? 'Miért állt meg a lépés'} className="mt-4 border-coral/25 bg-coral/5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{contractReview.message}</p>
          {contractReview.answer && (
            <div className="mt-3 border-t border-ink/10 pt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Az AI munkatárs eredeti válasza
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                {contractReview.answer}
              </p>
            </div>
          )}
        </Card>
      )}

      <Card title="Metaadatok" className="mt-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {ticket.creator && (
            <>
              <dt className="text-ink-faint">Létrehozta</dt>
              <dd className="text-ink">{ticket.creator.label}</dd>
            </>
          )}
          <dt className="text-ink-faint">Létrehozva</dt>
          <dd className="text-ink">{formatTicketDateTime(ticket.createdAt)}</dd>
          <dt className="text-ink-faint">Utolsó módosítás</dt>
          <dd className="text-ink">{formatTicketDateTime(ticket.updatedAt)}</dd>
        </dl>
      </Card>

      <Card title="Hozzárendelve" className="mt-6">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-semibold text-ink">
            {assignee?.label ?? 'Nincs hozzárendelve'}
          </span>
          {assignee?.type === 'agent' && <Badge tone="neutral">AI munkatárs</Badge>}
          {assignee?.type === 'human' && <Badge tone="warning">Ember</Badge>}
        </div>
        {assignee?.detail && (
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">{assignee.detail}</p>
        )}
      </Card>

      {proposal && <ProposalCard proposal={proposal} className="mt-6" />}

      {diff && (
        <Card title="Tanítási diff" className="mt-6">
          <pre className="overflow-x-auto text-xs text-ink-soft">{JSON.stringify(diff, null, 2)}</pre>
        </Card>
      )}

      {(payload?.agentVersion != null ||
        payload?.memoryVersion != null ||
        payload?.model != null ||
        payload?.recipeName != null ||
        payload?.recipeVersion != null ||
        ticket.reproduction?.recipe) && (
        <Card title="AI munkatárs anatómia (reprodukálhatóság)" className="mt-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {(payload?.agentVersion != null || ticket.reproduction?.agentVersion != null) && (
              <>
                <dt className="text-ink-faint">AI munkatárs verzió</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  v{String(payload?.agentVersion ?? ticket.reproduction?.agentVersion)}
                </dd>
              </>
            )}
            {(payload?.memoryVersion != null || ticket.reproduction?.memoryVersion != null) && (
              <>
                <dt className="text-ink-faint">Memória verzió</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  v{String(payload?.memoryVersion ?? ticket.reproduction?.memoryVersion)}
                </dd>
              </>
            )}
            {(payload?.recipeName != null || ticket.reproduction?.recipe?.name) && (
              <>
                <dt className="text-ink-faint">Recipe</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  {String(payload?.recipeName ?? ticket.reproduction?.recipe?.name)} v
                  {String(payload?.recipeVersion ?? ticket.reproduction?.recipe?.version)}
                </dd>
              </>
            )}
            {payload?.model != null && (
              <>
                <dt className="text-ink-faint">Modell</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  {String(payload.model as string)}
                </dd>
              </>
            )}
          </dl>
        </Card>
      )}

      {isAdmin && (
        <Card title="Payload (debug)" className="mt-6">
          <details>
            <summary className="cursor-pointer text-xs text-ink-faint">Raw JSON megjelenítése</summary>
            <pre className="mt-3 overflow-x-auto text-xs text-ink-soft">{JSON.stringify(payload, null, 2)}</pre>
          </details>
        </Card>
      )}
    </>
  )
}
