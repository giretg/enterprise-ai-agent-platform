'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition, type ReactNode } from 'react'
import {
  approveConsequenceApproval,
  approveMemoryCandidate,
  modifyMemoryCandidate,
  rejectConsequenceApproval,
  rejectMemoryCandidate,
  ticketMemoryCandidate,
} from '@/app/actions/platform'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ChatMarkdown } from '@/components/chat/chat-markdown'
import { ConnectorGrantNeededPanel } from '@/components/connectors/connector-grant-needed-panel'
import type { ConnectorGrantNeededView } from '@/components/connectors/connector-grant-needed-panel'
import { PrivacyHighlightedText } from '@/components/privacy/privacy-highlighted-text'
import type { PrivacyEntityMarker } from '@/domain/privacy/privacy-observability'
import {
  buildChatPrivacyMarkers,
  privacyHighlightEnabled,
  type ChatPrivacyMarkerContext,
} from '@/lib/privacy-chat-markers'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
import { ChatTaskCard, ChatTaskCardSkeleton } from '@/components/tickets/chat-task-card'
import { MEMORY_TYPE_LABELS, type ChatTaskCardView } from '@/lib/work-traceability'
import { memoryProjectKeyLabel } from '@/lib/memory-ui-labels'
import {
  approvalContinuationDisplayText,
  extractApprovalContinuationTechnicalDetails,
  isApprovalContinuationMessage,
} from '@/lib/consequence-approval-display'

export type AgentActivity = {
  id: string
  kind: 'reasoning' | 'tool'
  title: string
  detail?: string
  status: 'running' | 'done' | 'error' | 'skipped'
  archivePath?: string
}

export type MemoryCandidateCard = {
  candidateId: string
  operation: string
  type: string | null
  title: string | null
  summary: string | null
  projectKey: string
  workstreamKey: string | null
  status: 'proposed' | 'approved' | 'ticketed' | 'rejected'
  resultMessage?: string
}

export type ConsequenceApprovalCard = {
  approvalId: string
  toolName: string
  summary: string
  expiresAt: string
  status: 'pending' | 'approved' | 'rejected'
  expired?: boolean
  resultMessage?: string
  resultSummary?: string
  failedReason?: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'agent' | 'system' | 'tool'
  text: string
  attachments: Array<{
    documentId: string
    filename: string
    kind: 'text' | 'image'
    previewDataUrl?: string | null
  }>
  createdAt: string
  contentDeletedAt?: string | null
  ticketRefId?: string | null
  activities?: AgentActivity[]
  memoryCandidates?: MemoryCandidateCard[]
  consequenceApprovals?: ConsequenceApprovalCard[]
  connectorGrants?: ConnectorGrantNeededView[]
  thinking?: Record<string, string>
  privacyMarkers?: PrivacyEntityMarker[]
}

function activityStatusLabel(status: AgentActivity['status']): string {
  switch (status) {
    case 'running':
      return 'fut'
    case 'done':
      return 'kész'
    case 'skipped':
      return 'kihagyva'
    case 'error':
      return 'hiba'
  }
}

function activityDotClass(status: AgentActivity['status']): string {
  switch (status) {
    case 'running':
      return 'bg-sky'
    case 'done':
      return 'bg-sage'
    case 'skipped':
      return 'bg-honey'
    case 'error':
      return 'bg-coral'
  }
}

const MEMORY_CANDIDATE_STATUS_LABEL: Record<MemoryCandidateCard['status'], string> = {
  proposed: 'Jóváhagyásra vár',
  approved: 'Jóváhagyva',
  ticketed: 'Ticketben (jóváhagyásra vár)',
  rejected: 'Elutasítva',
}

/**
 * Fejléc-menü a ritkán használt szál-műveleteknek. Korábban 5 gomb versengett
 * a fejlécben az agent nevével — a napi használatban egyik sem kell, viszont
 * elvonta a figyelmet a beszélgetésről.
 */
export function ChatHeaderMenu({
  label = 'Szál műveletei',
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        title={label}
        className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
          open
            ? 'border-coral/40 bg-coral/10 text-coral-deep'
            : 'border-line text-ink-soft hover:border-coral/30 hover:text-coral-deep'
        }`}
      >
        <span aria-hidden className="text-sm leading-none">⋯</span>
        <span className="hidden lg:inline">Műveletek</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-40 mt-1.5 w-[min(16rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line bg-card p-1 shadow-xl"
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}

export function ChatMenuItem({
  onClick,
  disabled,
  title,
  hint,
  tone = 'neutral',
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  hint: string
  tone?: 'neutral' | 'warn'
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-40 ${
        tone === 'warn' ? 'hover:bg-honey/10' : 'hover:bg-night-2'
      }`}
    >
      <span className="block text-xs font-semibold text-ink">{title}</span>
      <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{hint}</span>
    </button>
  )
}

function activityLiveThinking(
  activity: AgentActivity,
  thinking?: Record<string, string>,
): string | undefined {
  // Chat "thinking-trace" (§6.1/D6): amíg a reasoning-kör fut, a szerverről
  // streamelt (már redaktált) gondolkodás-szöveget élőben mutatjuk; lezáráskor
  // az activity összefoglaló `detail`-je veszi át — vizuálisan dőlt/másodlagos.
  if (activity.kind !== 'reasoning' || activity.status !== 'running') return undefined
  return thinking?.[activity.id]?.trim() || undefined
}

function activityDisplayTitle(activity: AgentActivity): string {
  if (activity.kind === 'tool') return getToolUiLabel(activity.title).label
  return activity.title
}

function PrivacyObservedText({
  text,
  privacyContext,
  className,
}: {
  text: string
  privacyContext: ChatPrivacyMarkerContext | null
  className?: string
}) {
  const markers = useMemo(
    () => buildChatPrivacyMarkers(text, privacyContext),
    [text, privacyContext],
  )
  if (!privacyHighlightEnabled(privacyContext) || markers.length === 0) {
    return <span className={className}>{text}</span>
  }
  return <PrivacyHighlightedText text={text} markers={markers} className={className} />
}

function AgentActivityRow({
  activity,
  thinking,
  prominent = false,
  privacyContext,
}: {
  activity: AgentActivity
  thinking?: Record<string, string>
  /** Collapsed preview of the running step — stronger motion + wash. */
  prominent?: boolean
  privacyContext: ChatPrivacyMarkerContext | null
}) {
  const liveThinking = activityLiveThinking(activity, thinking)
  const running = activity.status === 'running'
  const title = liveThinking ? 'Gondolkodás' : activityDisplayTitle(activity)

  return (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-md ${
        prominent && running ? '-mx-1 px-1 py-1 animate-activity-run-row' : ''
      }`}
    >
      <span
        className={`mt-1.5 shrink-0 rounded-full ${activityDotClass(activity.status)} ${
          running
            ? prominent
              ? 'h-2.5 w-2.5 animate-activity-run-dot'
              : 'h-2 w-2 animate-pulse'
            : 'h-2 w-2'
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-ink" title={activity.title}>
            {title}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
            {activityStatusLabel(activity.status)}
          </span>
        </div>
        {liveThinking ? (
          <p
            className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] italic text-ink-faint"
            aria-live="polite"
          >
            <PrivacyObservedText text={liveThinking} privacyContext={privacyContext} />
          </p>
        ) : (
          (activity.detail || activity.archivePath) && (
            <p
              className={`truncate text-[11px] text-ink-faint ${
                activity.kind === 'reasoning' ? 'italic' : ''
              }`}
              title={activity.archivePath ?? activity.detail}
            >
              {activity.detail ? (
                <PrivacyObservedText text={activity.detail} privacyContext={privacyContext} />
              ) : null}
              {activity.archivePath ? (
                <>
                  {activity.detail ? ' · ' : null}
                  <PrivacyObservedText text={activity.archivePath} privacyContext={privacyContext} />
                </>
              ) : null}
            </p>
          )
        )}
      </div>
    </div>
  )
}

function AgentActivityPanel({
  activities,
  thinking,
  separated,
  privacyContext,
  stalled = false,
  stallDetail,
}: {
  activities: AgentActivity[]
  thinking?: Record<string, string>
  /** Követi-e válaszszöveg — csak akkor kell elválasztó vonal. */
  separated: boolean
  privacyContext: ChatPrivacyMarkerContext | null
  /** Heartbeat elmaradt — a lépés „running", de a futás valószínűleg elhalt. */
  stalled?: boolean
  stallDetail?: string | null
}) {
  // Alapból zárt — a teljes lista csak kattintásra nyílik; stream közben sem
  // erőltetjük ki a nyitást, hogy a user választása megmaradjon.
  const [open, setOpen] = useState(false)
  const running = activities.find((activity) => activity.status === 'running')
  const activelyWorking = running && !stalled
  const latest = running ?? activities[activities.length - 1]
  const hasError = activities.some((activity) => activity.status === 'error')
  const headerHint = stalled
    ? stallDetail ?? 'Nincs friss életjel — a válasz valószínűleg elhalt.'
    : activelyWorking
      ? `${activityDisplayTitle(running!)} fut`
      : hasError
        ? 'Műveletek hibával'
        : 'Műveletek kész'

  // A panel a válasz-buborékon BELÜL él, ezért nem kap saját keretet: a
  // "doboz a dobozban" hatás volt a régi elrendezés legzavaróbb eleme. A
  // munkamenetet egy hajszálvonal választja el a tényleges választól.
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onClick={(event) => {
        if (!open) return
        // A summary natív toggle-je zárja a panelt; a lista bármely pontján
        // ugyanazt várjuk — különben a nagy dobozban keresni kell az „elrejt”-et.
        if ((event.target as HTMLElement).closest('summary')) return
        setOpen(false)
      }}
      className={`text-xs text-ink-soft ${open ? 'cursor-pointer' : ''} ${
        separated ? 'mb-3 border-b border-line pb-2' : ''
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span
          className={`shrink-0 rounded-full ${
            activelyWorking
              ? 'h-2 w-2 animate-pulse bg-sky'
              : stalled
                ? 'h-2 w-2 bg-coral'
                : hasError
                  ? 'h-2 w-2 bg-coral'
                  : 'h-2 w-2 bg-sage'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {activelyWorking
            ? 'Éppen dolgozik'
            : stalled
              ? 'Úgy tűnik megállt'
              : hasError
                ? 'Elakadt egy lépésnél'
                : 'Kész'}
          <span className="ml-1.5 font-normal text-ink-faint">
            · {activities.length} lépés
          </span>
        </span>
        <span className="shrink-0 text-[11px] font-medium text-ink-faint">
          {open ? 'elrejt ▴' : 'részletek ▾'}
        </span>
      </summary>

      {open ? (
        <div className="mt-2 space-y-1.5 border-t border-line/70 pt-2">
          {privacyContext?.mode === 'observe' ? (
            <p className="rounded-md border border-honey/35 bg-honey/10 px-2 py-1 text-[10px] leading-relaxed text-ink-soft">
              Megfigyelés: a sárga kiemelés jelzi, mit cseréltünk volna álnévre. A modell még a
              valódi adatot kapta.
            </p>
          ) : null}
          {activities.map((activity) => (
            <AgentActivityRow
              key={activity.id}
              activity={activity}
              thinking={thinking}
              prominent={activity.status === 'running' && !stalled}
              privacyContext={privacyContext}
            />
          ))}
        </div>
      ) : latest ? (
        <div className="mt-1.5 pl-4">
          <p className="truncate text-[11px] text-ink-faint" title={headerHint}>
            {activityDisplayTitle(latest)}
            {activityLiveThinking(latest, thinking) ? (
              <>
                {' — '}
                <PrivacyObservedText
                  text={activityLiveThinking(latest, thinking)!}
                  privacyContext={privacyContext}
                />
              </>
            ) : latest.detail ? (
              <>
                {' — '}
                <PrivacyObservedText text={latest.detail} privacyContext={privacyContext} />
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </details>
  )
}

/**
 * WP-5 (§6.2 batch-kártya) — egy üzenet összes memória-javaslata egy kártyán,
 * soronként Jóváhagyom/Módosítom/Ticketbe küldöm/Elutasítom gombbal, plusz
 * egy "Jóváhagyom mind" a nyitott (proposed) sorokra. A jogosultsági
 * elágazást (inline vs. ticket) a szerver dönti el — a kártya csak a
 * visszakapott eredményt (jóváhagyva / ticketben / hiba) jeleníti meg.
 */
function MemoryCandidatesPanel({
  candidates,
  onUpdate,
}: {
  candidates: MemoryCandidateCard[]
  onUpdate: (candidateId: string, patch: Partial<MemoryCandidateCard>) => void
}) {
  const [pending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')

  const openCount = candidates.filter((c) => c.status === 'proposed').length

  const runApprove = (candidateId: string) => {
    startTransition(async () => {
      const res = await approveMemoryCandidate({ candidateId })
      if (!res.success) {
        onUpdate(candidateId, { resultMessage: res.error })
        return
      }
      const outcome = (res.data as { outcome?: string }).outcome
      onUpdate(candidateId, {
        status: outcome === 'ticketed' ? 'ticketed' : 'approved',
        resultMessage: undefined,
      })
    })
  }

  const runReject = (candidateId: string) => {
    startTransition(async () => {
      const res = await rejectMemoryCandidate({ candidateId })
      onUpdate(candidateId, {
        status: res.success ? 'rejected' : 'proposed',
        resultMessage: res.success ? undefined : res.error,
      })
    })
  }

  const runTicket = (candidateId: string) => {
    startTransition(async () => {
      const res = await ticketMemoryCandidate({ candidateId })
      onUpdate(candidateId, {
        status: res.success ? 'ticketed' : 'proposed',
        resultMessage: res.success ? undefined : res.error,
      })
    })
  }

  const runModifySave = (candidateId: string) => {
    startTransition(async () => {
      const res = await modifyMemoryCandidate({ candidateId, patch: { summary: editSummary } })
      onUpdate(candidateId, {
        summary: res.success ? editSummary : candidates.find((c) => c.candidateId === candidateId)?.summary ?? null,
        resultMessage: res.success ? undefined : res.error,
      })
      if (res.success) setEditingId(null)
    })
  }

  return (
    <div className="mb-3 rounded-lg border border-line bg-night-2/70 px-3 py-2 text-xs text-ink-soft">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-ink">Memória-javaslat{candidates.length > 1 ? `ok (${candidates.length})` : ''}</span>
        {openCount > 1 && (
          <button
            type="button"
            disabled={pending}
            className="rounded-full bg-sage/20 px-3 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
            onClick={() => candidates.filter((c) => c.status === 'proposed').forEach((c) => runApprove(c.candidateId))}
          >
            Jóváhagyom mind
          </button>
        )}
      </div>
      <div className="space-y-2">
        {candidates.map((c) => (
          <div key={c.candidateId} className="rounded-md border border-line/70 bg-card/40 px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {MEMORY_TYPE_LABELS[c.type ?? ''] ?? c.type ?? c.operation}
              </span>
              <span className="truncate font-medium text-ink">{c.title ?? '(cím nélkül)'}</span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{MEMORY_CANDIDATE_STATUS_LABEL[c.status]}</span>
            </div>
            {c.summary && <p className="mt-1 text-[11px] text-ink-faint">{c.summary}</p>}
            <p className="mt-1 text-[10px] text-ink-faint">
              munka: {memoryProjectKeyLabel(c.projectKey)}
              {c.workstreamKey ? ` / ${c.workstreamKey}` : ''}
            </p>
            {c.resultMessage && <p className="mt-1 text-[11px] text-coral">{c.resultMessage}</p>}
            {c.status === 'proposed' && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sage/20 px-2.5 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
                  onClick={() => runApprove(c.candidateId)}
                >
                  Jóváhagyom
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sky/20 px-2.5 py-1 text-[11px] font-semibold text-sky disabled:opacity-50"
                  onClick={() => {
                    setEditingId(editingId === c.candidateId ? null : c.candidateId)
                    setEditSummary(c.summary ?? '')
                  }}
                >
                  Módosítom
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-honey/20 px-2.5 py-1 text-[11px] font-semibold text-honey disabled:opacity-50"
                  onClick={() => runTicket(c.candidateId)}
                >
                  Ticketbe küldöm
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-coral/20 px-2.5 py-1 text-[11px] font-semibold text-coral disabled:opacity-50"
                  onClick={() => runReject(c.candidateId)}
                >
                  Elutasítom
                </button>
              </div>
            )}
            {editingId === c.candidateId && (
              <div className="mt-2 flex flex-col gap-1.5">
                <textarea
                  className="w-full rounded-lg border border-line bg-night-2 p-2 text-[11px]"
                  rows={3}
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-full bg-sage/20 px-2.5 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
                    onClick={() => runModifySave(c.candidateId)}
                  >
                    Mentés
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-card px-2.5 py-1 text-[11px] font-semibold text-ink-faint"
                    onClick={() => setEditingId(null)}
                  >
                    Mégse
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Server-action / auth / broker hibakód → olvasható visszajelzés a jóváhagyó kártyán.
 *
 * Üzletileg: a jóváhagyás után a művelet a brokeren MÉG elbukhat (nincs connector,
 * lejárt token, tiltott képesség). Nyers `connector_grant_missing` mellett a
 * felhasználó nem tudja, mit tegyen — ezért itt mondjuk meg, hol a hiba.
 */
function formatConsequenceApprovalError(error: string): string {
  switch (error) {
    case 'INSUFFICIENT_ROLE':
      return 'Nincs jogosultságod a jóváhagyáshoz (legalább operátor kell).'
    case 'NO_USER':
      return 'Bejelentkezés szükséges a jóváhagyáshoz.'
    case 'NO_TENANT':
      return 'Nincs aktív szervezet kiválasztva.'
    case 'TENANT_NOT_ACTIVE':
      return 'A szervezet jelenleg nem fogad műveleteket.'
    case 'approval_expired':
      return 'A jóváhagyás lejárt.'
    case 'approval_not_found':
      return 'A jóváhagyás nem található.'
    case 'approval_already_decided':
      return 'Ezt a műveletet már eldöntötték.'
    case 'approval_in_flight':
    case 'approval_retry_in_flight':
      return 'A művelet épp fut — várj egy pillanatot, majd próbáld újra, ha nem zárul le.'
    case 'forbidden':
      return 'Nincs jogosultságod ehhez a művelethez.'
    case 'conversation_not_found':
      return 'A beszélgetés nem található.'
    case 'agent_not_found':
      return 'Az agent nem található.'
    case 'tenant_mismatch':
    case 'tenant_isolation':
      return 'Szervezeti határon át nem hagyható jóvá.'
    case 'approval_rejected':
      return 'Ezt a műveletet korábban elutasították.'
    // A gomb megnyomása után a broker is elutasíthatja a hívást — ilyenkor a
    // döntés megvan, csak a végrehajtás akadt el (konfiguráció / jogosultság).
    case 'capability_not_allowed':
      return 'Az agent nem futtathatja ezt a műveletet (a képesség nincs engedélyezve).'
    case 'connector_grant_missing':
      return 'Hiányzik a szükséges connector-hozzáférés — az adminnak engedélyeznie kell.'
    case 'connector_not_active':
      return 'A szükséges connector jelenleg nem aktív.'
    case 'tool_not_configured':
      return 'A művelethez tartozó eszköz nincs beállítva.'
    case 'provider_auth_error':
      return 'A külső szolgáltató elutasította a hitelesítést (lejárt vagy hibás hozzáférés).'
    // Provider-független scope-hiány; a `gmail_…` alak a Gmail történeti oka.
    case 'connector_scope_not_granted':
    case 'gmail_scope_not_granted':
      return 'A megadott fiók-hozzáférés nem tartalmazza a szükséges jogosultságot.'
    case 'acting_user_required':
      return 'A művelethez a saját felhasználói hozzáférésed kell — jelentkezz be újra.'
    case 'acting_user_suspended':
      return 'A felhasználói hozzáférésed fel van függesztve.'
    case 'approval_stored_malformed_request':
      return (
        'Ez a jóváhagyás hibás API-hívással lett elmentve (pl. üres path), ezért nem futtatható le. ' +
        'Írd meg az agentnek, hogy próbálja újra a helyes végponttal — új kéréshez új gomb jelenik meg.'
      )
    default:
      return error
  }
}

/** Admin-only összecsukható technikai részletek (API útvonal, nyers eredmény). */
function AdminTechnicalDetails({
  isAdmin,
  title = 'Technikai részletek',
  children,
}: {
  isAdmin: boolean
  title?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!isAdmin) return null
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-semibold text-ink-faint underline underline-offset-2 hover:text-ink-soft"
      >
        {open ? 'Részletek elrejtése' : title}
      </button>
      {open && (
        <div className="mt-1 rounded border border-line/70 bg-night-2/40 px-2 py-1.5 font-mono text-[10px] break-all whitespace-pre-wrap text-ink-faint">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * issue #97 — következmény-kapu kártya: külső tartalom után blokkolt mellékhatás
 * (xlsx/file/email/…). Jóváhagyáskor a szerver lefuttatja a toolt, majd a szál
 * FOLYTATÓDIK: a kártya kiírja az eredményt, és egy folytatás-forduló indul, hogy
 * az agent elmondja mi történt és megcsinálja a hátralévő lépéseket. (Korábban a
 * gomb után se válasz, se következő lépés nem jött — a felhasználónak úgy tűnt,
 * hogy semmi nem történik.) A folytatás „tainted"-ként fut, így a következő
 * mellékhatás ismét jóváhagyást kér.
 *
 * Fontos: NEM `useTransition` + server action. React 19 / Next alatt a transition
 * belsejében az `await` utáni setState gyakran nem commitolódik (Brave/mobilon
 * különösen), ezért a „Jóváhagyom” látszólag semmit sem csinál: nincs loading,
 * nincs „Jóváhagyva”, nincs hiba. Explicit busy-állapot + try/catch kell.
 */
function ConsequenceApprovalsPanel({
  approvals,
  onUpdate,
  onApproved,
  isAdmin,
}: {
  approvals: ConsequenceApprovalCard[]
  onUpdate: (approvalId: string, patch: Partial<ConsequenceApprovalCard>) => void
  /** A sikeresen lefuttatott jóváhagyás(ok) — a szál innen folytatódik. */
  onApproved: (approvalIds: string[]) => void
  isAdmin: boolean
}) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const isOpen = (a: ConsequenceApprovalCard) => a.status === 'pending' && !a.expired
  const openCount = approvals.filter(isOpen).length
  const anyBusy = busyIds.size > 0
  const hasExpiredPending = approvals.some((a) => a.status === 'pending' && a.expired)

  const markBusy = (approvalId: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(approvalId)
      else next.delete(approvalId)
      return next
    })
  }

  /**
   * Egy sor jóváhagyása; `true`, ha a művelet le is futott. A busy-jelölés itt
   * történik, hogy a gomb AZONNAL visszajelezzen (a szerver-hívás több másodperc
   * is lehet — enélkül a felhasználó azt hiszi, a kattintás elveszett).
   */
  const approveOne = async (approvalId: string): Promise<boolean> => {
    markBusy(approvalId, true)
    onUpdate(approvalId, { resultMessage: undefined })
    try {
      const res = await approveConsequenceApproval({ approvalId })
      if (!res.success) {
        // A lejárat nem hiba, hanem végállapot: gomb helyett magyarázat járjon hozzá.
        onUpdate(
          approvalId,
          res.error === 'approval_expired'
            ? { expired: true, resultMessage: undefined }
            : { resultMessage: formatConsequenceApprovalError(res.error) },
        )
        return false
      }
      const resultSummary = (res.data as { resultSummary?: string }).resultSummary
      onUpdate(approvalId, {
        status: 'approved',
        resultMessage: undefined,
        ...(resultSummary ? { resultSummary } : {}),
      })
      return true
    } catch (error) {
      // Hálózati/futásidejű hiba sem nyelődhet el: enélkül a gomb „nem csinál
      // semmit”, a felhasználó pedig újra és újra nyomkodja.
      onUpdate(approvalId, {
        resultMessage: formatConsequenceApprovalError(
          error instanceof Error ? error.message : 'A jóváhagyás sikertelen',
        ),
      })
      return false
    } finally {
      markBusy(approvalId, false)
    }
  }

  const runApprove = async (approvalId: string) => {
    if (busyIds.has(approvalId)) return
    if (await approveOne(approvalId)) onApproved([approvalId])
  }

  /**
   * Több nyitott sornál egyetlen folytatás induljon (nem soronként egy) —
   * párhuzamos indítás esetén a második ütközne a már futó fordulóval.
   */
  const runApproveAll = async () => {
    if (anyBusy) return
    const done: string[] = []
    for (const a of approvals.filter(isOpen)) {
      if (await approveOne(a.approvalId)) done.push(a.approvalId)
    }
    if (done.length > 0) onApproved(done)
  }

  const runReject = async (approvalId: string) => {
    if (busyIds.has(approvalId)) return
    markBusy(approvalId, true)
    onUpdate(approvalId, { resultMessage: undefined })
    try {
      const res = await rejectConsequenceApproval({ approvalId })
      onUpdate(approvalId, {
        status: res.success ? 'rejected' : 'pending',
        resultMessage: res.success
          ? undefined
          : formatConsequenceApprovalError(res.error),
      })
    } catch (error) {
      onUpdate(approvalId, {
        resultMessage: formatConsequenceApprovalError(
          error instanceof Error ? error.message : 'Az elutasítás sikertelen',
        ),
      })
    } finally {
      markBusy(approvalId, false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs text-ink-soft">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-ink">
          Jóváhagyásra váró művelet{approvals.length > 1 ? `ek (${approvals.length})` : ''}
        </span>
        {openCount > 1 && (
          <button
            type="button"
            disabled={anyBusy}
            aria-busy={anyBusy}
            className="min-h-10 rounded-full bg-sage/20 px-3 py-2 text-[11px] font-semibold text-sage disabled:opacity-50"
            onClick={() => void runApproveAll()}
          >
            {anyBusy ? 'Jóváhagyás…' : 'Jóváhagyom mind'}
          </button>
        )}
      </div>
      {openCount > 0 && (
        <p className="mb-2 text-[11px] text-ink-faint">
          Ez a művelet kockázatos (kilépő / visszafordíthatatlan / írási HTTP), ezért a platform
          nem futtatta le automatikusan. A gomb lefuttatja, majd az agent folytatja — nem kell
          újraírnod a chatben.
        </p>
      )}
      {openCount === 0 && hasExpiredPending && (
        <p className="mb-2 text-[11px] text-ink-faint">
          Egy vagy több jóváhagyás lejárt — ezek már nem futtathatók. Írd meg az agentnek, hogy
          próbálja újra.
        </p>
      )}
      <div className="space-y-2">
        {approvals.map((a) => {
          const busy = busyIds.has(a.approvalId)
          // A `failedReason` a SZERVERTŐL jön (újratöltés után): a jóváhagyás
          // megvolt, a művelet viszont elbukott. Enélkül a felhasználó egy
          // ártatlan „Jóváhagyásra vár" kártyát látna, hibaüzenet nélkül.
          const errorMessage =
            a.resultMessage ??
            (a.failedReason ? formatConsequenceApprovalError(a.failedReason) : undefined)
          const statusLabel =
            busy && a.status === 'pending'
              ? 'Jóváhagyás folyamatban…'
              : a.status === 'pending'
                ? a.expired
                  ? 'Lejárt'
                  : errorMessage
                    ? 'Nem futott le — újrapróbálható'
                    : 'Jóváhagyásra vár'
                : a.status === 'approved'
                  ? 'Jóváhagyva — lefuttatva'
                  : 'Elutasítva'
          return (
            <div key={a.approvalId} className="rounded-md border border-line/70 bg-card/40 px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={`text-[10px] font-semibold ${
                    a.status === 'approved'
                      ? 'text-sage'
                      : a.status === 'rejected' || a.expired
                        ? 'text-ink-faint'
                        : busy
                          ? 'text-honey'
                          : 'text-ink-faint'
                  }`}
                  aria-live="polite"
                >
                  {statusLabel}
                </span>
              </div>
              <AdminTechnicalDetails isAdmin={isAdmin}>
                <span className="mb-1 block font-sans text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {getToolUiLabel(a.toolName).label}
                </span>
                {a.summary}
                {a.resultSummary ? `\n\nEredmény: ${a.resultSummary}` : ''}
              </AdminTechnicalDetails>
              {errorMessage && (
                <div className="mt-1.5 space-y-1.5">
                  <p className="text-[11px] text-coral" role="alert">
                    {errorMessage}
                  </p>
                  {isOpen(a) && !busy && (
                    <button
                      type="button"
                      className="min-h-10 rounded-full border border-coral/40 bg-card px-3 py-2 text-[11px] font-semibold text-coral"
                      onClick={() => void runApprove(a.approvalId)}
                    >
                      Újrapróbálom
                    </button>
                  )}
                </div>
              )}
              {a.status === 'pending' && a.expired && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  Ez a jóváhagyás lejárt, ezért már nem futtatható le. Írd meg a chatben az agentnek,
                  hogy próbálja újra — az új kéréshez új gomb jelenik meg.
                </p>
              )}
              {a.status === 'approved' && (
                <p className="mt-1 text-[11px] text-sage">
                  {a.resultSummary
                    ? 'A művelet lefutott.'
                    : 'A művelet lefutott. Ha fájlt írt, a Workspace fájlok panelen megjelenik.'}
                </p>
              )}
              {isOpen(a) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy || anyBusy}
                    aria-busy={busy}
                    className="min-h-10 rounded-full bg-sage/20 px-3 py-2 text-[11px] font-semibold text-sage disabled:opacity-50"
                    onClick={() => void runApprove(a.approvalId)}
                  >
                    {busy ? 'Jóváhagyás…' : 'Jóváhagyom'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || anyBusy}
                    className="min-h-10 rounded-full bg-card px-3 py-2 text-[11px] font-semibold text-ink-faint disabled:opacity-50"
                    onClick={() => void runReject(a.approvalId)}
                  >
                    Elutasítom
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

export function MessageBubble({
  message,
  isBusy,
  showAuthor,
  agentName,
  agentAvatarUrl,
  agentStatus,
  personaNickname,
  onDeleteContent,
  onOpenTask,
  onMemoryCandidateUpdate,
  onConsequenceApprovalUpdate,
  onConsequenceApproved,
  grantReturnTo,
  workspaceBaseUrl,
  workspaceFilePaths,
  onOauthRedirect,
  isAdmin,
  privacyContext,
  activityStalled = false,
  activityStallDetail,
  taskCard = null,
  taskCardLoading = false,
  focused = false,
}: {
  message: ChatMessage
  isBusy: boolean
  /** Új szerző kezdi a blokkot: ilyenkor jár avatar + név + időbélyeg. */
  showAuthor: boolean
  agentName: string
  agentAvatarUrl?: string | null
  agentStatus?: string
  personaNickname?: string | null
  onDeleteContent: (messageId: string) => void
  onOpenTask: () => void
  onMemoryCandidateUpdate: (messageId: string, candidateId: string, patch: Partial<MemoryCandidateCard>) => void
  onConsequenceApprovalUpdate: (
    messageId: string,
    approvalId: string,
    patch: Partial<ConsequenceApprovalCard>,
  ) => void
  onConsequenceApproved: (approvalIds: string[]) => void
  grantReturnTo?: { kind: 'conversation'; id: string; agentId: string }
  workspaceBaseUrl?: string
  workspaceFilePaths: string[]
  onOauthRedirect?: () => void
  isAdmin: boolean
  privacyContext: ChatPrivacyMarkerContext | null
  activityStalled?: boolean
  activityStallDetail?: string | null
  taskCard?: ChatTaskCardView | null
  taskCardLoading?: boolean
  focused?: boolean
}) {
  const isUser = message.role === 'user'
  const isDeleted = Boolean(message.contentDeletedAt)
  const [copied, setCopied] = useState(false)
  const time = formatMessageTime(message.createdAt)
  const isApprovalBubble = isUser && !isDeleted && isApprovalContinuationMessage(message.text)
  const approvalDisplayText = isApprovalBubble ? approvalContinuationDisplayText(message.text) : null
  const approvalTechnicalDetails = isApprovalBubble
    ? extractApprovalContinuationTechnicalDetails(message.text)
    : null
  const privacyMarkers = useMemo(() => {
    if (message.privacyMarkers && message.privacyMarkers.length > 0) return message.privacyMarkers
    return buildChatPrivacyMarkers(message.text, privacyContext)
  }, [message.privacyMarkers, message.text, privacyContext])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(true)
    } catch {
      // A vágólap-hozzáférés böngésző- vagy jogosultságfüggő; ilyenkor a chat
      // működése maradjon zavartalan.
    }
  }

  return (
    <div
      id={`message-${message.id}`}
      data-message-id={message.id}
      className={`group/msg flex animate-rise gap-2.5 rounded-2xl ${
        isUser ? 'flex-row-reverse' : 'flex-row'
      } ${showAuthor ? 'mt-4 first:mt-0' : 'mt-1'} ${
        focused ? 'ring-2 ring-coral/40 ring-offset-2 ring-offset-night' : ''
      }`}
    >
      {/* Avatar-oszlop: a blokk első üzeneténél látszik, alatta csak helyet tart,
          hogy a folytatás-buborékok egy vonalban maradjanak. */}
      <div className="w-7 shrink-0 sm:w-8">
        {!isUser && showAuthor ? (
          <AgentAvatar
            name={agentName}
            status={agentStatus}
            size="sm"
            avatarUrl={agentAvatarUrl}
            personaNickname={personaNickname}
          />
        ) : null}
      </div>

      <div className={`flex min-w-0 max-w-[calc(100%-2.25rem)] flex-col sm:max-w-[min(88%,64rem)] ${isUser ? 'items-end' : 'items-start'}`}>
        {showAuthor && (
          <div
            className={`mb-1 flex items-baseline gap-2 px-1 text-[11px] ${
              isUser ? 'flex-row-reverse' : ''
            }`}
          >
            <span className="font-semibold text-ink-soft">{isUser ? 'Te' : agentName}</span>
            {time && <time className="tabular-nums text-ink-faint">{time}</time>}
          </div>
        )}

        <div
          className={`relative w-full rounded-2xl px-3 py-2.5 shadow-sm sm:px-4 sm:py-3 ${
            isDeleted
              ? 'border border-dashed border-line bg-night-2 text-ink-faint'
              : isApprovalBubble
                ? 'rounded-tr-md border border-sage/30 bg-sage/10 text-ink-soft'
                : isUser
                  ? 'rounded-tr-md bg-coral text-card'
                  : 'rounded-tl-md border border-line bg-card text-ink-soft'
          }`}
        >
        {isDeleted ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="h-2 w-10 rounded-full bg-line" aria-hidden />
            <span>Tartalom törölve</span>
          </div>
        ) : (
          <>
            {!isUser && message.activities && message.activities.length > 0 && (
              <AgentActivityPanel
                activities={message.activities}
                thinking={message.thinking}
                separated={Boolean(message.text)}
                privacyContext={privacyContext}
                stalled={activityStalled}
                stallDetail={activityStallDetail}
              />
            )}
            {!isUser && message.memoryCandidates && message.memoryCandidates.length > 0 && (
              <MemoryCandidatesPanel
                candidates={message.memoryCandidates}
                onUpdate={(candidateId, patch) => onMemoryCandidateUpdate(message.id, candidateId, patch)}
              />
            )}
            {message.text &&
              (isApprovalBubble ? (
                <div className="text-sm text-ink-soft">
                  <p>{approvalDisplayText}</p>
                  {approvalTechnicalDetails && (
                    <AdminTechnicalDetails isAdmin={isAdmin} title="API hívás részletei">
                      {approvalTechnicalDetails}
                    </AdminTechnicalDetails>
                  )}
                </div>
              ) : isUser ? (
                <div className="text-sm [&_a]:text-card [&_a]:underline [&_strong]:text-card">
                  <ChatMarkdown
                    content={message.text}
                    variant="user"
                    privacyMarkers={privacyMarkers}
                  />
                </div>
              ) : (
                <ChatMarkdown
                  content={message.text}
                  variant="agent"
                  workspaceBaseUrl={workspaceBaseUrl}
                  workspaceFilePaths={workspaceFilePaths}
                  privacyMarkers={privacyMarkers}
                />
              ))}
            {!isUser && message.consequenceApprovals && message.consequenceApprovals.length > 0 && (
              <ConsequenceApprovalsPanel
                approvals={message.consequenceApprovals}
                onUpdate={(approvalId, patch) =>
                  onConsequenceApprovalUpdate(message.id, approvalId, patch)
                }
                onApproved={onConsequenceApproved}
                isAdmin={isAdmin}
              />
            )}
            {!isUser && message.connectorGrants && message.connectorGrants.length > 0 && (
              <ConnectorGrantNeededPanel
                cards={message.connectorGrants}
                returnTo={grantReturnTo}
                onBeforeRedirect={onOauthRedirect}
              />
            )}
          </>
        )}
        {!isDeleted && message.attachments.length > 0 && (
          <div
            className={`mt-2 flex flex-wrap gap-2 ${message.text ? 'border-t pt-2' : ''} ${
              isUser ? 'border-white/20' : 'border-line'
            }`}
          >
            {message.attachments.map((attachment) =>
              attachment.kind === 'image' && attachment.previewDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={attachment.documentId}
                  src={attachment.previewDataUrl}
                  alt={attachment.filename}
                  className="max-h-40 max-w-full rounded-lg object-cover"
                />
              ) : (
                <span
                  key={attachment.documentId}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                    isUser ? 'bg-card/15 text-card' : 'bg-night-2 text-ink-faint'
                  }`}
                >
                  📎 {attachment.filename}
                </span>
              ),
            )}
          </div>
        )}
        {message.ticketRefId && (
          taskCard ? (
            <ChatTaskCard card={taskCard} onOpen={onOpenTask} />
          ) : taskCardLoading ? (
            <ChatTaskCardSkeleton />
          ) : (
            <Link
              href={`/control-plane/tickets/${message.ticketRefId}`}
              onClick={onOpenTask}
              className={`mt-2 inline-flex text-[11px] font-semibold hover:underline ${
                isUser ? 'text-card' : 'text-coral'
              }`}
            >
              Feladat megnyitása →
            </Link>
          )
        )}
        </div>

        {/* A buborék alatti műveletek ne lógjanak rá a szomszéd üzenetre. */}
        {!isDeleted && message.text && (
          <div className="mt-1 flex h-4 items-center gap-2 px-1">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="text-ink-faint opacity-70 transition-opacity hover:text-coral-deep hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40"
              title={copied ? 'Üzenet a vágólapra másolva' : 'Üzenet másolása'}
              aria-label={copied ? 'Üzenet a vágólapra másolva' : 'Üzenet másolása'}
            >
              {copied ? (
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="m3.25 8.25 3 3 6.5-6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <rect
                    x="5.25"
                    y="5.25"
                    width="7.5"
                    height="7.5"
                    rx="1.25"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                  />
                  <path
                    d="M10.75 5.25V3.5A1.25 1.25 0 0 0 9.5 2.25H4A1.25 1.25 0 0 0 2.75 3.5V9A1.25 1.25 0 0 0 4 10.25h1.25"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.25"
                  />
                </svg>
              )}
            </button>

            {/* A törlés csak mentett üzeneteken érhető el. */}
            {!message.id.startsWith('optimistic-') && (
              <button
                type="button"
                onClick={() => onDeleteContent(message.id)}
                disabled={isBusy}
                className="text-ink-faint opacity-0 transition-opacity hover:text-coral-deep focus:opacity-100 group-hover/msg:opacity-100 disabled:opacity-40"
                title="Az üzenet szövegének végleges törlése"
                aria-label="Az üzenet szövegének végleges törlése"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
