import { redactSensitiveText } from '@/domain/gateway/sensitivity-router'

/**
 * Admin debug-log export — conversation/ticket telemetria egy JSON bundle-ben.
 * A csomag kizárólag működési metaadat: nyers chat-, ticket-, dokumentum- és
 * modell-tartalom nem hagyhatja el benne a platformot.
 */

// v2: a korábbi teljes-objektum szerializálás helyett csak tartalommentes telemetria.
export const DEBUG_LOG_SCHEMA_VERSION = 2 as const

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

/**
 * A debug-csomag támogatási/incident-vizsgálati artefakt, nem általános adat-export.
 * Ezek a mezők nyers ügyfél-, modell- vagy hozzáférési adatot hordozhatnak; a
 * forrásobjektumok Prisma-relációinak jövőbeli bővítése se nyithasson új szivárgási
 * utat csak azért, mert a szerializáló automatikusan felvesz minden mezőt.
 */
const OMITTED_DEBUG_EXPORT_FIELDS = new Set([
  'accesskey',
  'accesstoken',
  'activities',
  'apikey',
  'authorization',
  'body',
  'content',
  'contentref',
  'completion',
  'cookie',
  'channelexternalid',
  'description',
  'detail',
  'error',
  'extractedtext',
  'filename',
  'inputpayload',
  'locktoken',
  'message',
  'metadata',
  'outputpayload',
  'partialtext',
  'password',
  'payload',
  'prompt',
  'raw',
  'refreshtoken',
  'request',
  'response',
  'secret',
  'secretref',
  'storageref',
  'structured',
  'summary',
  'text',
  'title',
])

const SAFE_DEBUG_EXPORT_STRING_FIELDS = new Set([
  'action',
  'assigneetype',
  'channel',
  'criticality',
  'kind',
  'model',
  'outcome',
  'policydecision',
  'provider',
  'role',
  'scope',
  'seq',
  'source',
  'state',
  'status',
  'targettype',
  'toolname',
  'trustclass',
  'type',
])

function normalizedFieldName(field: string): string {
  return field.replace(/[_-]/g, '').toLowerCase()
}

function shouldOmitDebugExportField(field: string): boolean {
  return OMITTED_DEBUG_EXPORT_FIELDS.has(normalizedFieldName(field))
}

function mayContainStableDebugString(field: string): boolean {
  const normalized = normalizedFieldName(field)
  return (
    SAFE_DEBUG_EXPORT_STRING_FIELDS.has(normalized) ||
    normalized.endsWith('id') ||
    normalized.endsWith('hash') ||
    normalized.endsWith('ref') ||
    normalized.endsWith('at') ||
    normalized === 'ts' ||
    normalized === 'retainuntil' ||
    normalized === 'executeafter' ||
    normalized === 'dueby'
  )
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

/**
 * `toJsonSafe` után alkalmazott, fail-closed export-határ. A megmaradó stringek
 * is átmennek a közös érzékenyadat-redaktoron, így például egy megengedett
 * állapotjelzésbe került e-mail, IBAN vagy titok sem kerülhet ki olvashatóan.
 */
export function toDebugLogSafe(value: unknown, field?: string): unknown {
  const jsonSafe = toJsonSafe(value)

  if (typeof jsonSafe === 'string') {
    // Ismeretlen stringet nem exportálunk. Új Prisma-reláció vagy metadata-mező
    // így csak tudatos, felülvizsgált bővítéssel adhat a debug-csomaghoz szöveget.
    if (!field || !mayContainStableDebugString(field)) return undefined
    return redactSensitiveText(jsonSafe).text
  }

  if (Array.isArray(jsonSafe)) {
    return jsonSafe
      .map((item) => toDebugLogSafe(item, field))
      .filter((item) => item !== undefined)
  }

  if (jsonSafe && typeof jsonSafe === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(jsonSafe as Record<string, unknown>)) {
      if (shouldOmitDebugExportField(key)) continue
      const safeChild = toDebugLogSafe(child, key)
      if (safeChild !== undefined) out[key] = safeChild
    }
    return out
  }

  return jsonSafe
}

export function recordFromUnknown(value: unknown): Record<string, unknown> {
  return toDebugLogSafe(value) as Record<string, unknown>
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
