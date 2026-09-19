export type AuditActorType = 'human' | 'agent' | 'system'

export type AuditAppendInput = {
  actorType: AuditActorType
  actorId?: string | null
  agentVersion?: number | null
  action: string
  targetType: string
  targetId?: string | null
  modelUsed?: string | null
  inputRef?: string | null
  outputRef?: string | null
  policyDecision?: string | null
  metadata?: unknown
  tenantId?: string | null
}

export type AuditSink = {
  append: (data: AuditAppendInput) => Promise<unknown>
}

export async function writeAudit(sink: AuditSink | undefined, data: AuditAppendInput): Promise<void> {
  if (!sink) return
  await sink.append(data)
}
