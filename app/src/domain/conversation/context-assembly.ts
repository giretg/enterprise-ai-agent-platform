import type { AuditRepository } from '@/repositories/interfaces'

export const DEFAULT_CONTEXT_RECENCY_MESSAGES = 16
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6000

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

function estimateTextTokens(value: string): number {
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
  documentAliases: string[]
}): number {
  const messageTokens = params.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const memoryTokens = params.memoryContent?.trim()
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
