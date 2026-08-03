'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import Link from 'next/link'
import type { ProcessStatus } from '@prisma/client'
import { transitionTicket, deleteBoardTicket } from '@/app/actions/platform'
import { exportTicketDebugLog } from '@/app/actions/debug-log'
import { startProcessFromTicket } from '@/app/actions/process'
import { authorizeTicketRunAs, revokeTicketRunAs } from '@/app/actions/connector-grants'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge, Card } from '@/components/ui/shell'
import { ProcessBadge } from '@/components/processes/process-badge'
import {
  TICKET_STATE_HINTS,
  TICKET_STATE_LABELS,
  TICKET_STATE_TONE,
  TICKET_TONE_DOT_CLASS,
} from '@/lib/ticket-labels'
import { formatTicketDateTime } from '@/lib/ticket-display'
import { isRunAsAuthorized } from '@/lib/run-as-payload'
import { resolveTicketTriggerInputPayload } from '@/lib/playbook-v2/trigger-input'
import { readStepOutcome } from '@/lib/playbook-v2/process-step-payload'
import { readTicketCallCapMessageFromPayload } from '@/lib/ticket-call-cap'

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
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const isTrainingTicket = ticket.type === 'training'
  const canApprove = ticket.state === 'awaiting_human'
  const canReject = REJECTABLE_STATES.has(ticket.state)
  const callCapMessage = readTicketCallCapMessageFromPayload(ticket.payload)
  const canRerun = ticket.state === 'rejected' && !callCapMessage
  // Call-cap rejected: nincs újraindítás, de a panel kell az üzenethez.
  const showRejectedCallCapNotice = ticket.state === 'rejected' && Boolean(callCapMessage)
  const hasActions = canApprove || canReject || canRerun || showRejectedCallCapNotice
  const isWikiFollowUp = hasWikiAnswer(ticket.payload)

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

  if (!hasActions) return null

  return (
    <Card title="Döntés">
      <p className="-mt-2 mb-4 text-sm text-ink-soft">
        {TICKET_STATE_HINTS[ticket.state] ?? 'Válaszd ki, hogyan folytatódjon a feladat.'}
      </p>
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
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
  canDelete = false,
  isAdminDelete = false,
}: {
  ticket: TicketView
  isAdmin?: boolean
  canDispatch?: boolean
  canDelete?: boolean
  isAdminDelete?: boolean
}) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const payload = ticket.payload as Record<string, unknown> | null
  const proposal = payload?.proposal as Record<string, unknown> | undefined
  const diff = payload?.diff as Record<string, unknown> | undefined
  const assignee = ticket.assignee
  const contractReview = contractReviewFromPayload(payload)
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [dispatchPending, startDispatchTransition] = useTransition()
  const [deletePending, startDeleteTransition] = useTransition()
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

  function handleDelete() {
    const confirmMessage = isAdminDelete
      ? 'Biztosan véglegesen törlöd ezt a feladatot (admin)? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.'
      : 'Biztosan törlöd ezt a feladatot? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.'
    if (!window.confirm(confirmMessage)) {
      return
    }

    startDeleteTransition(async () => {
      setHeaderMessage(null)
      const res = await deleteBoardTicket({ ticketId: ticket.id })
      if (!res.success) {
        setHeaderMessage({ tone: 'err', text: res.error })
        return
      }
      router.replace('/control-plane/board')
    })
  }

  const stateTone = TICKET_STATE_TONE[ticket.state] ?? 'neutral'
  const stateLabel = TICKET_STATE_LABELS[ticket.state] ?? ticket.state
  const stateHint = TICKET_STATE_HINTS[ticket.state] ?? null
  const typeLabel = ticket.type === 'training' ? 'Tanítás' : 'Interakció'
  const assigneeHint =
    assignee?.detail ??
    (assignee?.type === 'agent'
      ? ticket.state === 'in_progress'
        ? 'AI munkatárs — most éppen ezen dolgozik'
        : 'AI munkatárs a felelős'
      : assignee?.type === 'human'
        ? 'Emberi döntésre vár'
        : 'Még senki nem kapta meg')

  return (
    <>
      <header className="atelier-card overflow-hidden">
        <div className={`h-1 w-full bg-gradient-to-r ${HERO_ACCENT_CLASS[stateTone]}`} aria-hidden />
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
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${STATE_PILL_CLASS[stateTone]}`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${TICKET_TONE_DOT_CLASS[stateTone]} ${
                      ticket.state === 'in_progress' ? 'animate-soul' : ''
                    }`}
                    aria-hidden
                  />
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
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {canStartDispatch && (
                <button
                  type="button"
                  onClick={handleStartDispatch}
                  disabled={dispatchPending || deletePending}
                  className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-coral-deep disabled:opacity-40"
                  title="Kézi feldolgozás indítása — függetlenül a dispatcher állapotától"
                >
                  {dispatchPending ? 'Indítás…' : 'Feldolgozás indítása'}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deletePending || dispatchPending}
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
            <HeroFact label="Hol tart" value={stateLabel} hint={stateHint} dotClass={TICKET_TONE_DOT_CLASS[stateTone]} />
            <HeroFact
              label="Ki dolgozik rajta"
              value={assignee?.label ?? 'Nincs hozzárendelve'}
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
                ticket.state === 'in_progress'
                  ? 'A lépések élőben frissülnek alább.'
                  : `${typeLabel} típusú feladat`
              }
            />
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
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                {contractReview.answer}
              </p>
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

function HeroFact({
  label,
  value,
  hint,
  dotClass,
}: {
  label: string
  value: string
  hint?: string | null
  dotClass?: string
}) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </dt>
      <dd className="mt-1 flex items-center gap-2 text-sm font-semibold text-ink">
        {dotClass && <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />}
        <span className="truncate" title={value}>
          {value}
        </span>
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
