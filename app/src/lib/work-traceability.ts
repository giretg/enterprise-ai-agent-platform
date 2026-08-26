/**
 * Munka-nyomonkövethetőség (#375): chat ↔ tábla ↔ ticket hivatkozások,
 * folyamat-lépés beolvasztás, emlékezet-csík és feladat-eligazítás.
 * Tiszta, DB nélküli nézetmodell — a kártya ugyanabból a Ticket sorból él, mint a tábla.
 */
import { DEFAULT_CONTEXT_RECENCY_MESSAGES } from '@/domain/conversation/context-assembly'
import { formatRelativeTicketTime } from '@/lib/ticket-display'
import { TICKET_STATE_LABELS } from '@/lib/ticket-labels'
import { agentWorkspacePath } from '@/lib/agent-workspace-routes'

/** Kompakt állapot a chat-kártyán és az „Ebből lett” soron. */
export const TICKET_STATE_COMPACT: Record<string, string> = {
  backlog: 'Sorban',
  ready: 'Készül',
  in_progress: 'Fut',
  awaiting_human: 'Rád vár',
  needs_info: 'Pontosítás',
  approved: 'Jóváhagyva',
  done: 'Kész',
  rejected: 'Visszadobva',
}

/** Ha egy folyamat-csoportban több állapot van, a tábla ezen a sorrenden mutatja a kártyát. */
const BOARD_ATTENTION_RANK: Record<string, number> = {
  awaiting_human: 0,
  needs_info: 1,
  in_progress: 2,
  ready: 3,
  approved: 4,
  backlog: 5,
  rejected: 6,
  done: 7,
}

export function compactTicketStateLabel(state: string): string {
  return TICKET_STATE_COMPACT[state] ?? TICKET_STATE_LABELS[state] ?? state
}

/** Rövid, olvasható feladat-jelölő — sequential szám nincs a sémában. */
export function formatTicketShortRef(ticketId: string): string {
  const hex = ticketId.replace(/-/g, '')
  return `#${hex.slice(0, 8)}`
}

export function conversationOriginHref(input: {
  agentId: string | null
  conversationId: string
  messageId?: string | null
}): string | null {
  if (!input.agentId) return null
  const params = new URLSearchParams()
  params.set('conversation', input.conversationId)
  if (input.messageId) params.set('message', input.messageId)
  return `${agentWorkspacePath(input.agentId, 'chat')}?${params.toString()}`
}

export function formatOriginWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleString('hu-HU', {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type TicketOriginView = {
  conversationId: string
  messageId: string | null
  agentId: string | null
  agentNickname: string
  conversationTitle: string | null
  at: string
  href: string | null
}

export function formatOriginLabel(origin: TicketOriginView, now: Date = new Date()): string {
  const when = formatOriginWhen(origin.at, now)
  const title = origin.conversationTitle?.trim()
  if (title) return `Eredet: ${origin.agentNickname} · „${title}” · ${when}`
  return `Eredet: ${origin.agentNickname} · ${when}`
}

export function formatBecameLabel(input: { ticketId: string; state: string }): string {
  return `Ebből lett: ${formatTicketShortRef(input.ticketId)} ● ${compactTicketStateLabel(input.state)}`
}

export type ChatTaskCardView = {
  ticketId: string
  shortRef: string
  title: string
  state: string
  stateLabel: string
  live: boolean
  stepsDone: number | null
  stepsTotal: number | null
  elapsedLabel: string | null
  assigneeLabel: string
  href: string
  briefingPending: boolean
}

export type ProcessStepMeta = {
  ticketId: string | null
  stepId: string
  stepName: string
  status: string
}

export type ProcessRunMeta = {
  rootTicketId: string | null
  steps: ProcessStepMeta[]
}

export type NestedProcessStepView = {
  ticketId: string | null
  title: string
  stepName: string
  state: string
  stateLabel: string
}

const LIVE_TICKET_STATES = new Set(['in_progress', 'awaiting_human', 'needs_info'])

export function isLiveTicketState(state: string): boolean {
  return LIVE_TICKET_STATES.has(state)
}

export function buildChatTaskCardView(input: {
  ticketId: string
  title: string
  state: string
  assigneeLabel: string
  createdAt: Date | string
  lockedAt?: Date | string | null
  stepsDone?: number | null
  stepsTotal?: number | null
  briefingPending?: boolean
  now?: Date
}): ChatTaskCardView {
  const live = isLiveTicketState(input.state)
  const elapsedFrom = input.lockedAt ?? input.createdAt
  return {
    ticketId: input.ticketId,
    shortRef: formatTicketShortRef(input.ticketId),
    title: input.title,
    state: input.state,
    stateLabel: compactTicketStateLabel(input.state),
    live,
    stepsDone: input.stepsDone ?? null,
    stepsTotal: input.stepsTotal ?? null,
    elapsedLabel: live ? formatRelativeTicketTime(elapsedFrom, input.now) : null,
    assigneeLabel: input.assigneeLabel,
    href: `/control-plane/tickets/${input.ticketId}`,
    briefingPending: input.briefingPending === true,
  }
}

export function formatChatTaskCardMeta(card: ChatTaskCardView): string {
  const parts: string[] = []
  if (card.stepsTotal != null && card.stepsTotal > 0) {
    parts.push(`${card.stepsDone ?? 0}/${card.stepsTotal} lépés`)
  }
  if (card.elapsedLabel) parts.push(card.elapsedLabel)
  if (card.assigneeLabel) parts.push(card.assigneeLabel)
  return parts.join(' · ')
}

const PROCESS_STEP_STATUS_TO_TICKET: Record<string, string> = {
  pending: 'backlog',
  ready: 'ready',
  in_progress: 'in_progress',
  awaiting_gate: 'awaiting_human',
  completed: 'done',
  skipped: 'done',
  failed: 'rejected',
}

export function processStepStatusToTicketState(status: string): string {
  return PROCESS_STEP_STATUS_TO_TICKET[status] ?? status
}

export function processRunProgress(meta: ProcessRunMeta | undefined): {
  done: number
  total: number
} | null {
  if (!meta || meta.steps.length === 0) return null
  const done = meta.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  ).length
  return { done, total: meta.steps.length }
}

export function buildTicketOriginView(input: {
  conversationId: string
  messageId: string | null
  agentId: string | null
  agentNickname: string
  conversationTitle: string | null
  at: Date | string
}): TicketOriginView {
  const at = typeof input.at === 'string' ? input.at : input.at.toISOString()
  return {
    conversationId: input.conversationId,
    messageId: input.messageId,
    agentId: input.agentId,
    agentNickname: input.agentNickname,
    conversationTitle: input.conversationTitle,
    at,
    href: conversationOriginHref({
      agentId: input.agentId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    }),
  }
}

export function pickBoardColumnState(states: string[]): string {
  if (states.length === 0) return 'backlog'
  return [...states].sort(
    (a, b) => (BOARD_ATTENTION_RANK[a] ?? 50) - (BOARD_ATTENTION_RANK[b] ?? 50),
  )[0]
}

export type NestableBoardTicket = {
  id: string
  title: string
  state: string
  processInstanceId: string | null
  playbookStepId?: string | null
  createdAt: Date | string
}

export type NestedBoardTicket<T extends NestableBoardTicket> = T & {
  nestedSteps: NestedProcessStepView[]
  stepsDone: number | null
  stepsTotal: number | null
  boardColumnState: string
  hiddenAsProcessChild: boolean
}

function asTime(value: Date | string): number {
  return new Date(value).getTime()
}

/**
 * Folyamat-lépés ticketek beolvadnak a szülő futás kártyájába.
 * A kártya oszlopa a csoport „legfigyelmeztetőbb” állapota — emberi kapu ne tűnjön el.
 */
export function nestProcessRunTickets<T extends NestableBoardTicket>(
  tickets: T[],
  processRuns: Map<string, ProcessRunMeta>,
): Array<NestedBoardTicket<T>> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const grouped = new Map<string, T[]>()
  const standalone: T[] = []

  for (const ticket of tickets) {
    if (!ticket.processInstanceId) {
      standalone.push(ticket)
      continue
    }
    const list = grouped.get(ticket.processInstanceId) ?? []
    list.push(ticket)
    grouped.set(ticket.processInstanceId, list)
  }

  const result: Array<NestedBoardTicket<T>> = []
  const hidden = new Set<string>()

  for (const [processId, group] of grouped) {
    const meta = processRuns.get(processId)
    const parent =
      (meta?.rootTicketId ? group.find((ticket) => ticket.id === meta.rootTicketId) : undefined) ??
      group.find((ticket) => !ticket.playbookStepId) ??
      [...group].sort((a, b) => asTime(a.createdAt) - asTime(b.createdAt))[0]

    const nestedSteps: NestedProcessStepView[] =
      meta && meta.steps.length > 0
        ? meta.steps.map((step) => {
            const bound = step.ticketId ? byId.get(step.ticketId) : undefined
            const state = bound
              ? bound.state
              : processStepStatusToTicketState(step.status)
            return {
              ticketId: step.ticketId,
              title: bound?.title ?? step.stepName,
              stepName: step.stepName,
              state,
              stateLabel: compactTicketStateLabel(state),
            }
          })
        : group
            .filter((ticket) => ticket.id !== parent.id)
            .sort((a, b) => asTime(a.createdAt) - asTime(b.createdAt))
            .map((ticket) => ({
              ticketId: ticket.id,
              title: ticket.title,
              stepName: ticket.title,
              state: ticket.state,
              stateLabel: compactTicketStateLabel(ticket.state),
            }))

    const stepStates = nestedSteps.map((step) => step.state)
    const boardColumnState = pickBoardColumnState([parent.state, ...stepStates])
    const completed = nestedSteps.filter((step) =>
      ['done', 'rejected'].includes(step.state),
    ).length
    const stepsTotal = nestedSteps.length > 0 ? nestedSteps.length : null
    const stepsDone = stepsTotal == null ? null : completed

    for (const ticket of group) {
      if (ticket.id === parent.id) continue
      hidden.add(ticket.id)
      result.push({
        ...ticket,
        nestedSteps: [],
        stepsDone: null,
        stepsTotal: null,
        boardColumnState: ticket.state,
        hiddenAsProcessChild: true,
      })
    }

    result.push({
      ...parent,
      nestedSteps,
      stepsDone,
      stepsTotal,
      boardColumnState,
      hiddenAsProcessChild: false,
    })
  }

  for (const ticket of standalone) {
    if (hidden.has(ticket.id)) continue
    result.push({
      ...ticket,
      nestedSteps: [],
      stepsDone: null,
      stepsTotal: null,
      boardColumnState: ticket.state,
      hiddenAsProcessChild: false,
    })
  }

  return result
}

export function visibleBoardTickets<T extends { hiddenAsProcessChild: boolean }>(
  tickets: T[],
): T[] {
  return tickets.filter((ticket) => !ticket.hiddenAsProcessChild)
}

export type TaskBriefing = {
  goal: string
  source: string
  constraint: string
  approval: string
}

export function assembleTaskBriefingDraft(input: {
  userText: string
  attachmentNames?: string[]
  processName?: string | null
  skillNames?: string[]
  authorizeRunAs?: boolean
}): TaskBriefing {
  const goal = input.userText.replace(/\s+/g, ' ').trim()
  const files = (input.attachmentNames ?? []).map((name) => name.trim()).filter(Boolean)
  const sourceParts: string[] = []
  if (input.processName?.trim()) sourceParts.push(`folyamat: ${input.processName.trim()}`)
  if (input.skillNames && input.skillNames.length > 0) {
    sourceParts.push(`skill: ${input.skillNames.join(', ')}`)
  }
  if (files.length > 0) sourceParts.push(files.join(', '))
  return {
    goal: goal || 'A beszélgetésben kért feladat',
    source: sourceParts.join(' · '),
    constraint: '',
    approval: input.authorizeRunAs
      ? 'ismétlődő futáskor a feladó nevében dolgozhat'
      : 'a feladó nevében fut',
  }
}

/** A Forrás mezőt csak akkor mutatjuk, ha van mit vinni (fájl, folyamat, skill). */
export function briefingHasSource(source: string | null | undefined): boolean {
  const value = source?.trim() ?? ''
  return value.length > 0 && value !== '—'
}

export function briefingFromPayload(payload: unknown): TaskBriefing | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const raw = (payload as Record<string, unknown>).briefing
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const goal = typeof record.goal === 'string' ? record.goal : ''
  const source = typeof record.source === 'string' ? record.source : ''
  const constraint = typeof record.constraint === 'string' ? record.constraint : ''
  const approval = typeof record.approval === 'string' ? record.approval : ''
  if (!goal && !source && !constraint && !approval) return null
  return { goal, source, constraint, approval }
}

export function briefingToPayloadValue(briefing: TaskBriefing): Record<string, string> {
  return {
    goal: briefing.goal.trim(),
    source: briefing.source.trim(),
    constraint: briefing.constraint.trim(),
    approval: briefing.approval.trim(),
    confirmedAt: new Date().toISOString(),
  }
}

export function isBriefingPending(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  return (payload as Record<string, unknown>).briefingPending === true
}

export type MemoryStripView = {
  agentNickname: string
  conversationMessageCount: number
  includedMessageCount: number
  droppedMessageCount: number
  truncated: boolean
  hasProjectMemory: boolean
  openTaskCount: number
  summaryLine: string
  details: {
    conversation: {
      includedCount: number
      droppedCount: number
      droppedReason: 'recency_window' | null
    }
    projectMemory: Array<{ title: string; type: string }>
    openTasks: Array<{ id: string; title: string; state: string }>
    workspaceFiles: string[]
  }
}

export function buildMemoryStripView(input: {
  agentNickname: string
  conversationMessageCount: number
  recencyWindowMessages?: number
  projectMemory: Array<{ title: string; type: string }>
  openTasks: Array<{ id: string; title: string; state: string }>
  workspaceFiles: string[]
}): MemoryStripView {
  const windowSize = Math.max(1, input.recencyWindowMessages ?? DEFAULT_CONTEXT_RECENCY_MESSAGES)
  const droppedMessageCount = Math.max(0, input.conversationMessageCount - windowSize)
  const includedMessageCount = Math.min(input.conversationMessageCount, windowSize)
  const truncated = droppedMessageCount > 0
  const hasProjectMemory = input.projectMemory.length > 0
  const openTaskCount = input.openTasks.length

  const parts: string[] = []
  const conv =
    truncated
      ? `ez a beszélgetés (${includedMessageCount} üzenet, ${droppedMessageCount} korábbi kiesett)`
      : `ez a beszélgetés (${input.conversationMessageCount} üzenet)`
  parts.push(conv)
  if (hasProjectMemory) parts.push('projekt-memória')
  if (openTaskCount === 1) parts.push('1 nyitott feladat')
  else if (openTaskCount > 1) parts.push(`${openTaskCount} nyitott feladat`)

  return {
    agentNickname: input.agentNickname,
    conversationMessageCount: input.conversationMessageCount,
    includedMessageCount,
    droppedMessageCount,
    truncated,
    hasProjectMemory,
    openTaskCount,
    summaryLine: `${input.agentNickname} most erre emlékszik: ${parts.join(' · ')}.`,
    details: {
      conversation: {
        includedCount: includedMessageCount,
        droppedCount: droppedMessageCount,
        droppedReason: truncated ? 'recency_window' : null,
      },
      projectMemory: input.projectMemory,
      openTasks: input.openTasks,
      workspaceFiles: input.workspaceFiles,
    },
  }
}

export const MEMORY_TYPE_LABELS: Record<string, string> = {
  focus: 'Fókusz',
  decision: 'Döntés',
  open_task: 'Nyitott feladat',
  constraint: 'Megkötés',
  artifact: 'Fontos fájl',
  finding: 'Tanulság',
  failed_attempt: 'Sikertelen próba',
  assumption: 'Feltételezés',
  handoff_summary: 'Átadás',
}
