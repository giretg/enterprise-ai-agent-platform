import { uploadDocument } from '@/app/actions/platform'
import type { ConnectorGrantNeededView } from '@/components/connectors/connector-grant-needed-panel'
import type {
  AgentActivity,
  ChatMessage,
  ConsequenceApprovalCard,
  MemoryCandidateCard,
} from '@/components/agents/agent-chat-message'

export type PendingAttachment = {
  id: string
  file: File
  previewUrl: string | null
  kind: 'text' | 'image'
}

export type AgentChatStreamEvent =
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
  | {
      type: 'memory_candidate'
      candidate: Omit<MemoryCandidateCard, 'status' | 'resultMessage'>
    }
  | {
      type: 'consequence_approval'
      approval: Omit<ConsequenceApprovalCard, 'status' | 'resultMessage'>
    }
  | {
      type: 'connector_grant_needed'
      grant: { connectorId: string; toolName: string; reason: string; connectorType?: string }
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

/**
 * A chat mindkét stream-útja ugyanazt az SSE framinget használja. Ez a parser
 * kezeli a chunk-határon szétszakadt sorokat és a záró newline nélküli utolsó
 * eseményt is; a fogyasztó csak domain-eseményeket lát.
 */
export async function* readAgentChatEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AgentChatStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exhausted = false

  const parseLine = (line: string): AgentChatStreamEvent | null => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) return null
    try {
      return JSON.parse(trimmed.slice(6)) as AgentChatStreamEvent
    } catch {
      return null
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        exhausted = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseLine(line)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    const finalEvent = parseLine(buffer)
    if (finalEvent) yield finalEvent
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel()
      } catch {
        // A stream közben lezáródhatott; nincs további teendő.
      }
    }
    reader.releaseLock()
  }
}

/** A szerverfordulóhoz tartozó optimista/reconnect buborék stabil azonosítója. */
export function agentBubbleIdForTurn(turnId: string): string {
  return `turn-agent-${turnId}`
}

export function makePendingAttachment(file: File): PendingAttachment {
  const kind = file.type.startsWith('image/') ? 'image' : 'text'
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file,
    kind,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
  }
}

export async function uploadAttachments(files: PendingAttachment[]): Promise<string[]> {
  const ids: string[] = []
  for (const attachment of files) {
    const formData = new FormData()
    formData.set('file', attachment.file)
    const result = await uploadDocument(formData)
    if (!result.success) throw new Error(result.error)
    ids.push(result.data.id)
  }
  return ids
}

export function upsertActivity(
  activities: AgentActivity[] | undefined,
  next: AgentActivity,
): AgentActivity[] {
  const current = activities ?? []
  const index = current.findIndex((activity) => activity.id === next.id)
  if (index < 0) return [...current, next]
  return current.map((activity, itemIndex) =>
    itemIndex === index ? { ...activity, ...next } : activity,
  )
}

export function upsertMemoryCandidate(
  candidates: MemoryCandidateCard[] | undefined,
  next: MemoryCandidateCard,
): MemoryCandidateCard[] {
  const current = candidates ?? []
  const index = current.findIndex((candidate) => candidate.candidateId === next.candidateId)
  if (index < 0) return [...current, next]
  return current.map((candidate, itemIndex) =>
    itemIndex === index ? { ...candidate, ...next } : candidate,
  )
}

export function upsertConsequenceApproval(
  approvals: ConsequenceApprovalCard[] | undefined,
  next: ConsequenceApprovalCard,
): ConsequenceApprovalCard[] {
  const current = approvals ?? []
  const index = current.findIndex((approval) => approval.approvalId === next.approvalId)
  if (index < 0) return [...current, next]
  return current.map((approval, itemIndex) =>
    itemIndex === index ? { ...approval, ...next } : approval,
  )
}

function attachPendingExtras<T>(
  messages: ChatMessage[],
  pending: T[] | undefined,
  key: 'consequenceApprovals' | 'connectorGrants',
): ChatMessage[] {
  if (!pending || pending.length === 0) return messages
  let anchorIndex = messages.findLastIndex((message) => message.role !== 'user')
  if (anchorIndex < 0) anchorIndex = messages.length - 1
  if (anchorIndex < 0) return messages
  return messages.map((message, index) =>
    index === anchorIndex ? { ...message, [key]: pending } : message,
  )
}

export function upsertConnectorGrant(
  cards: ConnectorGrantNeededView[] | undefined,
  next: ConnectorGrantNeededView,
): ConnectorGrantNeededView[] {
  const current = cards ?? []
  const index = current.findIndex(
    (card) => card.connectorId === next.connectorId && card.reason === next.reason,
  )
  if (index < 0) return [...current, next]
  return current.map((card, itemIndex) =>
    itemIndex === index ? { ...card, ...next } : card,
  )
}

export function withPendingChatExtras(
  messages: ChatMessage[],
  pendingApprovals: ConsequenceApprovalCard[] | undefined,
  pendingGrants: ConnectorGrantNeededView[] | undefined,
): ChatMessage[] {
  return attachPendingExtras(
    attachPendingExtras(messages, pendingApprovals, 'consequenceApprovals'),
    pendingGrants,
    'connectorGrants',
  )
}

function stripQueryParameter(name: string): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has(name)) return
  url.searchParams.delete(name)
  const search = url.searchParams.toString()
  window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`)
}

export function stripGrantedQueryFromUrl(): void {
  stripQueryParameter('granted')
}

export function stripPrefillQueryFromUrl(): void {
  stripQueryParameter('prefill')
}
