/**
 * Admin debug-log export — conversation/ticket telemetria egy JSON bundle-ben.
 * Nem tartalmaz nyers LLM prompt/completion tartalmat (payload-guard invariáns).
 */

export const DEBUG_LOG_SCHEMA_VERSION = 1 as const

export type DebugLogExportFile = {
  content: string
  filename: string
  mediaType: 'application/json'
}

export type ConversationDebugLogBundle = {
  schemaVersion: typeof DEBUG_LOG_SCHEMA_VERSION
  kind: 'conversation'
  exportedAt: string
  conversation: Record<string, unknown>
  messages: Array<Record<string, unknown>>
  agentTurns: Array<Record<string, unknown>>
  modelCalls: Array<Record<string, unknown>>
  toolCalls: Array<Record<string, unknown>>
  audit: Array<Record<string, unknown>>
  linkedTickets: Array<TicketDebugLogSlice>
}

export type TicketDebugLogBundle = {
  schemaVersion: typeof DEBUG_LOG_SCHEMA_VERSION
  kind: 'ticket'
  exportedAt: string
  ticket: Record<string, unknown>
  comments: Array<Record<string, unknown>>
  transitions: Array<Record<string, unknown>>
  modelCalls: Array<Record<string, unknown>>
  toolCalls: Array<Record<string, unknown>>
  audit: Array<Record<string, unknown>>
  linkedConversation: ConversationDebugLogBundle | null
}

export type TicketDebugLogSlice = {
  ticket: Record<string, unknown>
  comments: Array<Record<string, unknown>>
  transitions: Array<Record<string, unknown>>
}

/** JSON-safe érték: Date → ISO, Decimal/BigInt → string/number, egyéb primitív/struktúra. */
export function toJsonSafe(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    // Prisma Decimal
    if (
      'toFixed' in value &&
      typeof (value as { toFixed?: unknown }).toFixed === 'function' &&
      'toNumber' in value &&
      typeof (value as { toNumber?: unknown }).toNumber === 'function'
    ) {
      try {
        return (value as { toNumber: () => number }).toNumber()
      } catch {
        return String(value)
      }
    }
    if (Array.isArray(value)) return value.map(toJsonSafe)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v)
    }
    return out
  }
  return value
}

export function recordFromUnknown(value: unknown): Record<string, unknown> {
  return toJsonSafe(value) as Record<string, unknown>
}

export function recordsFromUnknown(values: unknown[]): Array<Record<string, unknown>> {
  return values.map(recordFromUnknown)
}

export function buildConversationDebugLogBundle(input: {
  exportedAt?: Date
  conversation: unknown
  messages: unknown[]
  agentTurns: unknown[]
  modelCalls: unknown[]
  toolCalls: unknown[]
  audit: unknown[]
  linkedTickets: TicketDebugLogSlice[]
}): ConversationDebugLogBundle {
  return {
    schemaVersion: DEBUG_LOG_SCHEMA_VERSION,
    kind: 'conversation',
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    conversation: recordFromUnknown(input.conversation),
    messages: recordsFromUnknown(input.messages),
    agentTurns: recordsFromUnknown(input.agentTurns),
    modelCalls: recordsFromUnknown(input.modelCalls),
    toolCalls: recordsFromUnknown(input.toolCalls),
    audit: recordsFromUnknown(input.audit),
    linkedTickets: input.linkedTickets.map((slice) => ({
      ticket: recordFromUnknown(slice.ticket),
      comments: recordsFromUnknown(slice.comments),
      transitions: recordsFromUnknown(slice.transitions),
    })),
  }
}

export function buildTicketDebugLogBundle(input: {
  exportedAt?: Date
  ticket: unknown
  comments: unknown[]
  transitions: unknown[]
  modelCalls: unknown[]
  toolCalls: unknown[]
  audit: unknown[]
  linkedConversation: ConversationDebugLogBundle | null
}): TicketDebugLogBundle {
  return {
    schemaVersion: DEBUG_LOG_SCHEMA_VERSION,
    kind: 'ticket',
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    ticket: recordFromUnknown(input.ticket),
    comments: recordsFromUnknown(input.comments),
    transitions: recordsFromUnknown(input.transitions),
    modelCalls: recordsFromUnknown(input.modelCalls),
    toolCalls: recordsFromUnknown(input.toolCalls),
    audit: recordsFromUnknown(input.audit),
    linkedConversation: input.linkedConversation,
  }
}

export function serializeDebugLogBundle(
  bundle: ConversationDebugLogBundle | TicketDebugLogBundle,
  id: string,
): DebugLogExportFile {
  const short = id.replace(/-/g, '').slice(0, 8)
  const day = bundle.exportedAt.slice(0, 10)
  const filename = `${bundle.kind}-debug-log-${short}-${day}.json`
  return {
    content: `${JSON.stringify(bundle, null, 2)}\n`,
    filename,
    mediaType: 'application/json',
  }
}
