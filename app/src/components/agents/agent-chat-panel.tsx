'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  approveConsequenceApproval,
  approveMemoryCandidate,
  archiveConversation,
  createAgentTaskTicket,
  createScheduledAgentTask,
  deleteMessageContent,
  listAgentChatSessions,
  loadAgentChatMessages,
  modifyMemoryCandidate,
  promoteConversationWithAi,
  rejectConsequenceApproval,
  rejectMemoryCandidate,
  ticketMemoryCandidate,
  uploadDocument,
} from '@/app/actions/platform'
import { distillSkillFromConversationAction, getAgentSkillsAction } from '@/app/actions/skills'
import { exportConversationDebugLog } from '@/app/actions/debug-log'
import { listChatTriggerableProcessDefinitions } from '@/app/actions/process'
import { listAgentDelegatedConnectors } from '@/app/actions/connector-grants'
import { ConnectorGrantNeededPanel } from '@/components/connectors/connector-grant-needed-panel'
import type { ConnectorGrantNeededView } from '@/components/connectors/connector-grant-needed-panel'
import { getTenantThinkingTraceControls } from '@/app/actions/chat-thinking-trace'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import type { AgentDelegatedConnectorRow } from '@/lib/agent-delegated-connectors'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import {
  removeAgentChatDockEntry,
  upsertAgentChatDockEntry,
} from '@/components/agents/agent-chat-dock-store'
import {
  clearAgentChatResumeAfterGrant,
  openAgentChat,
} from '@/components/agents/agent-chat-session-store'
import { ChatMarkdown, TypingIndicator } from '@/components/chat/chat-markdown'
import {
  chatMessageShowsAgentActivity,
  mergeTurnProgressIntoMessages,
  type ChatTurnActivity,
} from '@/lib/chat-turn-progress'
import { AGENT_TURN_RECONNECT_POLL_DEFAULT_MS } from '@/domain/agent/agent-turn-reconnect'
import {
  decideChatStreamRecovery,
  resolveChatStreamConflict,
  STREAM_RECOVERED_MESSAGE,
  STREAM_RECOVERY_FAILED_MESSAGE,
  type ChatStreamEnding,
} from '@/lib/chat-stream-recovery'
import {
  AgentChatSessionSidebar,
  type ChatSession,
  type ChatSessionStatusFilter,
} from '@/components/chat/chat-session-sidebar'
import {
  ConversationFilesPanel,
  type ConversationFilesPanelHandle,
} from '@/components/chat/conversation-files-panel'
import { personaFor } from '@/lib/agent-persona'
import {
  appendThinkingDelta,
  canStartThinkingTraceStream,
  type ThinkingTraceControlState,
} from '@/lib/chat-thinking-trace'
import { skillNameToSlashToken } from '@/lib/skill/skill-slash-command'
import {
  SkillSlashMenu,
  useSkillSlashAutocomplete,
} from '@/components/skills/skill-slash-autocomplete'
import { getToolUiLabel } from '@/lib/tool-ui-labels'

type PendingAttachment = {
  id: string
  file: File
  previewUrl: string | null
  kind: 'text' | 'image'
}

type ChatMessage = {
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
  /**
   * Chat "thinking-trace" spec §6 — élő, streamelt reasoning-szöveg körönként
   * (turnId → felhalmozott szöveg). Csak a folyamat alatti megjelenítésre; nem
   * perzisztált (D4). A körhöz tartozó reasoning-activity lezárásakor a szerver
   * összefoglaló `detail`-je veszi át a helyét.
   */
  thinking?: Record<string, string>
}

/** Spec §8.3 — optimista/reconnect buborék azonosító a fordulóhoz kötve. */
function agentBubbleIdForTurn(turnId: string): string {
  return `turn-agent-${turnId}`
}

type ScheduledTaskRecurrence = 'none' | 'daily' | 'weekly' | 'monthly'

type ChatProcessDefinition = {
  id: string
  name: string
  description: string | null
  slots: Array<{ name: string; type: string; required: boolean; description?: string }>
}

type AgentActivity = {
  id: string
  kind: 'reasoning' | 'tool'
  title: string
  detail?: string
  status: 'running' | 'done' | 'error' | 'skipped'
  archivePath?: string
}

/**
 * WP-5 (agent-memory-persistent-cross-conversation-spec.md §6.2) — az agent
 * `memory_propose` hívása után a chat-streambe kerülő batch-kártya egy sora.
 * A `status`/`resultMessage` kliens-oldali, a jóváhagyási gombok eredményét
 * tükrözi (a szerver a forrás-igazság, ez csak a kártya azonnali visszajelzése).
 */
type MemoryCandidateCard = {
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

/** issue #97 — következmény-kapu pending mellékhatás a chat-kártyán. */
type ConsequenceApprovalCard = {
  approvalId: string
  toolName: string
  summary: string
  expiresAt: string
  status: 'pending' | 'approved' | 'rejected'
  /** A SZERVER órája szerint lejárt-e — a kliens órájára ezt nem bízzuk. */
  expired?: boolean
  resultMessage?: string
  /** Mi lett a lefuttatott művelet eredménye — enélkül a gomb „némán" tűnik el. */
  resultSummary?: string
  /**
   * A SZERVERTŐL jövő korábbi hiba: a jóváhagyás megvolt, de a tool-hívás
   * elbukott. Újratöltés után ebből tudjuk, hogy „Újrapróbálom" kell.
   */
  failedReason?: string
}

type AgentChatStreamEvent =
  /**
   * A stream legelső eseménye: a szerveren futó forduló azonosítója. A Stop és a
   * visszacsatlakozás ehhez kötődik.
   */
  | { type: 'turn'; turnId: string }
  | {
      type: 'snapshot'
      turnId: string
      status: string
      partialText: string
      activities: unknown
      conversationId: string
      userMessageId: string | null
    }
  | { type: 'meta'; conversationId: string; userMessageId: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'memory_candidate'; candidate: Omit<MemoryCandidateCard, 'status' | 'resultMessage'> }
  | {
      type: 'consequence_approval'
      approval: Omit<ConsequenceApprovalCard, 'status' | 'resultMessage'>
    }
  | {
      type: 'connector_grant_needed'
      grant: ConnectorGrantNeededView
    }
  | { type: 'thinking'; turnId: string; delta: string }
  | { type: 'token'; chunk: string }
  | {
      type: 'done'
      conversationId: string
      messageId: string
      ticketRefId?: string | null
      reason?: 'cancelled'
    }
  | { type: 'error'; message?: string }

const CHAT_SESSIONS_PAGE_SIZE = 10

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function makePendingAttachment(file: File): PendingAttachment {
  const kind = isImageFile(file) ? 'image' : 'text'
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file,
    kind,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
  }
}

async function uploadAttachments(files: PendingAttachment[]): Promise<string[]> {
  const ids: string[] = []
  for (const attachment of files) {
    const fd = new FormData()
    fd.set('file', attachment.file)
    const res = await uploadDocument(fd)
    if (!res.success) throw new Error(res.error)
    ids.push(res.data.id)
  }
  return ids
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

function upsertActivity(activities: AgentActivity[] | undefined, next: AgentActivity): AgentActivity[] {
  const current = activities ?? []
  const index = current.findIndex((activity) => activity.id === next.id)
  if (index < 0) return [...current, next]
  return current.map((activity, i) => (i === index ? { ...activity, ...next } : activity))
}

function upsertMemoryCandidate(
  candidates: MemoryCandidateCard[] | undefined,
  next: MemoryCandidateCard,
): MemoryCandidateCard[] {
  const current = candidates ?? []
  const index = current.findIndex((c) => c.candidateId === next.candidateId)
  if (index < 0) return [...current, next]
  return current.map((c, i) => (i === index ? { ...c, ...next } : c))
}

function upsertConsequenceApproval(
  approvals: ConsequenceApprovalCard[] | undefined,
  next: ConsequenceApprovalCard,
): ConsequenceApprovalCard[] {
  const current = approvals ?? []
  const index = current.findIndex((a) => a.approvalId === next.approvalId)
  if (index < 0) return [...current, next]
  return current.map((a, i) => (i === index ? { ...a, ...next } : a))
}

/**
 * issue #97 — a DB-ből visszatöltött üzenetekre visszaakasztja a még FÜGGŐ
 * jóváhagyásokat.
 *
 * A kapu az utolsó agent-buborékhoz tartozik: az agent ott mondja el, mire vár.
 * Enélkül a forduló végén (a chat a DB végállapotát tölti újra) eltűnne a
 * „Jóváhagyom" gomb, és a művelet némán lejárna.
 */
function attachPendingConsequenceApprovals(
  messages: ChatMessage[],
  pending: ConsequenceApprovalCard[] | undefined,
): ChatMessage[] {
  if (!pending || pending.length === 0) return messages
  let anchorIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') {
      anchorIndex = i
      break
    }
  }
  // Ha (még) nincs agent-üzenet, az utolsó buborékra tesszük — a gomb sosem
  // veszhet el csak azért, mert a szál elején tartunk.
  if (anchorIndex < 0) anchorIndex = messages.length - 1
  if (anchorIndex < 0) return messages
  return messages.map((m, i) =>
    i === anchorIndex ? { ...m, consequenceApprovals: pending } : m,
  )
}

function attachPendingConnectorGrants(
  messages: ChatMessage[],
  pending: ConnectorGrantNeededView[] | undefined,
): ChatMessage[] {
  if (!pending || pending.length === 0) return messages
  let anchorIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') {
      anchorIndex = i
      break
    }
  }
  if (anchorIndex < 0) anchorIndex = messages.length - 1
  if (anchorIndex < 0) return messages
  return messages.map((m, i) => (i === anchorIndex ? { ...m, connectorGrants: pending } : m))
}

function upsertConnectorGrant(
  cards: ConnectorGrantNeededView[] | undefined,
  next: ConnectorGrantNeededView,
): ConnectorGrantNeededView[] {
  const current = cards ?? []
  const index = current.findIndex(
    (card) => card.connectorId === next.connectorId && card.reason === next.reason,
  )
  if (index < 0) return [...current, next]
  return current.map((card, i) => (i === index ? { ...card, ...next } : card))
}

function withPendingChatExtras(
  messages: ChatMessage[],
  pendingApprovals: ConsequenceApprovalCard[] | undefined,
  pendingGrants: ConnectorGrantNeededView[] | undefined,
): ChatMessage[] {
  return attachPendingConnectorGrants(
    attachPendingConsequenceApprovals(messages, pendingApprovals),
    pendingGrants,
  )
}

function stripGrantedQueryFromUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('granted')) return
  url.searchParams.delete('granted')
  const search = url.searchParams.toString()
  window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`)
}

const MEMORY_CANDIDATE_TYPE_LABEL: Record<string, string> = {
  focus: 'Fókusz',
  decision: 'Döntés',
  open_task: 'Nyitott feladat',
  assumption: 'Feltételezés',
  finding: 'Feltárás',
  constraint: 'Megkötés',
  artifact: 'Artifact',
  failed_attempt: 'Sikertelen próbálkozás',
  handoff_summary: 'Átadás-összefoglaló',
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
function ChatHeaderMenu({
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
            className="absolute right-0 z-40 mt-1.5 w-64 overflow-hidden rounded-xl border border-line bg-card p-1 shadow-xl"
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}

function ChatMenuItem({
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

function AgentActivityRow({
  activity,
  thinking,
  prominent = false,
}: {
  activity: AgentActivity
  thinking?: Record<string, string>
  /** Collapsed preview of the running step — stronger motion + wash. */
  prominent?: boolean
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
            {liveThinking}
          </p>
        ) : (
          (activity.detail || activity.archivePath) && (
            <p
              className={`truncate text-[11px] text-ink-faint ${
                activity.kind === 'reasoning' ? 'italic' : ''
              }`}
              title={activity.archivePath ?? activity.detail}
            >
              {activity.detail}
              {activity.archivePath ? ` · ${activity.archivePath}` : ''}
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
}: {
  activities: AgentActivity[]
  thinking?: Record<string, string>
  /** Követi-e válaszszöveg — csak akkor kell elválasztó vonal. */
  separated: boolean
}) {
  // Alapból zárt — a teljes lista csak kattintásra nyílik; stream közben sem
  // erőltetjük ki a nyitást, hogy a user választása megmaradjon.
  const [open, setOpen] = useState(false)
  const running = activities.find((activity) => activity.status === 'running')
  const latest = running ?? activities[activities.length - 1]
  const hasError = activities.some((activity) => activity.status === 'error')
  const headerHint = running
    ? `${activityDisplayTitle(running)} fut`
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
      className={`text-xs text-ink-soft ${
        separated ? 'mb-3 border-b border-line pb-2' : ''
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span
          className={`shrink-0 rounded-full ${
            running
              ? 'h-2 w-2 animate-pulse bg-sky'
              : hasError
                ? 'h-2 w-2 bg-coral'
                : 'h-2 w-2 bg-sage'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {running ? 'Éppen dolgozik' : hasError ? 'Elakadt egy lépésnél' : 'Kész'}
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
          {activities.map((activity) => (
            <AgentActivityRow
              key={activity.id}
              activity={activity}
              thinking={thinking}
              prominent={activity.status === 'running'}
            />
          ))}
        </div>
      ) : latest ? (
        <div className="mt-1.5 pl-4">
          <p className="truncate text-[11px] text-ink-faint" title={headerHint}>
            {activityDisplayTitle(latest)}
            {activityLiveThinking(latest, thinking)
              ? ` — ${activityLiveThinking(latest, thinking)}`
              : latest.detail
                ? ` — ${latest.detail}`
                : ''}
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
                {MEMORY_CANDIDATE_TYPE_LABEL[c.type ?? ''] ?? c.type ?? c.operation}
              </span>
              <span className="truncate font-medium text-ink">{c.title ?? '(cím nélkül)'}</span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{MEMORY_CANDIDATE_STATUS_LABEL[c.status]}</span>
            </div>
            {c.summary && <p className="mt-1 text-[11px] text-ink-faint">{c.summary}</p>}
            <p className="mt-1 text-[10px] text-ink-faint">
              scope: {c.projectKey}
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
    case 'gmail_scope_not_granted':
      return 'A Gmail hozzáférés nem tartalmazza a szükséges jogosultságot.'
    case 'acting_user_required':
      return 'A művelethez a saját felhasználói hozzáférésed kell — jelentkezz be újra.'
    case 'acting_user_suspended':
      return 'A felhasználói hozzáférésed fel van függesztve.'
    default:
      return error
  }
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
}: {
  approvals: ConsequenceApprovalCard[]
  onUpdate: (approvalId: string, patch: Partial<ConsequenceApprovalCard>) => void
  /** A sikeresen lefuttatott jóváhagyás(ok) — a szál innen folytatódik. */
  onApproved: (approvalIds: string[]) => void
}) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const isOpen = (a: ConsequenceApprovalCard) => a.status === 'pending' && !a.expired
  const openCount = approvals.filter(isOpen).length
  const anyBusy = busyIds.size > 0

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
      <p className="mb-2 text-[11px] text-ink-faint">
        {openCount > 0
          ? 'Ez a művelet kockázatos (kilépő / visszafordíthatatlan / írási HTTP), ezért a platform nem futtatta le automatikusan. A gomb lefuttatja, majd az agent folytatja — nem kell újraírnod a chatben.'
          : 'Ez a művelet kockázatos volt, és a jóváhagyási idő letelt.'}
      </p>
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
                <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {getToolUiLabel(a.toolName).label}
                </span>
                <span className="font-medium text-ink">{a.summary}</span>
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
              {a.status === 'approved' &&
                (a.resultSummary ? (
                  <p className="mt-1 break-all text-[11px] text-ink-faint">
                    Eredmény: {a.resultSummary}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-sage">
                    A művelet lefutott. Ha fájlt írt, a Workspace fájlok panelen megjelenik.
                  </p>
                ))}
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

function MessageBubble({
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
}) {
  const isUser = message.role === 'user'
  const isDeleted = Boolean(message.contentDeletedAt)
  const time = formatMessageTime(message.createdAt)

  return (
    <div
      className={`group/msg flex animate-rise gap-2.5 ${
        isUser ? 'flex-row-reverse' : 'flex-row'
      } ${showAuthor ? 'mt-4 first:mt-0' : 'mt-1'}`}
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

      <div className={`flex min-w-0 flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[min(88%,64rem)]`}>
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
          className={`relative w-full rounded-2xl px-4 py-3 shadow-sm ${
            isDeleted
              ? 'border border-dashed border-line bg-night-2 text-ink-faint'
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
              />
            )}
            {!isUser && message.memoryCandidates && message.memoryCandidates.length > 0 && (
              <MemoryCandidatesPanel
                candidates={message.memoryCandidates}
                onUpdate={(candidateId, patch) => onMemoryCandidateUpdate(message.id, candidateId, patch)}
              />
            )}
            {message.text &&
              (isUser ? (
                <div className="text-sm [&_a]:text-card [&_a]:underline [&_strong]:text-card">
                  <ChatMarkdown content={message.text} variant="user" />
                </div>
              ) : (
                <ChatMarkdown
                  content={message.text}
                  variant="agent"
                  workspaceBaseUrl={workspaceBaseUrl}
                  workspaceFilePaths={workspaceFilePaths}
                />
              ))}
            {/*
              A jóváhagyó kártya a SZÖVEG UTÁN áll: az agent a válasza végén mondja
              el, hogy gombra vár — ha a kártya a hosszú szöveg fölött lenne, a
              felhasználó pont ott nem látná, ahol keresi.
            */}
            {!isUser && message.consequenceApprovals && message.consequenceApprovals.length > 0 && (
              <ConsequenceApprovalsPanel
                approvals={message.consequenceApprovals}
                onUpdate={(approvalId, patch) =>
                  onConsequenceApprovalUpdate(message.id, approvalId, patch)
                }
                onApproved={onConsequenceApproved}
              />
            )}
            {!isUser && message.connectorGrants && message.connectorGrants.length > 0 && (
              <ConnectorGrantNeededPanel cards={message.connectorGrants} returnTo={grantReturnTo} />
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
          <Link
            href={`/control-plane/tickets/${message.ticketRefId}`}
            onClick={onOpenTask}
            className={`mt-2 inline-flex text-[11px] font-semibold hover:underline ${
              isUser ? 'text-card' : 'text-coral'
            }`}
          >
            {message.text.includes('Futás elindítva a(z)')
              ? 'Belépő feladat megnyitása →'
              : 'Feladat megnyitása →'}
          </Link>
        )}
        </div>

        {/* A törlés a buborék ALATT ül: korábban rálógott a szomszéd üzenetre és
            eltakarta a szöveg elejét. */}
        {!isDeleted && !message.id.startsWith('optimistic-') && (
          <div className="mt-1 h-4 px-1">
            <button
              type="button"
              onClick={() => onDeleteContent(message.id)}
              disabled={isBusy}
              className="text-[10px] font-semibold text-ink-faint opacity-0 transition-opacity hover:text-coral-deep focus:opacity-100 group-hover/msg:opacity-100 disabled:opacity-40"
              title="Az üzenet szövegének végleges törlése"
            >
              Tartalom törlése
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export type ChatSkillOption = {
  skillId: string
  skillVersionId: string
  name: string
  description: string
  /** #199 — enged-e a skill fájlcsatolást. Chatben CSAK figyelmeztetés (D6). */
  allowAttachments: boolean
}

type ChatAgent = {
  id: string
  name: string
  status?: string
  avatarUrl?: string | null
  personaNickname?: string | null
  personaGreeting?: string | null
  personaTrait?: string | null
}

export function AgentChatPanel({
  agent,
  open,
  onClose,
  canDistillSkill = false,
  initialConversationId = null,
  resumeAfterGrant = false,
  restoreSignal = 0,
  tileTarget = null,
}: {
  agent: ChatAgent
  open: boolean
  onClose: () => void
  /** Admin: D14 skill-desztilláció a beszélgetésből (skill-catalog-spec §WP-6). */
  canDistillSkill?: boolean
  /** Deep-link / Aktív futások: nyitáskor ezt a beszélgetést tölti be + reattach. */
  initialConversationId?: string | null
  /** OAuth-grant után a szerveroldali folytatás-forduló. */
  resumeAfterGrant?: boolean
  /** Növekvő jel: újboli megnyitáskor leveszi a tálcáról. */
  restoreSignal?: number
  /** A közös session-host célpontja: itt a megnyitott panelek reszponzív rácsba kerülnek. */
  tileTarget?: HTMLElement | null
}) {
  const persona = personaFor(agent.name, agent)
  const dockId = useId()
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [workspaceFilePaths, setWorkspaceFilePaths] = useState<string[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [lastTicketId, setLastTicketId] = useState<string | null>(null)
  const [ticketExecuteAfter, setTicketExecuteAfter] = useState('')
  const [ticketRecurrence, setTicketRecurrence] = useState<ScheduledTaskRecurrence>('none')
  const [ticketMaxRuns, setTicketMaxRuns] = useState('')
  const [ticketAuthorizeRunAs, setTicketAuthorizeRunAs] = useState(false)
  const [isAgentTyping, setIsAgentTyping] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [runningConversationIds, setRunningConversationIds] = useState<string[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false)
  const [sessionsHasMore, setSessionsHasMore] = useState(false)
  const [sessionsNextOffset, setSessionsNextOffset] = useState(0)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionsFilter, setSessionsFilter] = useState<ChatSessionStatusFilter>('active')
  const [conversationStatus, setConversationStatus] = useState<'active' | 'archived'>('active')
  /** Ticket → Megbeszélés (#219): forrás feladat a chat fejlécében. */
  const [continuedFromTicket, setContinuedFromTicket] = useState<{
    id: string
    title: string
  } | null>(null)
  /** Ticket-szál olvasható előzménye a megbeszélés chatben (nem Message rekord). */
  const [ticketDiscussionHistory, setTicketDiscussionHistory] = useState<
    Array<{
      id: string
      role: 'user' | 'agent' | 'system'
      text: string
      authorLabel: string
      createdAt: string
    }>
  >([])
  const [chatProcessDefs, setChatProcessDefs] = useState<ChatProcessDefinition[]>([])
  const [selectedProcessDefId, setSelectedProcessDefId] = useState<string | null>(null)
  /**
   * Mi legyen az üzenetből: válasz most (chat) vagy feladat a táblán (task).
   * Korábban ez implicit volt — két egyenrangú gomb állt egymás mellett, és a
   * feladat-specifikus mezők (ütemezés, run-as) akkor is látszottak, amikor
   * sima beszélgetés folyt.
   */
  const [composerMode, setComposerMode] = useState<'chat' | 'task'>('chat')
  const [composerPanel, setComposerPanel] = useState<'skill' | 'process' | null>(null)
  const [pending, startTransition] = useTransition()
  const [ticketPending, startTicketTransition] = useTransition()
  const [archivePending, startArchiveTransition] = useTransition()
  const [distillPending, startDistillTransition] = useTransition()
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [distillTargetSkillId, setDistillTargetSkillId] = useState<string>('')
  const [distillTargets, setDistillTargets] = useState<Array<{ id: string; name: string }>>([])
  const [agentSkills, setAgentSkills] = useState<ChatSkillOption[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filesRef = useRef<ConversationFilesPanelHandle>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamConversationIdRef = useRef<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  /**
   * Ha a user a futó forduló közben nyomja a „Jóváhagyom”-ot, a tool a szerveren
   * már lefut, de a folytatás-forduló nem indítható (`isAgentTyping`). Ilyenkor
   * ide kerülnek az approval-id-k; a gépelés végeztével automatikusan elindul
   * a folytatás (különben a gomb eltűnik, Excel/munkafájl soha nem készül el).
   */
  const pendingConsequenceContinuationRef = useRef<string[] | null>(null)
  const grantResumeStartedRef = useRef(false)
  const startAgentTurnRef = useRef<
    | ((options: {
        text: string
        attachments: PendingAttachment[]
        userBubbleText?: string
        consequenceApprovalIds?: string[]
        connectorGrantContinuation?: boolean
      }) => void)
    | null
  >(null)
  const [mounted, setMounted] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const handleMinimize = useCallback(() => setMinimized(true), [])
  const [connectableUserConnectors, setConnectableUserConnectors] = useState<
    AgentDelegatedConnectorRow[]
  >([])
  const [connectableUserConnectorsLoading, setConnectableUserConnectorsLoading] = useState(false)
  const [thinkingTraceControls, setThinkingTraceControls] =
    useState<ThinkingTraceControlState>('loading')

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    // Bezáráskor a következő nyitás ne tálcán induljon.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setMinimized(false)
  }, [open])

  useEffect(() => {
    if (restoreSignal <= 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinimized(false)
  }, [restoreSignal])

  useEffect(() => {
    if (!open || !minimized) {
      removeAgentChatDockEntry(dockId)
      return
    }
    upsertAgentChatDockEntry({
      id: dockId,
      agentName: agent.name,
      agentStatus: agent.status,
      avatarUrl: agent.avatarUrl,
      personaNickname: agent.personaNickname,
      displayName: persona.nickname,
      isTyping: isAgentTyping,
      onRestore: () => setMinimized(false),
      onClose,
    })
  }, [
    open,
    minimized,
    dockId,
    agent.name,
    agent.status,
    agent.avatarUrl,
    agent.personaNickname,
    persona.nickname,
    isAgentTyping,
    onClose,
  ])

  useEffect(() => {
    return () => removeAgentChatDockEntry(dockId)
  }, [dockId])

  // Tool-körök alatt a POST SSE gyakran csak `activity` eseményeket küld; ha a
  // proxy/runtime buffereli a streamet, a buborék üres + „…” marad, miközben a
  // DB-ben már ott van az aktivitás. Periodikus active-turn poll zárja a rést.
  useEffect(() => {
    if (!isAgentTyping || !conversationId || !activeTurnId) return
    let cancelled = false

    const pullProgress = async () => {
      try {
        const res = await fetch(
          `/api/v1/agent-chat/turns?conversationId=${encodeURIComponent(conversationId)}&active=1`,
        )
        if (!res.ok || cancelled) return
        const data = (await res.json()) as {
          active: boolean
          turn: {
            id: string
            partialText?: string
            activities?: unknown
          } | null
        }
        if (!data.active || !data.turn || cancelled) return
        const activities = Array.isArray(data.turn.activities)
          ? (data.turn.activities as ChatTurnActivity[])
          : []
        const partialText = data.turn.partialText ?? ''
        if (activities.length === 0 && !partialText) return
        const agentMessageId = agentBubbleIdForTurn(data.turn.id)
        flushSync(() => {
          setMessages((prev) =>
            mergeTurnProgressIntoMessages(prev, {
              agentMessageId,
              activities,
              partialText,
            }),
          )
        })
      } catch {
        // Hálózati / abort hiba: a következő tick újrapróbál.
      }
    }

    void pullProgress()
    const timer = window.setInterval(() => void pullProgress(), AGENT_TURN_RECONNECT_POLL_DEFAULT_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isAgentTyping, conversationId, activeTurnId])

  const markConversationRunning = useCallback((convId: string | null, running: boolean) => {
    if (!convId) return
    setRunningConversationIds((prev) => {
      if (running) return prev.includes(convId) ? prev : [...prev, convId]
      return prev.filter((id) => id !== convId)
    })
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!open) streamAbortRef.current?.abort()
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      setConnectableUserConnectorsLoading(true)
      try {
        const res = await listAgentDelegatedConnectors(agent.id)
        if (cancelled) return
        setConnectableUserConnectors(res.success ? res.data : [])
      } finally {
        if (!cancelled) setConnectableUserConnectorsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, agent.id])

  useEffect(() => {
    let cancelled = false
    void getTenantThinkingTraceControls().then((res) => {
      if (cancelled) return
      setThinkingTraceControls(res.success && res.data.enabled === true ? 'enabled' : 'disabled')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const res = await listAgentChatSessions({
        agentId: agent.id,
        status: sessionsFilter,
        limit: CHAT_SESSIONS_PAGE_SIZE,
        offset: 0,
      })
      if (res.success) {
        setSessions(res.data.sessions)
        setSessionsHasMore(res.data.hasMore)
        setSessionsNextOffset(res.data.nextOffset)
      }
    } finally {
      setSessionsLoading(false)
    }
  }, [agent.id, sessionsFilter])

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoading || sessionsLoadingMore || !sessionsHasMore) return
    setSessionsLoadingMore(true)
    try {
      const res = await listAgentChatSessions({
        agentId: agent.id,
        status: sessionsFilter,
        limit: CHAT_SESSIONS_PAGE_SIZE,
        offset: sessionsNextOffset,
      })
      if (res.success) {
        setSessions((prev) => {
          const merged = [...prev]
          for (const session of res.data.sessions) {
            if (!merged.some((existing) => existing.id === session.id)) merged.push(session)
          }
          return merged
        })
        setSessionsHasMore(res.data.hasMore)
        setSessionsNextOffset(res.data.nextOffset)
      }
    } finally {
      setSessionsLoadingMore(false)
    }
  }, [agent.id, sessionsFilter, sessionsHasMore, sessionsLoading, sessionsLoadingMore, sessionsNextOffset])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refreshSessions(), 0)
    return () => window.clearTimeout(timer)
  }, [open, refreshSessions])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const res = await listChatTriggerableProcessDefinitions({ agentId: agent.id })
      if (res.success) setChatProcessDefs(res.data as ChatProcessDefinition[])
    })()
  }, [open, agent.id])

  const startNewSession = useCallback(() => {
    if (isAgentTyping) return
    pendingConsequenceContinuationRef.current = null
    setConversationId(null)
    setMessages([])
    setStatusMessage(null)
    setLastTicketId(null)
    setContinuedFromTicket(null)
    setTicketDiscussionHistory([])
    setConversationStatus('active')
    setSessionsFilter('active')
    setSessionsOpen(false)
    setSelectedProcessDefId(null)
  }, [isAgentTyping])

  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  useEffect(() => {
    scrollToBottom()
  }, [messages, isAgentTyping, scrollToBottom])

  useEffect(() => {
    return () => {
      pendingAttachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      })
    }
  }, [pendingAttachments])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !open || minimized) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, minimized, onClose])

  const resetComposer = () => {
    setInput('')
    setTicketExecuteAfter('')
    setTicketRecurrence('none')
    setTicketMaxRuns('')
    setTicketAuthorizeRunAs(false)
    pendingAttachments.forEach((a) => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    })
    setPendingAttachments([])
  }

  const handleFilesSelected = (files: FileList | null) => {
    if (!files?.length) return
    const next = Array.from(files).map(makePendingAttachment)
    setPendingAttachments((prev) => [...prev, ...next])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  const canSubmit =
    conversationStatus !== 'archived' &&
    (input.trim().length > 0 || pendingAttachments.length > 0) &&
    !pending &&
    !ticketPending &&
    !isAgentTyping &&
    canStartThinkingTraceStream(thinkingTraceControls)
  const controlsBusy =
    pending || ticketPending || archivePending || distillPending || debugLogPending || isAgentTyping

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getAgentSkillsAction(agent.id).then((res) => {
      if (cancelled || !res.success) return
      const enabledBySkill = new Map<string, ChatSkillOption>()
      const distillBySkill = new Map<string, { id: string; name: string }>()
      for (const row of res.data) {
        if (!distillBySkill.has(row.skillId)) {
          distillBySkill.set(row.skillId, { id: row.skillId, name: row.name })
        }
        if (row.enabled && !enabledBySkill.has(row.skillId)) {
          enabledBySkill.set(row.skillId, {
            skillId: row.skillId,
            skillVersionId: row.skillVersionId,
            name: row.name,
            description: row.description,
            allowAttachments: row.allowAttachments,
          })
        }
      }
      setAgentSkills([...enabledBySkill.values()])
      if (canDistillSkill) {
        setDistillTargets([...distillBySkill.values()])
      }
    })
    return () => {
      cancelled = true
    }
  }, [agent.id, canDistillSkill, open])

  // #199/D6 — chatben a csatolmány-tiltás CSAK figyelmeztetés: a küldést nem
  // törjük meg. A kemény kapu ott van, ahol a skillt explicit kiválasztják
  // (korlátozott feladat + normál board-feladat); a chat szabad beszélgetés,
  // ahol a felhasználó a csatolmányt más célra is szánhatja.
  const attachmentWarningSkills = useMemo(() => {
    if (pendingAttachments.length === 0) return []
    const tokens = new Set<string>()
    for (const match of input.matchAll(/(?:^|\s)\/([a-zA-Z0-9_-]+)/g)) {
      tokens.add(match[1].toLowerCase())
    }
    if (tokens.size === 0) return []
    return agentSkills
      .filter((skill) => !skill.allowAttachments && tokens.has(skillNameToSlashToken(skill.name)))
      .map((skill) => skill.name)
  }, [agentSkills, input, pendingAttachments.length])

  const composerDisabled = controlsBusy || conversationStatus === 'archived'
  // A `/` menü viselkedése közös a Playbook-szerző prompttal (`skill-slash-autocomplete`),
  // hogy a két felület ne tudjon szétcsúszni.
  const slash = useSkillSlashAutocomplete({
    skills: agentSkills,
    value: input,
    onChange: setInput,
    inputRef: textareaRef,
    disabled: composerDisabled,
  })

  /**
   * Módváltáskor a feladat-specifikus beállítások nem maradhatnak élve
   * láthatatlanul: a rejtett ütemezés a küldés jelentését változtatná meg.
   */
  const switchComposerMode = useCallback((next: 'chat' | 'task') => {
    setComposerMode(next)
    setComposerPanel(null)
    if (next === 'chat') {
      setTicketExecuteAfter('')
      setTicketRecurrence('none')
      setTicketMaxRuns('')
      setTicketAuthorizeRunAs(false)
    }
  }, [])

  const selectedProcessDef = useMemo(
    () => chatProcessDefs.find((def) => def.id === selectedProcessDefId) ?? null,
    [chatProcessDefs, selectedProcessDefId],
  )

  const handleDeleteMessageContent = useCallback(
    (messageId: string) => {
      if (controlsBusy) return
      if (!window.confirm('Törlöd az üzenet tartalmát? A szálban csak a csontváz marad.')) return

      startTransition(async () => {
        const res = await deleteMessageContent({ messageId })
        if (!res.success) {
          setStatusMessage(res.error)
          return
        }
        const deletedAt = new Date().toISOString()
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, text: '', attachments: [], contentDeletedAt: deletedAt }
              : message,
          ),
        )
        setStatusMessage('Üzenettartalom törölve.')
        await refreshSessions()
      })
    },
    [controlsBusy, refreshSessions],
  )

  const handleMemoryCandidateUpdate = useCallback(
    (messageId: string, candidateId: string, patch: Partial<MemoryCandidateCard>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                memoryCandidates: m.memoryCandidates?.map((c) =>
                  c.candidateId === candidateId ? { ...c, ...patch } : c,
                ),
              }
            : m,
        ),
      )
    },
    [],
  )

  const handleConsequenceApprovalUpdate = useCallback(
    (messageId: string, approvalId: string, patch: Partial<ConsequenceApprovalCard>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                consequenceApprovals: m.consequenceApprovals?.map((a) =>
                  a.approvalId === approvalId ? { ...a, ...patch } : a,
                ),
              }
            : m,
        ),
      )
    },
    [],
  )

  const handlePromoteConversation = useCallback(() => {
    if (!conversationId || controlsBusy) return
    startTicketTransition(async () => {
      setStatusMessage(null)
      setLastTicketId(null)
      const res = await promoteConversationWithAi({ conversationId })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const refreshed = await loadAgentChatMessages({ conversationId, agentId: agent.id })
      if (refreshed.success) {
        setConversationStatus(refreshed.data.conversation.status)
        setContinuedFromTicket(refreshed.data.continuedFromTicket ?? null)
        setTicketDiscussionHistory(refreshed.data.ticketDiscussionHistory ?? [])
        setMessages(
          withPendingChatExtras(
            refreshed.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
            refreshed.data.pendingConsequenceApprovals?.map((a) => ({
              ...a,
              status: 'pending' as const,
            })),
            refreshed.data.pendingConnectorGrants,
          ),
        )
      }
      if ('ticketId' in res.data) {
        setLastTicketId(res.data.ticketId)
        setStatusMessage('A feladat elkészült és belinkeltem a beszélgetésbe.')
      } else {
        setStatusMessage('Az AI visszakérdezett a feladat létrehozása előtt.')
      }
      await refreshSessions()
    })
  }, [agent.id, conversationId, controlsBusy, refreshSessions])

  const handleArchiveConversation = useCallback(() => {
    if (!conversationId || controlsBusy || conversationStatus === 'archived') return
    if (!window.confirm('Archiválod ezt a beszélgetést? Ezután csak olvasható lesz.')) return
    startArchiveTransition(async () => {
      setStatusMessage(null)
      const res = await archiveConversation({ conversationId })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      setConversationStatus('archived')
      setStatusMessage('Beszélgetés archiválva.')
      await refreshSessions()
    })
  }, [controlsBusy, conversationId, conversationStatus, refreshSessions])

  const handleDistillSkill = useCallback(() => {
    if (!conversationId || controlsBusy || !canDistillSkill) return
    if (messages.length === 0) {
      setStatusMessage('Nincs desztillálható üzenet ebben a beszélgetésben.')
      return
    }
    startDistillTransition(async () => {
      setStatusMessage(null)
      const res = await distillSkillFromConversationAction({
        conversationId,
        agentId: agent.id,
        ...(distillTargetSkillId ? { targetSkillId: distillTargetSkillId } : {}),
      })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const reqHint =
        res.data.requires.length > 0
          ? ` Javasolt eszközök: ${res.data.requires.map((r) => r.toolName).join(', ')}.`
          : ''
      const versionHint = res.data.created ? 'Új skill draft' : 'Új verzió javaslat'
      setStatusMessage(
        `${versionHint} (${res.data.riskTier}): „${res.data.name}".${reqHint} Jóváhagyás: Skill katalógus.`,
      )
    })
  }, [agent.id, canDistillSkill, conversationId, controlsBusy, distillTargetSkillId, messages.length])

  const handleExportDebugLog = useCallback(() => {
    if (!conversationId || controlsBusy || !canDistillSkill) return
    startDebugLogTransition(async () => {
      setStatusMessage(null)
      const res = await exportConversationDebugLog({ conversationId })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const blob = new Blob([res.data.content], { type: res.data.mediaType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.data.filename
      a.click()
      URL.revokeObjectURL(url)
      setStatusMessage(`Debug-log letöltve: ${res.data.filename}`)
    })
  }, [canDistillSkill, controlsBusy, conversationId])

  const reloadConversationMessages = useCallback(
    async (convId: string) => {
      const res = await loadAgentChatMessages({ conversationId: convId, agentId: agent.id })
      if (!res.success) {
        setStatusMessage(res.error)
        return false
      }
      setConversationId(convId)
      setConversationStatus(res.data.conversation.status)
      setContinuedFromTicket(res.data.continuedFromTicket ?? null)
      setTicketDiscussionHistory(res.data.ticketDiscussionHistory ?? [])
      setMessages(
        withPendingChatExtras(
          res.data.messages.map((m) => ({
            ...m,
            createdAt: new Date(m.createdAt).toISOString(),
          })),
          res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
          res.data.pendingConnectorGrants,
        ),
      )
      startTransition(() => {
        void refreshSessions()
      })
      return true
    },
    [agent.id, refreshSessions],
  )

  const consumeReattachStream = useCallback(
    async (params: {
      turnId: string
      conversationId: string
      agentMessageId: string
      signal: AbortSignal
    }) => {
      const response = await fetch(`/api/v1/agent-chat/turns/${params.turnId}/stream`, {
        signal: params.signal,
      })
      if (!response.ok || !response.body) {
        setStatusMessage(`Visszacsatlakozás sikertelen (${response.status})`)
        setIsAgentTyping(false)
        setStopPending(false)
        setActiveTurnId(null)
        markConversationRunning(params.conversationId, false)
        // A forduló közben / után is perzisztálódhatott a válasz — üres buborék
        // helyett a DB végállapotot töltjük.
        await reloadConversationMessages(params.conversationId)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulatedReply = ''
      let sawTerminalEvent = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            let event: AgentChatStreamEvent
            try {
              event = JSON.parse(trimmed.slice(6)) as AgentChatStreamEvent
            } catch {
              continue
            }

            if (event.type === 'snapshot') {
              const activities = Array.isArray(event.activities)
                ? (event.activities as AgentActivity[])
                : []
              accumulatedReply = event.partialText ?? ''
              setActiveTurnId(event.turnId)
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          text: accumulatedReply,
                          activities,
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'activity') {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? { ...m, activities: upsertActivity(m.activities, event.activity) }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'consequence_approval' && event.approval) {
              // issue #97 — a visszacsatlakozó ág is megkapja a kaput: lecsatlakozás
              // után is legyen gomb, ne csak a folyamatosan nézett fordulóban.
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          consequenceApprovals: upsertConsequenceApproval(m.consequenceApprovals, {
                            ...event.approval,
                            status: 'pending',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'connector_grant_needed' && event.grant) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          connectorGrants: upsertConnectorGrant(m.connectorGrants, {
                            connectorType: 'gmail',
                            connectorName: 'Gmail',
                            ...event.grant,
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (
              event.type === 'thinking' &&
              typeof event.delta === 'string' &&
              thinkingTraceControls === 'enabled'
            ) {
              const { turnId, delta } = event
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          thinking: appendThinkingDelta(
                            m.thinking,
                            { turnId, delta },
                            thinkingTraceControls,
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'token') {
              accumulatedReply += event.chunk
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId ? { ...m, text: accumulatedReply } : m,
                  ),
                )
              })
            } else if (
              event.type === 'done' &&
              event.reason === 'cancelled' &&
              event.conversationId &&
              event.messageId
            ) {
              sawTerminalEvent = true
              await reloadConversationMessages(event.conversationId)
              return
            } else if (event.type === 'done' && event.conversationId && event.messageId) {
              sawTerminalEvent = true
              await reloadConversationMessages(event.conversationId)
              return
            } else if (event.type === 'error') {
              sawTerminalEvent = true
              setStatusMessage(event.message ?? 'A válasz hibával zárult.')
              await reloadConversationMessages(params.conversationId)
              return
            }
          }
        }

        // Stream lezárult done/error nélkül (proxy timeout, élő busz elszakadás).
        // Ha a válasz közben elkészült, a DB-ből kell visszatölteni — különben
        // üres agent-buborék marad a UI-on.
        if (!sawTerminalEvent && !params.signal.aborted) {
          await reloadConversationMessages(params.conversationId)
        }
      } finally {
        setIsAgentTyping(false)
        setStopPending(false)
        setActiveTurnId(null)
        markConversationRunning(params.conversationId, false)
      }
    },
    [markConversationRunning, reloadConversationMessages, thinkingTraceControls],
  )

  const reattachToConversation = useCallback(
    async (convId: string) => {
      try {
        const res = await fetch(
          `/api/v1/agent-chat/turns?conversationId=${encodeURIComponent(convId)}&active=1`,
        )
        if (!res.ok) return false
        const data = (await res.json()) as {
          active: boolean
          turn: {
            id: string
            partialText: string
            activities: unknown
            userMessageId: string | null
          } | null
        }
        if (!data.active || !data.turn) return false

        streamAbortRef.current?.abort()
        const abortController = new AbortController()
        streamAbortRef.current = abortController
        streamConversationIdRef.current = convId

        const agentMessageId = agentBubbleIdForTurn(data.turn.id)
        const activities = Array.isArray(data.turn.activities)
          ? (data.turn.activities as AgentActivity[])
          : []

        setActiveTurnId(data.turn.id)
        setIsAgentTyping(true)
        setStopPending(false)
        markConversationRunning(convId, true)
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== agentMessageId)
          const last = withoutOptimistic[withoutOptimistic.length - 1]
          if (last?.role === 'agent' && !last.text.trim() && !chatMessageShowsAgentActivity(last)) {
            return withoutOptimistic.map((m, i) =>
              i === withoutOptimistic.length - 1
                ? {
                    ...m,
                    id: agentMessageId,
                    text: data.turn!.partialText ?? '',
                    activities,
                  }
                : m,
            )
          }
          return [
            ...withoutOptimistic,
            {
              id: agentMessageId,
              role: 'agent' as const,
              text: data.turn!.partialText ?? '',
              attachments: [],
              createdAt: new Date().toISOString(),
              activities,
            },
          ]
        })

        void consumeReattachStream({
          turnId: data.turn.id,
          conversationId: convId,
          agentMessageId,
          signal: abortController.signal,
        })
        return true
      } catch {
        return false
      }
    },
    [consumeReattachStream, markConversationRunning],
  )

  const selectSession = useCallback(
    async (id: string) => {
      if (id === conversationId && !isAgentTyping) {
        setSessionsOpen(false)
        return
      }
      if (isAgentTyping && id === conversationId) {
        setSessionsOpen(false)
        return
      }

      // Más beszélgetésre váltáskor a helyi stream-olvasást megszakítjuk (a szerver fut tovább).
      // A sorban álló folytatást ELŐBB eldobjuk — különben a setIsAgentTyping(false)
      // flushelná a régi approval-id-kat az új beszélgetésre.
      streamAbortRef.current?.abort()
      pendingConsequenceContinuationRef.current = null
      setIsAgentTyping(false)
      setStopPending(false)
      setActiveTurnId(null)

      setConversationId(id)
      setStatusMessage(null)
      setLastTicketId(null)
      setContinuedFromTicket(null)
      setTicketDiscussionHistory([])
      setSessionsOpen(false)
      setSelectedProcessDefId(null)
      setConversationStatus(sessions.find((session) => session.id === id)?.status ?? 'active')

      const res = await loadAgentChatMessages({ conversationId: id, agentId: agent.id })
      if (res.success) {
        setConversationStatus(res.data.conversation.status)
        setContinuedFromTicket(res.data.continuedFromTicket ?? null)
        setTicketDiscussionHistory(res.data.ticketDiscussionHistory ?? [])
        setMessages(
          withPendingChatExtras(
            res.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
            res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
            res.data.pendingConnectorGrants,
          ),
        )
        void reattachToConversation(id)
      } else {
        setStatusMessage(res.error)
      }
    },
    [agent.id, conversationId, isAgentTyping, reattachToConversation, sessions],
  )

  // Deep-link: panel nyitáskor betölti az initialConversationId-t és reattach-el.
  useEffect(() => {
    if (!open || !initialConversationId) return
    // Szándékos: nyitáskor aszinkron beszélgetés-betöltést indítunk (a setState a fetch UTÁN
    // fut, nem szinkron az effekt törzsében) — a deep-link-nyitás nem fejezhető ki render alatt.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void selectSession(initialConversationId)
    // Csak nyitáskor / initialConversationId változáskor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialConversationId])

  // A Stop a FUTÓ FORDULÓ azonosítójára hivatkozik (#65). Amíg nincs turnId — a
  // `turn` esemény a stream legelső eseménye —, nincs mit megállítani.
  const handleStop = () => {
    const turnId = activeTurnIdRef.current
    if (!turnId || stopPending) return
    setStopPending(true)
    setStatusMessage(null)
    void (async () => {
      try {
        const response = await fetch(`/api/v1/agent-chat/turns/${turnId}/cancel`, {
          method: 'POST',
        })
        if (response.status === 200) {
          // Már lezárult, mire a Stop odaért — nem hiba, csak nincs mit megállítani.
          setStopPending(false)
          setStatusMessage('A válasz már befejeződött.')
          return
        }
        if (!response.ok) {
          setStopPending(false)
          setStatusMessage(
            response.status === 404
              ? 'Nincs futó válasz — lehet, hogy már befejeződött.'
              : 'Megállítás sikertelen.',
          )
        }
      } catch {
        setStopPending(false)
        setStatusMessage('Megállítás sikertelen.')
      }
    })()
  }

  /**
   * Egy agent-forduló elindítása és a SSE-stream feldolgozása.
   *
   * A szerkesztőmezőből küldött üzenet és a jóváhagyás utáni folytatás ugyanaz a
   * folyamat: mindkettőnek buborék, „gépel" jelző, aktivitás-lista és lezáráskor
   * DB-újratöltés jár. (A folytatásnál a forduló SZÖVEGÉT a szerver adja — a
   * kliens csak a jóváhagyás-azonosítókat küldi.)
   */
  const startAgentTurn = (options: {
    text: string
    attachments: PendingAttachment[]
    /** Amit a felhasználó a saját buborékában lát, amíg a DB-végállapot meg nem érkezik. */
    userBubbleText?: string
    consequenceApprovalIds?: string[]
    connectorGrantContinuation?: boolean
  }) => {
    const text = options.text
    const localAttachments = options.attachments
    const optimisticUserId = `optimistic-user-${Date.now()}`
    let agentBubbleMessageId = `optimistic-agent-pending-${Date.now()}`

    const optimisticUserMessage: ChatMessage = {
      id: optimisticUserId,
      role: 'user',
      text: options.userBubbleText ?? (text || '(csatolmányok)'),
      attachments: localAttachments.map((a) => ({
        documentId: a.id,
        filename: a.file.name,
        kind: a.kind,
        previewDataUrl: a.previewUrl,
      })),
      createdAt: new Date().toISOString(),
    }

    const optimisticAgentMessage: ChatMessage = {
      id: agentBubbleMessageId,
      role: 'agent',
      text: '',
      attachments: [],
      createdAt: new Date().toISOString(),
      activities: [],
    }

    setMessages((prev) => [...prev, optimisticUserMessage, optimisticAgentMessage])
    setStatusMessage(null)
    setLastTicketId(null)
    setIsAgentTyping(true)
    streamConversationIdRef.current = conversationId
    if (conversationId) markConversationRunning(conversationId, true)

    let accumulatedReply = ''

    const abortController = new AbortController()
    streamAbortRef.current = abortController

    void (async () => {
      let persistedUserMessageId: string | null = null
      // Ha a megszakadt olvasás után visszacsatlakozunk a futó fordulóra, a
      // háttér-stream (consumeReattachStream) veszi át a buborék és a
      // „gépel" jelző életciklusát — a lezáró `finally` ilyenkor nem nullázhat.
      let handedOffToReattach = false

      function removeFailedOptimisticMessages() {
        setMessages((prev) =>
          prev.filter(
            (message) =>
              message.id !== agentBubbleMessageId &&
              (persistedUserMessageId !== null || message.id !== optimisticUserId),
          ),
        )
      }

      /**
       * A forduló idő előtt megszakadt olvasásának EGYETLEN kezelője — mindegy,
       * hogy a stream lezáró esemény nélkül ért véget, vagy a `reader.read()`
       * dobott (elvágott válasz-törzs mobilhálón / proxy timeoutnál). A döntést
       * a tiszta {@link decideChatStreamRecovery} hozza, itt csak végrehajtjuk.
       */
      async function recoverInterruptedStream(ending: ChatStreamEnding) {
        const action = decideChatStreamRecovery({
          ending,
          userMessagePersisted: persistedUserMessageId !== null,
          conversationId: streamConversationIdRef.current ?? conversationId,
        })
        if (action.kind === 'none') return
        if (action.kind === 'discard') {
          // A szerver még vissza sem igazolta a user-üzenetet: nincs mit
          // visszaszerezni, a félkész buborékokat takarítjuk.
          removeFailedOptimisticMessages()
          setStatusMessage(action.message)
          return
        }
        try {
          const attached = await reattachToConversation(action.conversationId)
          if (attached) {
            handedOffToReattach = true
            return
          }
          await reloadConversationMessages(action.conversationId)
          setStatusMessage(STREAM_RECOVERED_MESSAGE)
        } catch {
          // A visszaszerzés maga is elbukhat (tartós hálózatkiesés). Ilyenkor is
          // az a fontos üzenet, hogy a munka nem veszett el.
          setStatusMessage(STREAM_RECOVERY_FAILED_MESSAGE)
        }
      }

      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []
        if (abortController.signal.aborted) return

        const response = await fetch('/api/v1/agent-chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            agentId: agent.id,
            content: text,
            conversationId: conversationId ?? undefined,
            attachmentDocumentIds: documentIds,
            processDefinitionId: selectedProcessDefId ?? undefined,
            ...(options.consequenceApprovalIds?.length
              ? { consequenceApprovalIds: options.consequenceApprovalIds }
              : {}),
            ...(options.connectorGrantContinuation ? { connectorGrantContinuation: true } : {}),
          }),
        })

        // Aktív-forduló ütközés (D7) VAGY taskOnly tiltás (#199): mindkettő 409.
        // A fajtákat nem szabad összekeverni — a taskOnly eddig „már készül a
        // válasz”-ként jelent meg, eltüntette a kérdést, és beragadt a „most dolgozik".
        if (response.status === 409) {
          removeFailedOptimisticMessages()
          markConversationRunning(conversationId, false)
          let conflictBody: {
            error?: string
            message?: string
            activeTurnId?: string | null
            conversationId?: string
          } = {}
          try {
            conflictBody = (await response.json()) as typeof conflictBody
          } catch {
            // ignore
          }
          const conflict = resolveChatStreamConflict(conflictBody, conversationId)
          if (conflict.kind === 'active_turn') {
            if (conflict.conversationId) {
              setConversationId(conflict.conversationId)
              const attached = await reattachToConversation(conflict.conversationId)
              if (attached) {
                setStatusMessage('Már fut egy válasz — visszacsatlakoztál hozzá.')
                return
              }
            }
            setStatusMessage(conflict.message)
            setIsAgentTyping(false)
            return
          }
          setStatusMessage(conflict.message)
          setIsAgentTyping(false)
          return
        }

        if (!response.ok || !response.body) {
          removeFailedOptimisticMessages()
          markConversationRunning(conversationId, false)
          setStatusMessage(
            options.connectorGrantContinuation
              ? `A hozzáférés megvan, de az agent folytatása nem indult el (${response.status}). Írd meg a chatben, hogy folytassa.`
              : options.consequenceApprovalIds?.length
                ? `A jóváhagyott művelet lefutott, de az agent folytatása nem indult el (${response.status}). Írd meg a chatben, hogy folytassa.`
                : `Küldés sikertelen (${response.status})`,
          )
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamTerminalEvent = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const raw = trimmed.slice(6)
            let event: AgentChatStreamEvent
            try {
              event = JSON.parse(raw) as AgentChatStreamEvent
            } catch {
              continue
            }

            if (event.type === 'turn' && event.turnId) {
              const turnBubbleId = agentBubbleIdForTurn(event.turnId)
              setActiveTurnId(event.turnId)
              // flushSync: a rákövetkező activity upsert már a turn-id-s buborékot
              // találja meg, ne az optimistic id-t (ugyanabban a SSE chunkban).
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) => (m.id === agentBubbleMessageId ? { ...m, id: turnBubbleId } : m)),
                )
              })
              agentBubbleMessageId = turnBubbleId
            } else if (event.type === 'meta' && event.conversationId) {
              persistedUserMessageId = event.userMessageId
              streamConversationIdRef.current = event.conversationId
              markConversationRunning(event.conversationId, true)
              setConversationId(event.conversationId)
              setConversationStatus('active')
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === optimisticUserId
                    ? { ...message, id: event.userMessageId }
                    : message,
                ),
              )
            } else if (event.type === 'activity') {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          activities: upsertActivity(m.activities, event.activity),
                        }
                      : m,
                  ),
                )
              })
            } else if (
              event.type === 'thinking' &&
              typeof event.delta === 'string' &&
              thinkingTraceControls === 'enabled'
            ) {
              const { turnId, delta } = event
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          thinking: appendThinkingDelta(
                            m.thinking,
                            { turnId, delta },
                            thinkingTraceControls,
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'memory_candidate' && event.candidate) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          memoryCandidates: upsertMemoryCandidate(m.memoryCandidates, {
                            ...event.candidate,
                            status: 'proposed',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'consequence_approval' && event.approval) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          consequenceApprovals: upsertConsequenceApproval(m.consequenceApprovals, {
                            ...event.approval,
                            status: 'pending',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'connector_grant_needed' && event.grant) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          connectorGrants: upsertConnectorGrant(m.connectorGrants, {
                            connectorType: 'gmail',
                            connectorName: 'Gmail',
                            ...event.grant,
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'token' && typeof event.chunk === 'string') {
              accumulatedReply += event.chunk
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId ? { ...m, text: m.text + event.chunk! } : m,
                  ),
                )
              })
            } else if (
              event.type === 'done' &&
              event.reason === 'cancelled' &&
              event.conversationId &&
              event.messageId
            ) {
              markConversationRunning(event.conversationId, false)
              setActiveTurnId(null)
              await reloadConversationMessages(event.conversationId)
              setStatusMessage('Agent válasz megszakítva — részeredmény mentve.')
              streamTerminalEvent = true
              break
            } else if (event.type === 'done' && event.conversationId && event.messageId) {
              setConversationId(event.conversationId)
              setConversationStatus('active')
              markConversationRunning(event.conversationId, false)
              setActiveTurnId(null)
              // A Folyamat-választás csak addig marad rögzítve, amíg a Futás
              // ténylegesen el nem indul (§4.4) — utána a chat visszaáll
              // normál beszélgetésre, hogy ne próbálja újraindítani.
              if (accumulatedReply.includes('Futás elindítva a(z)')) {
                setSelectedProcessDefId(null)
              }
              // Mindig a DB végállapotot töltjük: hosszú tool-körök / proxy
              // timeout után a token-stream hiányos lehet, miközben a válasz
              // már perzisztálva van — különben üres agent-buborék marad.
              await reloadConversationMessages(event.conversationId)
              streamTerminalEvent = true
              break
            } else if (event.type === 'error') {
              // Csak a persist-ACK után tartjuk meg a user-üzenetet. Validációs vagy
              // korai szerverhiba esetén a meta esemény még nem érkezett meg.
              removeFailedOptimisticMessages()
              setStatusMessage(event.message ?? 'Küldés sikertelen')
              streamTerminalEvent = true
              break
            }
          }
          if (streamTerminalEvent) break
        }

        if (!streamTerminalEvent) {
          await recoverInterruptedStream('closed_without_terminal')
        }

        if (streamTerminalEvent) {
          try {
            await reader.cancel()
          } catch {
            // A stream néha már lezárt állapotban van; ezt nyeljük.
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return
        }
        // A `reader.read()` a válasz-törzs elvágásakor hibát DOB (mobilhálón
        // `TypeError: network error`), nem lezáró eseményt ad — ezért ugyanaz a
        // visszaszerzés jár neki, mint a lezáró esemény nélküli végnek. Enélkül
        // a felhasználó nyers hibaszöveget és üres választ kapott, miközben a
        // forduló a szerveren tovább futott és az eredménye perzisztálódott.
        await recoverInterruptedStream('read_threw')
      } finally {
        if (streamAbortRef.current === abortController) {
          streamAbortRef.current = null
        }
        // Visszacsatlakozás után a háttér-stream birtokolja a buborékot, a
        // stream-konverzáció-ref-et és a „gépel" jelzőt — ezeket nem bántjuk.
        if (!handedOffToReattach) {
          streamConversationIdRef.current = null
          setIsAgentTyping(false)
        }
        setStopPending(false)
        filesRef.current?.refresh()
      }
    })()
  }

  const handleSend = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    resetComposer()
    startAgentTurn({ text, attachments: localAttachments })
  }

  // A gépelés-vége flush refen keresztül hívja az aktuális implementációt.
  // A ref írása effectben történik: render közben a React 19 szerint nem
  // módosítható, és ez az effect a lenti folytatás-effect előtt fut le.
  useEffect(() => {
    startAgentTurnRef.current = startAgentTurn
  })

  /**
   * Futó forduló közbeni „Jóváhagyom" → folytatás sorba. A forduló végén
   * (isAgentTyping false) automatikusan elindul, hogy ne vesszen el a lánc.
   */
  useEffect(() => {
    if (isAgentTyping) return
    const ids = pendingConsequenceContinuationRef.current
    if (!ids || ids.length === 0) return
    if (conversationStatus === 'archived') {
      pendingConsequenceContinuationRef.current = null
      return
    }
    pendingConsequenceContinuationRef.current = null
    startAgentTurnRef.current?.({
      text: '',
      attachments: [],
      userBubbleText: '✅ Jóváhagyva — a művelet lefutott, folytasd.',
      consequenceApprovalIds: ids,
    })
  }, [isAgentTyping, conversationStatus])

  useEffect(() => {
    if (resumeAfterGrant) grantResumeStartedRef.current = false
  }, [resumeAfterGrant, restoreSignal])

  /**
   * OAuth-grant után (`?granted=1`): a beszélgetés betöltődése után egy
   * folytatás-forduló indul. A zászló a session-store-ban él, hogy a URL
   * takarítása ne írja felül.
   */
  useEffect(() => {
    if (!open || !resumeAfterGrant) return
    if (!initialConversationId || conversationId !== initialConversationId) return
    if (isAgentTyping) return
    if (conversationStatus === 'archived') return
    if (grantResumeStartedRef.current) return
    grantResumeStartedRef.current = true
    clearAgentChatResumeAfterGrant(agent.id)
    stripGrantedQueryFromUrl()
    startAgentTurnRef.current?.({
      text: '',
      attachments: [],
      userBubbleText: '✅ Hozzáférés megadva — folytasd.',
      connectorGrantContinuation: true,
    })
  }, [
    agent.id,
    conversationId,
    conversationStatus,
    initialConversationId,
    isAgentTyping,
    open,
    resumeAfterGrant,
    restoreSignal,
  ])

  /**
   * A „Jóváhagyom" gomb után a művelet a szerveren MÁR lefutott — innen az agent
   * folytatja. Enélkül a felhasználó csak annyit lát, hogy „nem történik semmi":
   * nincs válasz, és a hátralévő lépések (pl. a sorok beírása a létrehozott
   * fájlba) sem futnak le.
   *
   * Ha a kapu-üzenet még streamel, miközben a user már approve-ol (gyakori race),
   * a folytatást sorba tesszük — nem dobjuk el „írj üzenetet" státusszal.
   */
  const handleConsequenceApproved = (approvalIds: string[]) => {
    // A frissen írt fájl azonnal látszódjon a Workspace listában.
    filesRef.current?.refresh()
    if (approvalIds.length === 0) return
    if (conversationStatus === 'archived') {
      setStatusMessage('A művelet lefutott. Az agent folytatásához írj egy üzenetet a chatben.')
      return
    }
    if (isAgentTyping) {
      const prev = pendingConsequenceContinuationRef.current ?? []
      pendingConsequenceContinuationRef.current = [...new Set([...prev, ...approvalIds])]
      setStatusMessage('A művelet lefutott — amint az agent befejezi a választ, folytatjuk.')
      return
    }
    startAgentTurn({
      text: '',
      attachments: [],
      userBubbleText: '✅ Jóváhagyva — a művelet lefutott, folytasd.',
      consequenceApprovalIds: approvalIds,
    })
  }

  const handleCreateTicket = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    const executeAfterIso = ticketExecuteAfter
      ? new Date(ticketExecuteAfter).toISOString()
      : undefined
    const maxRuns = ticketMaxRuns ? Number(ticketMaxRuns) : null
    const titleSource = text || localAttachments[0]?.file.name || 'Feladat'

    startTicketTransition(async () => {
      setStatusMessage(null)
      setLastTicketId(null)
      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []
        if (executeAfterIso) {
          const scheduledContent =
            text ||
            `Csatolmányok: ${localAttachments.map((attachment) => attachment.file.name).join(', ')}`
          const res = await createScheduledAgentTask({
            agentId: agent.id,
            title: `Feladat: ${titleSource.slice(0, 80)}`,
            content: scheduledContent,
            conversationId: conversationId ?? undefined,
            attachmentDocumentIds: documentIds,
            nextRunAt: executeAfterIso,
            recurrence: ticketRecurrence,
            maxRuns: ticketRecurrence === 'none' ? null : maxRuns,
            authorizeRunAs: ticketAuthorizeRunAs,
          })
          if (!res.success) {
            setStatusMessage(res.error)
            return
          }
          resetComposer()
          setStatusMessage(
            ticketRecurrence === 'none'
              ? 'Ütemezett task létrehozva — a worker a megadott időpontban feladatot készít belőle.'
              : 'Ismétlődő ütemezett task létrehozva.',
          )
          return
        }

        const res = await createAgentTaskTicket({
          agentId: agent.id,
          content: text,
          conversationId: conversationId ?? undefined,
          attachmentDocumentIds: documentIds,
          authorizeRunAs: ticketAuthorizeRunAs,
        })
        if (!res.success) {
          setStatusMessage(res.error)
          return
        }
        setLastTicketId(res.data.ticketId)
        resetComposer()
        setStatusMessage('Feladat létrehozva — megjelenik a Kanban táblán.')
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : 'Feladat létrehozás sikertelen')
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Az Enter mindig azt teszi, amit az elsődleges gomb ígér.
      if (composerMode === 'task') handleCreateTicket()
      else handleSend()
    }
  }

  if (!open || !mounted) return null

  const inSessionGrid = tileTarget !== null

  return createPortal(
    <div
      className={
        inSessionGrid
          ? `pointer-events-auto relative flex h-[calc(100dvh-1.5rem)] min-h-[36rem] w-full flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl sm:h-full sm:min-h-0 ${
              minimized ? 'hidden' : ''
            }`
          : `fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-6 lg:p-4 ${
              minimized ? 'pointer-events-none invisible' : ''
            }`
      }
      aria-hidden={minimized}
      {...(minimized ? { inert: true } : {})}
    >
      {!inSessionGrid ? (
        <button
          type="button"
          aria-label="Bezárás"
          className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
          onClick={onClose}
          tabIndex={minimized ? -1 : undefined}
        />
      ) : null}
      <div
        role="dialog"
        aria-modal={inSessionGrid ? false : !minimized}
        aria-labelledby="agent-chat-title"
        className={
          inSessionGrid
            ? 'flex h-full min-h-0 w-full flex-col'
            : 'relative z-[1] flex h-[100dvh] w-full flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(calc(100dvh-3rem),calc(100vh-3rem))] sm:max-w-[min(calc(100vw-3rem),100rem)] sm:rounded-2xl lg:h-[min(calc(100dvh-2rem),calc(100vh-2rem))] lg:max-w-[min(calc(100vw-2rem),120rem)]'
        }
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-line bg-card px-3 py-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => setSessionsOpen((v) => !v)}
            className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep sm:hidden"
            aria-expanded={sessionsOpen}
            aria-label="Előzmények megnyitása"
          >
            ☰
          </button>
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="sm"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                id="agent-chat-title"
                className="truncate font-display text-base font-semibold leading-tight sm:text-lg"
              >
                {persona.nickname}
              </h2>
              {/* Egyetlen állapotjelző a szál helyzetéről — a régi „aktív szál”
                  chip nem árulta el a lényeget: dolgozik-e éppen az agent. */}
              {isAgentTyping ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sky/40 bg-sky/10 px-2 py-0.5 text-[10px] font-semibold text-sky">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky" aria-hidden />
                  dolgozik
                </span>
              ) : conversationStatus === 'archived' ? (
                <span className="shrink-0 rounded-full border border-line bg-night-2 px-2 py-0.5 text-[10px] font-semibold text-ink-faint">
                  archivált
                </span>
              ) : null}
            </div>
            {connectableUserConnectorsLoading ? (
              <p className="text-[11px] text-ink-faint">Kapcsolatok betöltése…</p>
            ) : connectableUserConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={connectableUserConnectors} variant="compact" />
            ) : (
              <p className="truncate text-[11px] text-ink-faint">
                {conversationId ? 'Mentett beszélgetés' : 'Új beszélgetés'}
              </p>
            )}
          </div>

          {conversationId && (
            <ChatHeaderMenu>
              <ChatMenuItem
                title={ticketPending ? 'Elemzés…' : 'Feladat készítése a szálból'}
                hint="A beszélgetésből AI-feladat lesz a Kanban táblán."
                onClick={handlePromoteConversation}
                disabled={controlsBusy || conversationStatus === 'archived'}
                tone="warn"
              />
              {canDistillSkill && (
                <>
                  {distillTargets.length > 0 && (
                    <label
                      className="block px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="block text-[11px] font-semibold text-ink-soft">
                        Desztillálás célja
                      </span>
                      <select
                        value={distillTargetSkillId}
                        onChange={(e) => setDistillTargetSkillId(e.target.value)}
                        disabled={controlsBusy}
                        className="mt-1 w-full rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink-soft disabled:opacity-40"
                      >
                        <option value="">Új skill</option>
                        {distillTargets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} (új verzió)
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <ChatMenuItem
                    title={distillPending ? 'Desztillálás…' : 'Skill desztillálása'}
                    hint="A beszélgetés módszeréből skill-vázlat készül (jóváhagyás kell)."
                    onClick={handleDistillSkill}
                    disabled={controlsBusy || messages.length === 0}
                  />
                  <ChatMenuItem
                    title={debugLogPending ? 'Log készül…' : 'Debug-log letöltése'}
                    hint="Teljes telemetria: üzenetek, fordulók, model- és tool-hívások."
                    onClick={handleExportDebugLog}
                    disabled={controlsBusy}
                  />
                </>
              )}
              {conversationStatus !== 'archived' && (
                <>
                  <div className="my-1 h-px bg-line" />
                  <ChatMenuItem
                    title={archivePending ? 'Archiválás…' : 'Szál archiválása'}
                    hint="Olvasható marad, de nem lehet hozzá új üzenetet fűzni."
                    onClick={handleArchiveConversation}
                    disabled={controlsBusy || ticketPending || archivePending}
                  />
                </>
              )}
            </ChatHeaderMenu>
          )}

          <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1.5">
            <button
              type="button"
              onClick={handleMinimize}
              className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label="Beszélgetés tálcára rakása"
              title="Tálcára rakás"
            >
              −
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label="Beszélgetés bezárása"
              title="Bezárás"
            >
              ✕
            </button>
          </div>
        </header>

        {continuedFromTicket && (
          <div className="shrink-0 border-b border-sky/25 bg-sky/8 px-3 py-2 sm:px-4">
            <p className="text-xs leading-snug text-ink-soft">
              <span className="font-semibold text-sky">Feladat megbeszélése:</span>{' '}
              <Link
                href={`/control-plane/tickets/${continuedFromTicket.id}`}
                className="font-medium text-ink underline decoration-sky/40 underline-offset-2 transition-colors hover:text-coral-deep hover:decoration-coral/50"
                title={continuedFromTicket.title}
              >
                {continuedFromTicket.title}
              </Link>
            </p>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1">
          {sessionsOpen && (
            <button
              type="button"
              aria-label="Előzmények bezárása"
              className="absolute inset-0 z-10 bg-ink/20 sm:hidden"
              onClick={() => setSessionsOpen(false)}
            />
          )}

          <div
            className={`absolute inset-y-0 left-0 z-20 w-[min(88vw,17rem)] border-r border-line shadow-xl transition-transform sm:static sm:z-0 sm:w-56 sm:shrink-0 sm:translate-x-0 sm:shadow-none lg:w-64 xl:w-72 ${
              sessionsOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'
            }`}
          >
            <AgentChatSessionSidebar
              sessions={sessions}
              activeConversationId={conversationId}
              runningConversationIds={runningConversationIds}
              statusFilter={sessionsFilter}
              loading={sessionsLoading}
              loadingMore={sessionsLoadingMore}
              hasMore={sessionsHasMore}
              isBusy={controlsBusy}
              onSelect={selectSession}
              onNewChat={startNewSession}
              onLoadMore={loadMoreSessions}
              onStatusFilterChange={setSessionsFilter}
              className="h-full"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              {messages.length === 0 && ticketDiscussionHistory.length === 0 && !isAgentTyping ? (
                <div className="mx-auto flex h-full min-h-[200px] max-w-md flex-col items-center justify-center text-center">
                  <span className="text-4xl" aria-hidden>
                    {persona.emoji}
                  </span>
                  <p className="mt-4 text-base text-ink-soft">{persona.greeting}</p>
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Írd le, mire van szükséged — {persona.nickname} válaszol.
                  </p>
                  {/* Üres állapot: a panel képességei nem derülnek ki a beviteli
                      mezőből, ezért itt egyszer, hétköznapi nyelven kimondjuk. */}
                  <ul className="mt-6 w-full space-y-2 text-left">
                    {[
                      {
                        icon: '📎',
                        title: 'Fájl vagy kép csatolása',
                        hint: 'Húzd be, vagy használd a gemkapcsot a beviteli mezőnél.',
                      },
                      ...(agentSkills.length > 0
                        ? [
                            {
                              icon: '⚡',
                              title: 'Skill indítása',
                              hint: 'Írj / jelet, vagy válassz a „Skill” gombbal.',
                            },
                          ]
                        : []),
                      {
                        icon: '📋',
                        title: 'Üzenetből feladat',
                        hint: 'Válts „Feladat” módra, ha a táblára kell kerülnie — akár időzítve.',
                      },
                    ].map((tip) => (
                      <li
                        key={tip.title}
                        className="flex items-start gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5"
                      >
                        <span aria-hidden className="text-base leading-5">
                          {tip.icon}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold text-ink">{tip.title}</span>
                          <span className="block text-[11px] leading-snug text-ink-faint">
                            {tip.hint}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mx-auto max-w-5xl">
                  {ticketDiscussionHistory.length > 0 && (
                    <div className="mb-6 space-y-3 border-b border-line pb-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                        Feladat előzménye
                      </p>
                      {ticketDiscussionHistory.map((item) => {
                        const isUser = item.role === 'user'
                        return (
                          <div
                            key={item.id}
                            className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
                          >
                            <div
                              className={`max-w-[min(88%,64rem)] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                                isUser
                                  ? 'rounded-tr-md bg-coral/85 text-card'
                                  : item.role === 'system'
                                    ? 'rounded-tl-md border border-dashed border-line bg-night-2 text-ink-faint'
                                    : 'rounded-tl-md border border-line bg-card/80 text-ink-soft'
                              }`}
                            >
                              <div
                                className={`mb-1 text-[11px] font-semibold ${
                                  isUser ? 'text-card/80' : 'text-ink-faint'
                                }`}
                              >
                                {item.authorLabel}
                              </div>
                              {isUser ? (
                                <div className="[&_a]:text-card [&_a]:underline [&_strong]:text-card">
                                  <ChatMarkdown content={item.text} variant="user" />
                                </div>
                              ) : (
                                <ChatMarkdown content={item.text} variant="agent" />
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {messages.length === 0 && !isAgentTyping && (
                        <p className="pt-1 text-center text-xs text-ink-faint">
                          Írd meg a kérdésed — {persona.nickname} a feladat előzményével válaszol.
                        </p>
                      )}
                    </div>
                  )}
                  {messages.map((message, index) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isBusy={controlsBusy}
                      showAuthor={messages[index - 1]?.role !== message.role}
                      agentName={persona.nickname}
                      agentAvatarUrl={agent.avatarUrl}
                      agentStatus={agent.status}
                      personaNickname={agent.personaNickname}
                      onDeleteContent={handleDeleteMessageContent}
                      onOpenTask={handleMinimize}
                      onMemoryCandidateUpdate={handleMemoryCandidateUpdate}
                      onConsequenceApprovalUpdate={handleConsequenceApprovalUpdate}
                      onConsequenceApproved={handleConsequenceApproved}
                      grantReturnTo={
                        conversationId
                          ? { kind: 'conversation', id: conversationId, agentId: agent.id }
                          : undefined
                      }
                      workspaceBaseUrl={
                        conversationId
                          ? `/api/v1/conversations/${conversationId}/workspace/files`
                          : undefined
                      }
                      workspaceFilePaths={workspaceFilePaths}
                    />
                  ))}
                  {isAgentTyping &&
                    !messages[messages.length - 1]?.text &&
                    !chatMessageShowsAgentActivity(messages[messages.length - 1]) && (
                    <div className="mt-4">
                      <TypingIndicator agentName={persona.nickname} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {conversationId && (
              <ConversationFilesPanel
                conversationId={conversationId}
                panelRef={filesRef}
                onFilesChange={setWorkspaceFilePaths}
              />
            )}

            <div className="shrink-0 border-t border-line bg-night/40 px-4 py-3 sm:px-5 sm:py-4">
              {conversationStatus === 'archived' && (
                <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
                  Ez a szál archivált: elolvasható, de új üzenet nem fűzhető hozzá.
                </p>
              )}
              {statusMessage && (
            <p className="mb-2 text-xs text-ink-soft">
              {statusMessage}
              {lastTicketId && (
                <>
                  {' '}
                  <Link
                    href={`/control-plane/tickets/${lastTicketId}`}
                    onClick={handleMinimize}
                    className="font-semibold text-coral hover:underline"
                  >
                    Feladat megnyitása →
                  </Link>
                </>
              )}
            </p>
          )}

          {attachmentWarningSkills.length > 0 && (
            <p className="mb-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs text-honey">
              A(z) {attachmentWarningSkills.join(', ')} skill jellemzően nem fájlból dolgozik —
              a csatolmányt lehet, hogy figyelmen kívül hagyja. Az üzenetet ettől még
              elküldheted.
            </p>
          )}

          {pendingAttachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="group relative overflow-hidden rounded-xl border border-line bg-card"
                >
                  {attachment.kind === 'image' && attachment.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.file.name}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    <div className="flex h-16 w-28 items-center justify-center px-2 text-xs text-ink-faint">
                      📎 {attachment.file.name}
                    </div>
                  )}
                  {/* Érintőképernyőn nincs hover: az eltávolítás nem tűnhet el. */}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-1 top-1 rounded-full bg-ink/70 px-1.5 py-0.5 text-[10px] text-card transition-colors hover:bg-ink"
                    aria-label={`${attachment.file.name} eltávolítása`}
                    title="Csatolmány eltávolítása"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/*
            Mit csináljon az üzenettel? Egyetlen, kimondott döntés — és csak az
            ehhez tartozó beállítások látszanak. A régi elrendezésben az
            ütemezés/run-as mezők akkor is ott sorakoztak, amikor a user csak
            beszélgetni akart, a „Feladat” gomb pedig a „Küldés”-sel versengett.
          */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-lg border border-line bg-night-2 p-0.5"
              role="radiogroup"
              aria-label="Mi legyen az üzenetből"
            >
              {(
                [
                  { value: 'chat', label: 'Beszélgetés', hint: 'Az agent most válaszol.' },
                  {
                    value: 'task',
                    label: 'Feladat',
                    hint: 'Az üzenetből feladat lesz a táblán — akár időzítve.',
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={composerMode === option.value}
                  title={option.hint}
                  onClick={() => switchComposerMode(option.value)}
                  disabled={composerDisabled}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                    composerMode === option.value
                      ? 'bg-card text-ink shadow-sm'
                      : 'text-ink-faint hover:text-ink-soft'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {agentSkills.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setComposerPanel((p) => (p === 'skill' ? null : 'skill'))}
                  disabled={composerDisabled}
                  aria-expanded={composerPanel === 'skill'}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                    composerPanel === 'skill'
                      ? 'border-coral/40 bg-coral/10 text-coral-deep'
                      : 'border-line bg-card text-ink-soft hover:border-coral/30 hover:text-coral-deep'
                  }`}
                >
                  <span aria-hidden>⚡</span> Skill
                </button>
                {composerPanel === 'skill' && (
                  <>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      className="fixed inset-0 z-30 cursor-default"
                      onClick={() => setComposerPanel(null)}
                    />
                    <div className="absolute bottom-full left-0 z-40 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-xl">
                      <p className="px-3 py-2 text-[11px] leading-snug text-ink-faint">
                        A kiválasztott skill neve bekerül az üzenetbe — ugyanaz, mintha
                        <span className="font-semibold"> / </span>jellel írnád be.
                      </p>
                      {agentSkills.map((skill) => (
                        <button
                          key={skill.skillVersionId}
                          type="button"
                          onClick={() => {
                            slash.insertAtCursor(skill)
                            setComposerPanel(null)
                          }}
                          className="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-night-2"
                        >
                          <span className="text-xs font-semibold text-ink">{skill.name}</span>
                          <span className="line-clamp-2 text-[11px] leading-snug text-ink-faint">
                            {skill.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {chatProcessDefs.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setComposerPanel((p) => (p === 'process' ? null : 'process'))}
                  disabled={composerDisabled}
                  aria-expanded={composerPanel === 'process'}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                    selectedProcessDef
                      ? 'border-sage/50 bg-sage/10 text-sage'
                      : composerPanel === 'process'
                        ? 'border-coral/40 bg-coral/10 text-coral-deep'
                        : 'border-line bg-card text-ink-soft hover:border-coral/30 hover:text-coral-deep'
                  }`}
                >
                  <span aria-hidden>▶</span>
                  <span className="max-w-[12rem] truncate">
                    {selectedProcessDef ? selectedProcessDef.name : 'Folyamat'}
                  </span>
                </button>
                {selectedProcessDef && (
                  <button
                    type="button"
                    onClick={() => setSelectedProcessDefId(null)}
                    className="ml-1 rounded-full px-1 text-xs text-ink-faint hover:text-coral-deep"
                    aria-label="Folyamat kiválasztásának törlése"
                    title="Mégsem indítok folyamatot"
                  >
                    ✕
                  </button>
                )}
                {composerPanel === 'process' && (
                  <>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      className="fixed inset-0 z-30 cursor-default"
                      onClick={() => setComposerPanel(null)}
                    />
                    <div className="absolute bottom-full left-0 z-40 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-xl">
                      <p className="px-3 py-2 text-[11px] leading-snug text-ink-faint">
                        Folyamatot választva a következő üzeneted nem sima választ kap: azt a
                        folyamatot indítja el.
                      </p>
                      {chatProcessDefs.map((def) => (
                        <button
                          key={def.id}
                          type="button"
                          onClick={() => {
                            setSelectedProcessDefId(def.id)
                            setComposerPanel(null)
                          }}
                          className="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-night-2"
                        >
                          <span className="text-xs font-semibold text-ink">{def.name}</span>
                          {def.description && (
                            <span className="line-clamp-2 text-[11px] leading-snug text-ink-faint">
                              {def.description}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {selectedProcessDef && (
            <p className="mb-2 rounded-lg border border-sage/30 bg-sage/5 px-3 py-2 text-xs text-ink-soft">
              {(() => {
                const requiredSlots = selectedProcessDef.slots.filter((slot) => slot.required)
                if (requiredSlots.length === 0) {
                  return `A(z) „${selectedProcessDef.name}” folyamat indul a következő üzeneteddel.`
                }
                return `A(z) „${selectedProcessDef.name}” folyamat indul. Add meg üzenetben: ${requiredSlots
                  .map((slot) => (slot.description ? `${slot.name} (${slot.description})` : slot.name))
                  .join(', ')}`
              })()}
            </p>
          )}

          {composerMode === 'task' && (
            <div className="mb-2 rounded-xl border border-honey/35 bg-honey/5 px-3 py-2.5">
              <p className="text-[11px] leading-snug text-ink-soft">
                Az üzenetből feladat készül a Kanban táblán. Ha időpontot is megadsz, a feladat
                magától elindul akkor.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-3 text-xs text-ink-soft">
                <label className="flex min-w-[13rem] flex-1 flex-col gap-1">
                  <span className="font-semibold text-ink">Mikor induljon</span>
                  <input
                    type="datetime-local"
                    value={ticketExecuteAfter}
                    onChange={(e) => setTicketExecuteAfter(e.target.value)}
                    disabled={composerDisabled}
                    className="min-w-0 rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink"
                  />
                  <span className="text-[10px] text-ink-faint">
                    Üresen hagyva azonnal a táblára kerül.
                  </span>
                </label>

                {ticketExecuteAfter && (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="font-semibold text-ink">Ismétlődés</span>
                      <select
                        value={ticketRecurrence}
                        onChange={(e) =>
                          setTicketRecurrence(e.target.value as ScheduledTaskRecurrence)
                        }
                        disabled={composerDisabled}
                        className="rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink"
                      >
                        <option value="none">egyszer fusson</option>
                        <option value="daily">naponta</option>
                        <option value="weekly">hetente</option>
                        <option value="monthly">havonta</option>
                      </select>
                    </label>
                    {ticketRecurrence !== 'none' && (
                      <label className="flex flex-col gap-1">
                        <span className="font-semibold text-ink">Legfeljebb</span>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={ticketMaxRuns}
                          onChange={(e) => setTicketMaxRuns(e.target.value)}
                          disabled={composerDisabled}
                          placeholder="alkalom"
                          className="w-24 rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink"
                        />
                      </label>
                    )}
                  </>
                )}
              </div>

              <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg bg-card px-2.5 py-2">
                <input
                  type="checkbox"
                  checked={ticketAuthorizeRunAs}
                  onChange={(e) => setTicketAuthorizeRunAs(e.target.checked)}
                  disabled={composerDisabled}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-coral"
                />
                <span className="text-xs">
                  <span className="font-semibold text-ink">Futhat a nevemben</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                    Engedélyezi, hogy a feladat a te jogosultságoddal végezzen olyan lépéseket,
                    amikhez külön hozzáférés kell.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="relative flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm focus-within:border-coral/40 focus-within:ring-2 focus-within:ring-coral/15">
            <SkillSlashMenu
              autocomplete={slash}
              emptyLabel="Ehhez az AI munkatárshoz nincs engedélyezett skill hozzárendelve."
              position="above"
              className="left-12"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.csv,.json,.pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={composerDisabled}
              className="shrink-0 rounded-xl p-2.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink disabled:opacity-40"
              title="Fájl vagy kép csatolása"
              aria-label="Fájl vagy kép csatolása"
            >
              📎
            </button>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                slash.syncCursor(e.target)
                slash.setSelectedIndex(0)
              }}
              onSelect={(e) => slash.syncCursor(e.currentTarget)}
              onClick={(e) => slash.syncCursor(e.currentTarget)}
              onKeyUp={(e) => slash.syncCursor(e.currentTarget)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={
                composerMode === 'task'
                  ? 'Mi legyen a feladat? Írd le egy mondatban…'
                  : `Üzenet ${persona.nickname} részére…`
              }
              disabled={composerDisabled}
              className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />

            {/* Egyetlen elsődleges gomb: a jelentését a fenti mód-választó adja. */}
            {isAgentTyping ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={stopPending}
                title="Az agent leállítása — az eddigi részeredmény megmarad"
                className="shrink-0 rounded-xl border border-coral bg-card px-4 py-2.5 text-sm font-semibold text-coral shadow-[0_8px_20px_-10px_rgba(178,58,85,0.35)] transition-transform hover:-translate-y-0.5 hover:bg-coral/10 disabled:opacity-50"
              >
                {stopPending ? 'Megállítás…' : 'Megállítás'}
              </button>
            ) : composerMode === 'task' ? (
              <button
                type="button"
                onClick={handleCreateTicket}
                disabled={!canSubmit}
                title={
                  ticketExecuteAfter
                    ? 'Ütemezett feladat létrehozása'
                    : 'Feladat létrehozása a Kanban táblán'
                }
                className="shrink-0 rounded-xl bg-honey px-4 py-2.5 text-sm font-semibold text-card shadow-[0_8px_20px_-10px_rgba(176,125,36,0.8)] transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                {ticketPending ? '…' : ticketExecuteAfter ? 'Ütemezés' : 'Feladat létrehozása'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSubmit}
                title="Üzenet küldése (Enter)"
                className="shrink-0 rounded-xl bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_8px_20px_-10px_rgba(178,58,85,0.8)] transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                {pending ? '…' : 'Küldés'}
              </button>
            )}
          </div>

          <p className="mt-1.5 px-1 text-[11px] text-ink-faint">
            Enter küld · Shift+Enter új sor
            {agentSkills.length > 0 ? ' · / jellel skillt indítasz' : ''}
          </p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    tileTarget ?? document.body,
  )
}

export function AgentChatButton({
  agent,
  className = '',
  compact = false,
  label = '💬 Beszélgetés',
  canDistillSkill = false,
  initialConversationId = null,
  autoOpen = false,
  resumeAfterGrant = false,
}: {
  agent: ChatAgent
  className?: string
  compact?: boolean
  label?: string
  canDistillSkill?: boolean
  initialConversationId?: string | null
  autoOpen?: boolean
  resumeAfterGrant?: boolean
}) {
  useEffect(() => {
    if (!autoOpen) return
    openAgentChat({
      agent,
      canDistillSkill,
      initialConversationId,
      ...(resumeAfterGrant ? { resumeAfterGrant: true } : {}),
    })
    // Szándékos: autoOpen / deep-link változáskor nyissa (vagy hozza elő) a panelt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, agent.id, initialConversationId, canDistillSkill, resumeAfterGrant])

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openAgentChat({
          agent,
          canDistillSkill,
          initialConversationId,
        })
      }}
      className={
        className ||
        (compact
          ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
          : 'rounded-full bg-sage px-4 py-2 text-sm font-semibold text-card shadow-[0_8px_20px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5')
      }
    >
      {label}
    </button>
  )
}
