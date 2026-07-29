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
import { getTenantThinkingTraceControls } from '@/app/actions/chat-thinking-trace'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import type { AgentDelegatedConnectorRow } from '@/lib/agent-delegated-connectors'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import {
  removeAgentChatDockEntry,
  upsertAgentChatDockEntry,
} from '@/components/agents/agent-chat-dock-store'
import { openAgentChat } from '@/components/agents/agent-chat-session-store'
import { ChatMarkdown, TypingIndicator } from '@/components/chat/chat-markdown'
import {
  chatMessageShowsAgentActivity,
  mergeTurnProgressIntoMessages,
  type ChatTurnActivity,
} from '@/lib/chat-turn-progress'
import { AGENT_TURN_RECONNECT_POLL_DEFAULT_MS } from '@/domain/agent/agent-turn-reconnect'
import {
  decideChatStreamRecovery,
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
import {
  appendSkillSlashToken,
  filterSkillsForSlashQuery,
  getActiveSlashQuery,
  insertSkillSlashToken,
  skillNameToSlashToken,
} from '@/lib/skill/skill-slash-command'
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

function FieldHelp({ description }: { description: string }) {
  return (
    <details className="group relative inline-flex">
      <summary
        className="flex h-4 w-4 cursor-help list-none items-center justify-center rounded-full border border-line bg-card text-[10px] font-semibold text-ink-faint transition-colors hover:border-coral/40 hover:text-coral-deep"
        aria-label="Mező súgó"
      >
        ?
      </summary>
      <div className="pointer-events-none absolute left-1/2 top-[calc(100%+0.35rem)] z-20 w-56 -translate-x-1/2 rounded-lg border border-line bg-card px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-open:opacity-100">
        {description}
      </div>
    </details>
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
}: {
  activities: AgentActivity[]
  thinking?: Record<string, string>
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

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={`mb-3 rounded-lg border px-3 py-2 text-xs text-ink-soft transition-colors ${
        running
          ? 'border-sky/35 bg-sky/5'
          : 'border-line bg-night-2/70'
      }`}
    >
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3 font-medium text-ink">
          <span className="min-w-0 truncate">
            Agent aktivitás
            {open ? (
              <span className="ml-2 font-normal text-ink-faint">{headerHint}</span>
            ) : null}
          </span>
          <span className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
            {activities.length}
          </span>
        </div>
        {!open && latest ? (
          <div className="mt-2">
            <AgentActivityRow activity={latest} thinking={thinking} prominent />
          </div>
        ) : null}
      </summary>
      {open ? (
        <div className="mt-2 space-y-1.5">
          {activities.map((activity) => (
            <AgentActivityRow
              key={activity.id}
              activity={activity}
              thinking={thinking}
              prominent={activity.status === 'running'}
            />
          ))}
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

function MessageBubble({
  message,
  isBusy,
  onDeleteContent,
  onMemoryCandidateUpdate,
  onConsequenceApprovalUpdate,
  onConsequenceApproved,
}: {
  message: ChatMessage
  isBusy: boolean
  onDeleteContent: (messageId: string) => void
  onMemoryCandidateUpdate: (messageId: string, candidateId: string, patch: Partial<MemoryCandidateCard>) => void
  onConsequenceApprovalUpdate: (
    messageId: string,
    approvalId: string,
    patch: Partial<ConsequenceApprovalCard>,
  ) => void
  onConsequenceApproved: (approvalIds: string[]) => void
}) {
  const isUser = message.role === 'user'
  const isDeleted = Boolean(message.contentDeletedAt)

  return (
    <div className={`flex animate-rise ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`group relative rounded-2xl px-4 py-3 shadow-sm ${
          isDeleted
            ? 'max-w-[85%] border border-dashed border-line bg-night-2 text-ink-faint'
            : isUser
              ? 'max-w-[85%] rounded-br-md bg-coral text-card'
              : 'max-w-[85%] rounded-bl-md border border-line bg-card text-ink-soft lg:max-w-[min(90%,64rem)]'
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
                <ChatMarkdown content={message.text} variant="agent" />
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
        {!isDeleted && !message.id.startsWith('optimistic-') && (
          <button
            type="button"
            onClick={() => onDeleteContent(message.id)}
            disabled={isBusy}
            className={`absolute -top-2 ${isUser ? '-left-2' : '-right-2'} rounded-full border border-line bg-card px-2 py-1 text-[10px] font-semibold text-ink-faint opacity-0 pointer-events-none shadow-sm transition-opacity hover:text-coral-deep group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 disabled:opacity-40`}
            title="Üzenettartalom törlése"
            aria-label="Üzenettartalom törlése"
          >
            Törlés
          </button>
        )}
        {message.ticketRefId && (
          <Link
            href={`/control-plane/tickets/${message.ticketRefId}`}
            className={`mt-2 inline-flex text-[11px] font-semibold hover:underline ${
              isUser ? 'text-card' : 'text-coral'
            }`}
          >
            {message.text.includes('Futás elindítva a(z)')
              ? 'Belépő ticket megnyitása →'
              : 'Ticket megnyitása →'}
          </Link>
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
  restoreSignal = 0,
}: {
  agent: ChatAgent
  open: boolean
  onClose: () => void
  /** Admin: D14 skill-desztilláció a beszélgetésből (skill-catalog-spec §WP-6). */
  canDistillSkill?: boolean
  /** Deep-link / Aktív futások: nyitáskor ezt a beszélgetést tölti be + reattach. */
  initialConversationId?: string | null
  /** Növekvő jel: újboli megnyitáskor leveszi a tálcáról. */
  restoreSignal?: number
}) {
  const persona = personaFor(agent.name, agent)
  const dockId = useId()
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
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
  const [chatProcessDefs, setChatProcessDefs] = useState<ChatProcessDefinition[]>([])
  const [selectedProcessDefId, setSelectedProcessDefId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [ticketPending, startTicketTransition] = useTransition()
  const [archivePending, startArchiveTransition] = useTransition()
  const [distillPending, startDistillTransition] = useTransition()
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [distillTargetSkillId, setDistillTargetSkillId] = useState<string>('')
  const [distillTargets, setDistillTargets] = useState<Array<{ id: string; name: string }>>([])
  const [agentSkills, setAgentSkills] = useState<ChatSkillOption[]>([])
  const [inputCursor, setInputCursor] = useState(0)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
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
  const startAgentTurnRef = useRef<
    | ((options: {
        text: string
        attachments: PendingAttachment[]
        userBubbleText?: string
        consequenceApprovalIds?: string[]
      }) => void)
    | null
  >(null)
  const [mounted, setMounted] = useState(false)
  const [minimized, setMinimized] = useState(false)
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
    // Tálcán (minimized) a háttéroldal görgethető maradjon — lock csak nyitott ablaknál.
    if (!open || minimized) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [open, minimized])

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

  const slashContext = useMemo(
    () => getActiveSlashQuery(input, inputCursor),
    [input, inputCursor],
  )
  const slashSkillOptions = useMemo(
    () => (slashContext ? filterSkillsForSlashQuery(agentSkills, slashContext.query) : []),
    [agentSkills, slashContext],
  )

  const applySkillSlashSelection = useCallback(
    (skill: ChatSkillOption) => {
      if (!slashContext) return
      const next = insertSkillSlashToken({
        text: input,
        cursorPos: inputCursor,
        slashStart: slashContext.start,
        token: skillNameToSlashToken(skill.name),
      })
      setInput(next.text)
      setInputCursor(next.cursorPos)
      setSlashSelectedIndex(0)
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(next.cursorPos, next.cursorPos)
      })
    },
    [input, inputCursor, slashContext],
  )

  const insertSkillFromPicker = useCallback(
    (skill: ChatSkillOption) => {
      const next = appendSkillSlashToken({
        text: input,
        cursorPos: inputCursor,
        token: skillNameToSlashToken(skill.name),
      })
      setInput(next.text)
      setInputCursor(next.cursorPos)
      setSlashSelectedIndex(0)
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(next.cursorPos, next.cursorPos)
      })
    },
    [input, inputCursor],
  )

  const syncInputCursor = useCallback((target: HTMLTextAreaElement) => {
    setInputCursor(target.selectionStart ?? 0)
  }, [])
  const composerDisabled = controlsBusy || conversationStatus === 'archived'
  const slashMenuOpen = !composerDisabled && slashContext !== null

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
        setMessages(
          attachPendingConsequenceApprovals(
            refreshed.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
            refreshed.data.pendingConsequenceApprovals?.map((a) => ({
              ...a,
              status: 'pending' as const,
            })),
          ),
        )
      }
      if ('ticketId' in res.data) {
        setLastTicketId(res.data.ticketId)
        setStatusMessage('A ticket elkészült és belinkeltem a beszélgetésbe.')
      } else {
        setStatusMessage('Az AI visszakérdezett a ticket létrehozása előtt.')
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
      setMessages(
        attachPendingConsequenceApprovals(
          res.data.messages.map((m) => ({
            ...m,
            createdAt: new Date(m.createdAt).toISOString(),
          })),
          res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
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
      setSessionsOpen(false)
      setSelectedProcessDefId(null)
      setConversationStatus(sessions.find((session) => session.id === id)?.status ?? 'active')

      const res = await loadAgentChatMessages({ conversationId: id, agentId: agent.id })
      if (res.success) {
        setConversationStatus(res.data.conversation.status)
        setMessages(
          attachPendingConsequenceApprovals(
            res.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
            res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
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
          }),
        })

        // Aktív-forduló ütközés (D7): a beszélgetésen már fut egy válasz. Nem
        // néma hiba — a szerver az aktív forduló azonosítóját is visszaadja; a
        // Aktív forduló ütközés: reattach az activeTurnId-re, ne új küldés.
        if (response.status === 409) {
          removeFailedOptimisticMessages()
          let activeTurnIdFromConflict: string | null = null
          let conflictConversationId = conversationId
          try {
            const body = (await response.json()) as {
              activeTurnId?: string | null
              conversationId?: string
            }
            activeTurnIdFromConflict = body.activeTurnId ?? null
            conflictConversationId = body.conversationId ?? conversationId
          } catch {
            // ignore
          }
          if (conflictConversationId) {
            setConversationId(conflictConversationId)
            const attached = await reattachToConversation(conflictConversationId)
            if (attached) {
              setStatusMessage('Már fut egy válasz — visszacsatlakoztál hozzá.')
              return
            }
          }
          setStatusMessage(
            activeTurnIdFromConflict
              ? 'Ebben a beszélgetésben már készül egy válasz. Próbáld újra a megnyitást, vagy állítsd le.'
              : 'Ebben a beszélgetésben már készül egy válasz. Várd meg, amíg elkészül, vagy állítsd le a Stop gombbal.',
          )
          setIsAgentTyping(false)
          return
        }

        if (!response.ok || !response.body) {
          removeFailedOptimisticMessages()
          setStatusMessage(
            options.consequenceApprovalIds?.length
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
              ? 'Ütemezett task létrehozva — a worker a megadott időpontban ticketet készít belőle.'
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
        setStatusMessage('Ticket létrehozva — megjelenik a Kanban táblán.')
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : 'Ticket létrehozás sikertelen')
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen && slashSkillOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.min(index + 1, slashSkillOptions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.max(index - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const skill = slashSkillOptions[slashSelectedIndex]
        if (skill) applySkillSlashSelection(skill)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!open || !mounted) return null

  return createPortal(
    <div
      className={`fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-6 lg:p-4 ${
        minimized ? 'pointer-events-none invisible' : ''
      }`}
      aria-hidden={minimized}
      {...(minimized ? { inert: true } : {})}
    >
      <button
        type="button"
        aria-label="Bezárás"
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
        onClick={onClose}
        tabIndex={minimized ? -1 : undefined}
      />

      <div
        role="dialog"
        aria-modal={!minimized}
        aria-labelledby="agent-chat-title"
        className="relative z-[1] flex h-[100dvh] w-full flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(calc(100dvh-3rem),calc(100vh-3rem))] sm:max-w-[min(calc(100vw-3rem),100rem)] sm:rounded-2xl lg:h-[min(calc(100dvh-2rem),calc(100vh-2rem))] lg:max-w-[min(calc(100vw-2rem),120rem)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => setSessionsOpen((v) => !v)}
            className="rounded-xl border border-line px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep sm:hidden"
            aria-expanded={sessionsOpen}
          >
            Előzmények
          </button>
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="sm"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
          />
          <div className="min-w-0 flex-1">
            <h2 id="agent-chat-title" className="truncate font-display text-lg font-semibold">
              {persona.nickname}
            </h2>
            {conversationId ? (
              <p className="truncate text-xs text-ink-faint">
                <span className="rounded-full border border-line px-2 py-0.5">
                  {conversationStatus === 'archived' ? 'archivált szál' : 'aktív szál'}
                </span>
              </p>
            ) : null}
            {connectableUserConnectorsLoading ? (
              <p className="mt-2 text-[11px] text-ink-faint">Kapcsolatok betöltése…</p>
            ) : connectableUserConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={connectableUserConnectors} variant="compact" />
            ) : null}
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {conversationId && (
              <>
                <button
                  type="button"
                  onClick={handlePromoteConversation}
                  disabled={controlsBusy || conversationStatus === 'archived'}
                  className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
                  title="AI ticket készítése a beszélgetésből"
                >
                  {ticketPending ? 'Elemzés…' : 'Ticket készítése'}
                </button>
                {canDistillSkill && (
                  <>
                    {distillTargets.length > 0 && (
                      <select
                        value={distillTargetSkillId}
                        onChange={(e) => setDistillTargetSkillId(e.target.value)}
                        disabled={controlsBusy}
                        className="max-w-[10rem] rounded-xl border border-line bg-card px-2 py-1.5 text-xs text-ink-soft disabled:opacity-40"
                        title="Desztillálás célja: új skill, vagy az agenthez rendelt skill új verziója"
                      >
                        <option value="">Új skill</option>
                        {distillTargets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} (új verzió)
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      onClick={handleDistillSkill}
                      disabled={controlsBusy || messages.length === 0}
                      className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-sage/50 hover:bg-sage/10 hover:text-sage disabled:opacity-40"
                      title="Skill draft készítése a beszélgetés módszeréből (proposed — jóváhagyás kell)"
                    >
                      {distillPending ? 'Desztillálás…' : 'Skill desztillálása'}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportDebugLog}
                      disabled={controlsBusy}
                      className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
                      title="Teljes beszélgetés-telemetria letöltése elemzéshez (üzenetek, fordulók, model/tool, audit)"
                    >
                      {debugLogPending ? 'Log…' : 'Debug-log'}
                    </button>
                  </>
                )}
                {conversationStatus !== 'archived' && (
                  <button
                    type="button"
                    onClick={handleArchiveConversation}
                    disabled={controlsBusy || ticketPending || archivePending}
                    className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:bg-coral/10 hover:text-coral-deep disabled:opacity-40"
                    title="Beszélgetés archiválása"
                  >
                    {archivePending ? 'Archiválás…' : 'Archiválás'}
                  </button>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
            aria-label="Beszélgetés tálcára rakása"
            title="Tálcára rakás"
          >
            −
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
            aria-label="Beszélgetés bezárása"
          >
            ✕
          </button>
        </header>

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
              {messages.length === 0 && !isAgentTyping ? (
                <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center">
                  <span className="text-4xl" aria-hidden>
                    {persona.emoji}
                  </span>
                  <p className="mt-4 max-w-sm text-base text-ink-soft">{persona.greeting}</p>
                  <p className="mt-2 text-xs text-ink-faint">
                    Írj üzenetet, csatolj fájlt vagy képet — {persona.nickname} válaszol.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isBusy={controlsBusy}
                      onDeleteContent={handleDeleteMessageContent}
                      onMemoryCandidateUpdate={handleMemoryCandidateUpdate}
                      onConsequenceApprovalUpdate={handleConsequenceApprovalUpdate}
                      onConsequenceApproved={handleConsequenceApproved}
                    />
                  ))}
                  {isAgentTyping &&
                    !messages[messages.length - 1]?.text &&
                    !chatMessageShowsAgentActivity(messages[messages.length - 1]) && (
                    <TypingIndicator agentName={persona.nickname} />
                  )}
                </div>
              )}
            </div>

            {conversationId && (
              <ConversationFilesPanel
                conversationId={conversationId}
                panelRef={filesRef}
              />
            )}

            <div className="shrink-0 border-t border-line bg-night/40 px-4 py-3 sm:px-5 sm:py-4">
              {conversationStatus === 'archived' && (
                <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
                  Archivált szál: olvasható, új üzenet nem fűzhető hozzá.
                </p>
              )}
              {chatProcessDefs.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                  <label className="flex min-w-[13rem] flex-1 items-center gap-2">
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      Folyamat indítása
                      <FieldHelp description="Ha kiválasztasz egy folyamatot, a következő üzenet nem sima chat válasz lesz, hanem ezt a folyamatot indítja el." />
                    </span>
                    <select
                      value={selectedProcessDefId ?? ''}
                      onChange={(e) => setSelectedProcessDefId(e.target.value || null)}
                      disabled={composerDisabled}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                    >
                      <option value="">— nincs —</option>
                      {chatProcessDefs.map((def) => (
                        <option key={def.id} value={def.id}>
                          {def.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {selectedProcessDefId && (
                <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
                  {(() => {
                    const def = chatProcessDefs.find((d) => d.id === selectedProcessDefId)
                    const requiredSlots = def?.slots.filter((slot) => slot.required) ?? []
                    if (requiredSlots.length === 0) {
                      return 'A kiválasztott Folyamat indul a következő üzeneteddel.'
                    }
                    return `Add meg üzenetben: ${requiredSlots
                      .map((slot) => slot.description ? `${slot.name} (${slot.description})` : slot.name)
                      .join(', ')}`
                  })()}
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
                    className="font-semibold text-coral hover:underline"
                  >
                    Ticket megnyitása →
                  </Link>
                </>
              )}
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
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-1 top-1 rounded-full bg-ink/60 px-1.5 py-0.5 text-[10px] text-card opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Csatolmány eltávolítása"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <label className="flex min-w-[10rem] items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                Skill
                <FieldHelp description="Skill kiválasztásával a /skill-név token bekerül az üzenetbe — ugyanúgy, mintha / -tel írtad volna be." />
              </span>
              <select
                value=""
                onChange={(e) => {
                  const versionId = e.target.value
                  if (!versionId) return
                  const skill = agentSkills.find((s) => s.skillVersionId === versionId)
                  if (skill) insertSkillFromPicker(skill)
                }}
                disabled={composerDisabled || agentSkills.length === 0}
                className="min-w-[9rem] max-w-[14rem] rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                aria-label="Skill beszúrása"
              >
                <option value="">
                  {agentSkills.length === 0 ? 'Nincs skill' : 'Válassz…'}
                </option>
                {agentSkills.map((skill) => (
                  <option key={skill.skillVersionId} value={skill.skillVersionId}>
                    /{skillNameToSlashToken(skill.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[13rem] flex-1 items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                Ütemezés
                <FieldHelp description="Időpont megadásával az üzenetből azonnali küldés helyett ütemezett task lesz." />
              </span>
              <input
                type="datetime-local"
                value={ticketExecuteAfter}
                onChange={(e) => setTicketExecuteAfter(e.target.value)}
                disabled={composerDisabled}
                className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
              />
            </label>
            {ticketExecuteAfter && (
              <>
                <label className="flex items-center gap-2">
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    Ismétlés
                    <FieldHelp description="Megadja, hogy az ütemezett task egyszer fusson vagy ismétlődjön napi/heti/havi ritmusban." />
                  </span>
                  <select
                    value={ticketRecurrence}
                    onChange={(e) => setTicketRecurrence(e.target.value as ScheduledTaskRecurrence)}
                    disabled={composerDisabled}
                    className="rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                  >
                    <option value="none">nincs</option>
                    <option value="daily">naponta</option>
                    <option value="weekly">hetente</option>
                    <option value="monthly">havonta</option>
                  </select>
                </label>
                {ticketRecurrence !== 'none' && (
                  <label className="flex items-center gap-2">
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      Max
                      <FieldHelp description="Az ismétlődő ütemezés legfeljebb ennyi alkalommal fut le, utána leáll." />
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={ticketMaxRuns}
                      onChange={(e) => setTicketMaxRuns(e.target.value)}
                      disabled={composerDisabled}
                      className="w-20 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                    />
                  </label>
                )}
              </>
            )}
            <label className="flex items-center gap-2 rounded-lg border border-line bg-night-2 px-2 py-1.5">
              <input
                type="checkbox"
                checked={ticketAuthorizeRunAs}
                onChange={(e) => setTicketAuthorizeRunAs(e.target.checked)}
                disabled={composerDisabled}
                className="h-3.5 w-3.5 accent-coral"
              />
              <span className="inline-flex items-center gap-1.5">
                Run-as
                <FieldHelp description="Engedélyezi, hogy a ticket végrehajtásakor a rendszer a nevedben futtathasson jogosultságot igénylő lépéseket." />
              </span>
            </label>
          </div>

          <div className="relative flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm focus-within:border-coral/40 focus-within:ring-2 focus-within:ring-coral/15">
            {slashMenuOpen && (
              <div
                role="listbox"
                aria-label="Skill slash-parancsok"
                className="absolute bottom-full left-12 z-20 mb-1 max-h-48 w-72 overflow-y-auto rounded-xl border border-line bg-card py-1 shadow-lg"
              >
                {agentSkills.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">
                    Ehhez az agenthez nincs engedélyezett skill hozzárendelve.
                  </p>
                ) : slashSkillOptions.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">Nincs illeszkedő skill.</p>
                ) : (
                  slashSkillOptions.map((skill, index) => (
                    <button
                      key={skill.skillVersionId}
                      type="button"
                      role="option"
                      aria-selected={index === slashSelectedIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySkillSlashSelection(skill)}
                      className={`flex w-full flex-col px-3 py-2 text-left text-xs transition-colors ${
                        index === slashSelectedIndex
                          ? 'bg-coral/10 text-coral-deep'
                          : 'hover:bg-night-2'
                      }`}
                    >
                      <span className="font-semibold">/{skillNameToSlashToken(skill.name)}</span>
                      <span className="line-clamp-2 text-ink-faint">{skill.description}</span>
                    </button>
                  ))
                )}
              </div>
            )}
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
                syncInputCursor(e.target)
                setSlashSelectedIndex(0)
              }}
              onSelect={(e) => syncInputCursor(e.currentTarget)}
              onClick={(e) => syncInputCursor(e.currentTarget)}
              onKeyUp={(e) => syncInputCursor(e.currentTarget)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={`Üzenet ${persona.nickname}-nak… (/ a skill betöltéséhez)`}
              disabled={composerDisabled}
              className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />
            <FieldHelp description="Ide írd az üzenetet. / megnyomására skill választható — a kiválasztott skill a küldéskor bekerül a promptba. Enter küld, Shift+Enter új sor." />

            <button
              type="button"
              onClick={handleCreateTicket}
              disabled={!canSubmit}
              title={ticketExecuteAfter ? 'Ütemezett task létrehozása' : 'Ticket létrehozása a Kanban táblán'}
              className="shrink-0 rounded-xl border border-line px-3 py-2.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
            >
              {ticketPending ? '…' : ticketExecuteAfter ? 'Ütemezés' : 'Ticket'}
            </button>

            {isAgentTyping ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={stopPending}
                className="shrink-0 rounded-xl border border-coral bg-card px-4 py-2.5 text-sm font-semibold text-coral shadow-[0_8px_20px_-10px_rgba(178,58,85,0.35)] transition-transform hover:-translate-y-0.5 hover:bg-coral/10 disabled:opacity-50"
              >
                {stopPending ? 'Megállítás…' : 'Megállítás'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSubmit}
                className="shrink-0 rounded-xl bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_8px_20px_-10px_rgba(178,58,85,0.8)] transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                {pending ? '…' : 'Küldés'}
              </button>
            )}
          </div>

          <p className="mt-2 text-center text-[11px] text-ink-faint">
            Enter küld · Shift+Enter új sor · /skill-név = skill betöltése a promptba
          </p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AgentChatButton({
  agent,
  className = '',
  compact = false,
  canDistillSkill = false,
  initialConversationId = null,
  autoOpen = false,
}: {
  agent: ChatAgent
  className?: string
  compact?: boolean
  canDistillSkill?: boolean
  initialConversationId?: string | null
  autoOpen?: boolean
}) {
  useEffect(() => {
    if (!autoOpen) return
    openAgentChat({
      agent,
      canDistillSkill,
      initialConversationId,
    })
    // Szándékos: autoOpen / deep-link változáskor nyissa (vagy hozza elő) a panelt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, agent.id, initialConversationId, canDistillSkill])

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
      💬 {compact ? 'Beszél' : 'Beszélgetés'}
    </button>
  )
}
