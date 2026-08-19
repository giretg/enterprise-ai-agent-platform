import { extractLoose } from '@/domain/contract-runtime/extract'

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

type TriggerInputTicket = {
  id: string
  title: string
  type: string
  state: string
  payload: unknown
  createdAt: Date | string
  updatedAt: Date | string
}

/**
 * Folyamat-feature-spec §4.4: ticket-trigger input feloldása.
 *
 * `ProcessTrigger.inputMap.fieldMap` alak:
 *   { fieldMap: { "<slotName>": "payload.company" | "title" | "ticket.id" | ... } }
 *
 * A plain kulcsok először a ticket payloadban keresnek, utána a ticket top-level mezőin.
 */
export function resolveTicketTriggerInputPayload(
  inputMap: unknown,
  ticket: TriggerInputTicket,
): Record<string, unknown> {
  const map = jsonObject(inputMap)
  const fieldMap = jsonObject((map as { fieldMap?: unknown }).fieldMap)
  const payload: Record<string, unknown> = {}
  for (const [slotName, source] of Object.entries(fieldMap)) {
    payload[slotName] = resolveTicketField(source, ticket)
  }
  return payload
}

/**
 * Folyamat-feature-spec §4.4: chat-trigger input feloldása.
 *
 * A teljes LLM slot-filling fölé építhető, determinisztikus mag. Az explicit
 * payload elsőbbséget élvez; ami hiányzik, azt a felhasználói üzenetből olvassuk:
 *   - JSON objektumként: `{ "ceg": "Acme Kft" }`
 *   - soronként: `ceg: Acme Kft`
 *   - aliasokkal: `{ aliases: { ceg: ["company", "cég"] } }`
 */
export function resolveChatTriggerInputPayload(
  inputMap: unknown,
  message: string,
  explicitPayload?: Record<string, unknown>,
): Record<string, unknown> {
  const map = jsonObject(inputMap)
  const slotNames = stringArray((map as { slotNames?: unknown }).slotNames)
  const aliases = jsonObject((map as { aliases?: unknown }).aliases)
  // #41 — közös laza beolvasó; hiányzó/részleges szerkezet → üres, nem fail-closed.
  const parsed = {
    ...(extractLoose(message) ?? {}),
    ...extractKeyValueLines(message),
  }
  const out: Record<string, unknown> = {}

  for (const slotName of slotNames) {
    const explicit = explicitPayload?.[slotName]
    if (explicit !== undefined) {
      out[slotName] = explicit
      continue
    }
    const keys = [slotName, ...stringArray(aliases[slotName])]
    const foundKey = keys.find((key) => parsed[key] !== undefined)
    if (foundKey) out[slotName] = parsed[foundKey]
  }
  return out
}

export type ChatTriggerAttachment = {
  id: string
  filename: string
  mimeType?: string | null
}

const FILE_LIKE_SLOT_RE = /(pdf|file|path|document|csatol|fajl|filename)/i
const DOCUMENT_ID_SLOT_RE = /^(documentId|document_id|doc_id|document)$/i

function isFileLikeSlot(name: string): boolean {
  return FILE_LIKE_SLOT_RE.test(name)
}

function isPdfAttachment(attachment: ChatTriggerAttachment): boolean {
  return /\.pdf$/i.test(attachment.filename) || attachment.mimeType === 'application/pdf'
}

function pickAttachmentForSlot(
  slotName: string,
  attachments: ChatTriggerAttachment[],
  usedIds: Set<string>,
): ChatTriggerAttachment | undefined {
  const unused = attachments.filter((attachment) => !usedIds.has(attachment.id))
  const pool = unused.length > 0 ? unused : attachments
  if (pool.length === 0) return undefined
  if (/pdf/i.test(slotName)) {
    return pool.find(isPdfAttachment) ?? pool[0]
  }
  return pool[0]
}

function attachmentValueForSlot(slotName: string, attachment: ChatTriggerAttachment): string {
  return DOCUMENT_ID_SLOT_RE.test(slotName) ? attachment.id : attachment.filename
}

/**
 * Chat-csatolmány → hiányzó fájl-szerű trigger-rés.
 *
 * A slot-filling eddig csak üzenetszöveget (JSON / `név: érték`) és explicit
 * payloadot nézett. A felhasználó viszont a fájlt csatolja, nem gépel
 * `pdf_path: …`-t — a feltöltött dokumentumot a résbe kell tenni.
 *
 * `documentId` / `document_id` → Document UUID; minden más fájl-szerű név
 * (`pdf_path`, `path`, `file`, …) → eredeti fájlnév.
 */
export function applyChatTriggerAttachments(
  payload: Record<string, unknown>,
  slotNames: string[],
  attachments: ChatTriggerAttachment[],
): Record<string, unknown> {
  if (attachments.length === 0 || slotNames.length === 0) return payload
  const out = { ...payload }
  const usedIds = new Set<string>()
  for (const slotName of slotNames) {
    if (!isFileLikeSlot(slotName)) continue
    const current = out[slotName]
    if (current !== undefined && current !== null && current !== '') continue
    const reuseSameFile =
      DOCUMENT_ID_SLOT_RE.test(slotName) && usedIds.size > 0
        ? attachments.find((attachment) => usedIds.has(attachment.id))
        : undefined
    const attachment =
      reuseSameFile ?? pickAttachmentForSlot(slotName, attachments, usedIds)
    if (!attachment) continue
    out[slotName] = attachmentValueForSlot(slotName, attachment)
    usedIds.add(attachment.id)
  }
  return out
}

type CompiledForSlots = {
  entryStepId?: string
  ticketRules?: Array<{
    stepId?: string
    inputSlots?: Array<{ name: string; required: boolean; source: string; description?: string; type?: string }>
  }>
}

export function missingRequiredTriggerSlots(
  compiled: CompiledForSlots,
  payload: Record<string, unknown>,
  stepId?: string,
): string[] {
  const required = new Set<string>()
  for (const rule of compiled.ticketRules ?? []) {
    if (stepId && 'stepId' in rule && rule.stepId !== stepId) continue
    for (const slot of rule.inputSlots ?? []) {
      if (slot.source === 'trigger' && slot.required) required.add(slot.name)
    }
  }
  return [...required].filter((name) => {
    const value = payload[name]
    return value === undefined || value === null || value === ''
  })
}

/**
 * Chat-trigger rések leírása (§4.4): a Folyamat-választó UI és az LLM
 * slot-filling fallback egyaránt ezt használja, hogy tudja MIT kér a résektől.
 */
export function chatTriggerSlotDescriptors(
  compiled: CompiledForSlots,
  stepId?: string,
): Array<{ name: string; type: string; required: boolean; description?: string }> {
  const seen = new Map<string, { name: string; type: string; required: boolean; description?: string }>()
  for (const rule of compiled.ticketRules ?? []) {
    if (stepId && 'stepId' in rule && rule.stepId !== stepId) continue
    for (const slot of rule.inputSlots ?? []) {
      if (slot.source !== 'trigger') continue
      if (!seen.has(slot.name)) {
        seen.set(slot.name, {
          name: slot.name,
          type: slot.type ?? 'string',
          required: slot.required,
          description: slot.description,
        })
      }
    }
  }
  return [...seen.values()]
}

function resolveTicketField(
  source: unknown,
  ticket: TriggerInputTicket,
): unknown {
  if (typeof source !== 'string') return source
  const ticketRecord: Record<string, unknown> = {
    id: ticket.id,
    title: ticket.title,
    type: ticket.type,
    state: ticket.state,
    createdAt: formatTicketDate(ticket.createdAt),
    updatedAt: formatTicketDate(ticket.updatedAt),
    payload: jsonObject(ticket.payload),
  }
  const payload = jsonObject(ticket.payload)

  if (source.startsWith('ticket.')) return getPath(ticketRecord, source.slice('ticket.'.length))
  if (source.startsWith('payload.')) return getPath(payload, source.slice('payload.'.length))
  if (Object.prototype.hasOwnProperty.call(payload, source)) return payload[source]
  return getPath(ticketRecord, source)
}

function formatTicketDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc === 'object' && acc !== null && key in acc) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, value)
}

function extractKeyValueLines(message: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const rawLine of message.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Za-z0-9_.-]{1,80})\s*[:=]\s*(.+?)\s*$/)
    if (!match) continue
    out[match[1]] = coerceScalar(match[2])
  }
  return out
}

function coerceScalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed.replace(/^["']|["']$/g, '')
}
