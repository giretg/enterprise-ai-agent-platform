/**
 * Tartós, verziózott chat-forduló bemenet (#516 / #508 §4).
 *
 * Az `AgentTurn.input` oszlopba kerül, és ebből rekonstruálja a futtatómag
 * (`AgentChatRuntime.runReservedTurn`) a fordulót egy MÁSIK processzben is.
 * Ami a rekord saját oszlopain van (tenant, agent+verzió, beszélgetés,
 * kezdeményező, user-üzenet), az itt NEM duplikálódik.
 *
 * Titok / token SOHA nem kerül ide: a futtató a saját jogosultságával, a
 * meglévő titokkezelésből olvassa őket. A `modelContextPrefix` privát
 * modellkontextus — a kliensnek szánt snapshot (`GET turns`, reconnect
 * `snapshot` esemény) ezért mezőnként válogat, sosem adja vissza az `input`-ot.
 */
import type { AgentChatSendParams } from './agent-chat-runtime'

export const STORED_TURN_INPUT_VERSION = 1 as const

export type StoredTurnInputV1 = {
  v: typeof STORED_TURN_INPUT_VERSION
  /** A tényleges (már folytatás-prompttá alakított) szöveg — a modellnek szól. */
  content: string
  attachmentDocumentIds: string[]
  projectKey?: string
  processDefinitionId?: string
  processInputPayload?: Record<string, unknown>
  consequenceApprovalContinuation?: boolean
  connectorGrantContinuation?: boolean
  taskBriefing?: AgentChatSendParams['taskBriefing']
  modelContextPrefix?: string | null
}

export class StoredTurnInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoredTurnInputError'
  }
}

export function buildStoredTurnInput(params: AgentChatSendParams): StoredTurnInputV1 {
  return {
    v: STORED_TURN_INPUT_VERSION,
    content: params.content,
    attachmentDocumentIds: params.attachmentDocumentIds ?? [],
    ...(params.projectKey ? { projectKey: params.projectKey } : {}),
    ...(params.processDefinitionId ? { processDefinitionId: params.processDefinitionId } : {}),
    ...(params.processInputPayload ? { processInputPayload: params.processInputPayload } : {}),
    ...(params.consequenceApprovalContinuation ? { consequenceApprovalContinuation: true } : {}),
    ...(params.connectorGrantContinuation ? { connectorGrantContinuation: true } : {}),
    ...(params.taskBriefing ? { taskBriefing: params.taskBriefing } : {}),
    ...(params.modelContextPrefix ? { modelContextPrefix: params.modelContextPrefix } : {}),
  }
}

/**
 * Ismeretlen verzió vagy hiányos adat EGYÉRTELMŰ hiba — nem futhat csendben
 * más kontextussal a feladat (#508 §4).
 */
export function parseStoredTurnInput(raw: unknown): StoredTurnInputV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StoredTurnInputError('A forduló mentett bemenete hiányzik.')
  }
  const input = raw as Record<string, unknown>
  if (input.v !== STORED_TURN_INPUT_VERSION) {
    throw new StoredTurnInputError(
      `Ismeretlen bemeneti verzió: ${String(input.v)} (támogatott: ${STORED_TURN_INPUT_VERSION}).`,
    )
  }
  if (typeof input.content !== 'string') {
    throw new StoredTurnInputError('A forduló mentett bemenetéből hiányzik a szöveg.')
  }
  if (
    !Array.isArray(input.attachmentDocumentIds) ||
    !input.attachmentDocumentIds.every((id) => typeof id === 'string')
  ) {
    throw new StoredTurnInputError('A forduló mentett csatolmány-listája érvénytelen.')
  }
  return input as StoredTurnInputV1
}
