import type { AuditRepository } from '@/repositories/interfaces'

export const DEFAULT_CONTEXT_RECENCY_MESSAGES = 16
// agent-memory-persistent-cross-conversation-spec.md §10.3 (v2.1 token-budget
// összjáték): a retrieval-alapú memória-blokk (§12.2 default 1200+2500=3700
// token) az üzenetek mellett nem fér el kényelmesen a korábbi 6000-es
// keretben — a memória-rész a saját §12.2 keretén belül marad, ez a teljes,
// egymásba ágyazott felső korlát.
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 10000

export type ContextAssemblyMessage = {
  id: string
  seq: number
  role: string
  content: string | null
  contentDeletedAt: Date | null
  createdAt: Date
}

export type AssembledContext = {
  messages: ContextAssemblyMessage[]
  messageSeqs: number[]
  droppedSeqs: number[]
  skippedDeletedSeqs: number[]
  documentAliases: string[]
  memoryVersion: number | null
  estimatedTokens: number
  budgetTokens: number
  truncated: boolean
}

export function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function estimateMessageTokens(message: ContextAssemblyMessage): number {
  return estimateTextTokens(message.content ?? '') + 4
}

function normalizeDocumentAliases(aliases: string[] = []): string[] {
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

function estimateContextTokens(params: {
  messages: ContextAssemblyMessage[]
  memoryContent?: string | null
  memoryContextTokens?: number
  documentAliases: string[]
}): number {
  const messageTokens = params.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  // §10.3 (v2.1): a retrieval-alapú `Project memory context` blokk tényleges
  // token-becslése (memoryContextTokens) váltja fel a legacy `memoryContent`
  // teljes-szöveg becslését — a hívó ezt adja át, ha retrieval-only módban fut
  // (agent-chat-runtime.ts / general-task-runtime.ts). A `memoryContent` ág
  // csak a nem migrált wiki-runtime.ts-hez marad meg visszafelé kompatibilisen.
  const memoryTokens =
    params.memoryContextTokens !== undefined
      ? Math.max(0, params.memoryContextTokens)
      : params.memoryContent?.trim()
        ? estimateTextTokens(params.memoryContent.trim()) + 8
        : 0
  const documentTokens =
    params.documentAliases.length > 0
      ? estimateTextTokens(params.documentAliases.join('\n')) + params.documentAliases.length
      : 0
  return messageTokens + memoryTokens + documentTokens
}

export async function assembleContext(params: {
  audit: AuditRepository
  conversationId: string
  agentId: string
  agentVersion?: number | null
  actingUserId?: string | null
  messages: ContextAssemblyMessage[]
  memoryVersion: number | null
  memoryContent?: string | null
  memoryContextTokens?: number
  documentAliases?: string[]
  budgetTokens?: number
  recencyWindowMessages?: number
}): Promise<AssembledContext> {
  const budgetTokens = Math.max(1, params.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS)
  const recencyWindowMessages = Math.max(
    1,
    params.recencyWindowMessages ?? DEFAULT_CONTEXT_RECENCY_MESSAGES,
  )
  const documentAliases = normalizeDocumentAliases(params.documentAliases)
  const sortedMessages = [...params.messages].sort((a, b) => a.seq - b.seq)
  const skippedDeletedSeqs = sortedMessages
    .filter((message) => message.contentDeletedAt || !message.content)
    .map((message) => message.seq)
  const eligibleMessages = sortedMessages.filter(
    (message) => message.content && !message.contentDeletedAt,
  )

  const recencyStart = Math.max(0, eligibleMessages.length - recencyWindowMessages)
  const recencyDropped = eligibleMessages.slice(0, recencyStart)
  const recencyMessages = eligibleMessages.slice(recencyStart)
  const fixedTokenEstimate = estimateContextTokens({
    messages: [],
    memoryContent: params.memoryContent,
    memoryContextTokens: params.memoryContextTokens,
    documentAliases,
  })
  const messageBudget = Math.max(1, budgetTokens - fixedTokenEstimate)

  const selectedReversed: ContextAssemblyMessage[] = []
  const budgetDropped: ContextAssemblyMessage[] = []
  let usedMessageTokens = 0

  for (let i = recencyMessages.length - 1; i >= 0; i--) {
    const message = recencyMessages[i]
    const nextTokens = estimateMessageTokens(message)
    if (usedMessageTokens + nextTokens <= messageBudget || selectedReversed.length === 0) {
      selectedReversed.push(message)
      usedMessageTokens += nextTokens
      continue
    }

    budgetDropped.push(...recencyMessages.slice(0, i + 1))
    break
  }

  const selectedMessages = selectedReversed.reverse()
  const droppedSeqs = [...recencyDropped, ...budgetDropped]
    .map((message) => message.seq)
    .sort((a, b) => a - b)
  const estimatedTokens = estimateContextTokens({
    messages: selectedMessages,
    memoryContent: params.memoryContent,
    memoryContextTokens: params.memoryContextTokens,
    documentAliases,
  })

  await params.audit.append({
    actorType: 'agent',
    actorId: params.agentId,
    agentVersion: params.agentVersion ?? null,
    action: 'context.assembled',
    targetType: 'conversation',
    targetId: params.conversationId,
    modelUsed: null,
    inputRef: `seqs:${selectedMessages.map((message) => message.seq).join(',') || 'none'}`,
    outputRef: `tokens:${estimatedTokens}`,
    policyDecision: 'allowed',
    metadata: {
      conversationId: params.conversationId,
      agentId: params.agentId,
      actingUserId: params.actingUserId ?? null,
      messageSeqs: selectedMessages.map((message) => message.seq),
      skippedDeletedSeqs,
      documentAliases,
      memoryVersion: params.memoryVersion,
      estimatedTokens,
      budgetTokens,
      recencyWindowMessages,
    },
  })

  if (droppedSeqs.length > 0 || estimatedTokens > budgetTokens) {
    await params.audit.append({
      actorType: 'agent',
      actorId: params.agentId,
      agentVersion: params.agentVersion ?? null,
      action: 'context.truncated',
      targetType: 'conversation',
      targetId: params.conversationId,
      modelUsed: null,
      inputRef: `budget:${budgetTokens}`,
      outputRef: `dropped:${droppedSeqs.join(',') || 'none'}`,
      policyDecision: 'allowed',
      metadata: {
        conversationId: params.conversationId,
        agentId: params.agentId,
        actingUserId: params.actingUserId ?? null,
        droppedSeqs,
        reason: budgetDropped.length > 0 ? 'budget_tokens' : 'recency_window',
        budgetTokens,
        estimatedTokens,
        documentAliases,
        memoryVersion: params.memoryVersion,
      },
    })
  }

  return {
    messages: selectedMessages,
    messageSeqs: selectedMessages.map((message) => message.seq),
    droppedSeqs,
    skippedDeletedSeqs,
    documentAliases,
    memoryVersion: params.memoryVersion,
    estimatedTokens,
    budgetTokens,
    truncated: droppedSeqs.length > 0 || estimatedTokens > budgetTokens,
  }
}

const MEMORY_QUERY_TOKEN_CAP = 400
const MEMORY_QUERY_RECENT_MESSAGE_COUNT = 5

/**
 * agent-memory-persistent-cross-conversation-spec.md §5.1.1 — a
 * `MemoryRetrievalRequest.query` építése. A `MemoryRetrievalService` pure marad
 * (nem ismeri a chat/task runtime-formátumot); ez a függvény adja a
 * runtime-specifikus lekérdezés-szöveget, ~400 token cap-pel.
 *
 * - chat: utolsó user-üzenet (elsődleges) + max 5 előző üzenet (user+assistant,
 *   tool-payload nélkül), recency-sorrendben.
 * - task: ticket-cím + aktuális step-instrukció + step-input rövid összefoglaló.
 */
export function buildMemoryRetrievalQuery(
  params:
    | {
        queryKind: 'chat'
        latestUserMessage: string
        recentMessages?: ContextAssemblyMessage[]
      }
    | {
        queryKind: 'task'
        ticketTitle: string
        stepInstruction?: string | null
        stepInputSummary?: string | null
      },
): string {
  let raw: string
  if (params.queryKind === 'chat') {
    const recent = (params.recentMessages ?? [])
      .filter((m) => m.content && !m.contentDeletedAt && (m.role === 'user' || m.role === 'agent'))
      .sort((a, b) => a.seq - b.seq)
      .slice(-MEMORY_QUERY_RECENT_MESSAGE_COUNT)
      .map((m) => m.content!.trim())
      .filter(Boolean)
    raw = [params.latestUserMessage.trim(), ...recent].filter(Boolean).join('\n')
  } else {
    raw = [params.ticketTitle, params.stepInstruction, params.stepInputSummary]
      .filter((part): part is string => Boolean(part?.trim()))
      .map((part) => part.trim())
      .join('\n')
  }

  const capChars = MEMORY_QUERY_TOKEN_CAP * 4
  return raw.length > capChars ? raw.slice(0, capChars) : raw
}
