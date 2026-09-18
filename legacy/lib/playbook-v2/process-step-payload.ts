/**
 * Playbook folyamat-lépés payload feloldás és agent kimenet normalizálás.
 * Determinisztikus, DB/LLM nélkül tesztelhető segédfüggvények.
 */
import type { CompiledInputSlot, CompiledTicketRule } from '@/domain/playbook/playbook-compiler'
import type {
  PlaybookDeliverable,
  PlaybookDeliverableFormat,
  StepOutcome,
  StepOutcomeStatus,
} from '@/lib/playbook-v2/spec'
import { STEP_OUTCOME_FIELD } from '@/lib/playbook-v2/spec'
import { isWorkspacePathSlotName } from '@/domain/playbook/workspace-handoff'
import { extractJsonObject } from '@/lib/extract-json-object'
import { stringifyValue } from '@/lib/playbook-v2/effective-prompt'

/** Meta mezők, amelyek nem agent-válasz szöveg a ticket payloadban. */
export const AGENT_ANSWER_PAYLOAD_SKIP_KEYS = new Set([
  'question',
  'task',
  'toolCallCount',
  'agentVersion',
  'model',
  'memoryVersion',
  'source',
  'createdByAgentId',
  'parentTicketId',
  'conversationId',
  'briefing',
  'briefingPending',
  'attachmentDocumentIds',
  'runAsUserId',
  'runAsAuthorized',
  'runAsAuthorizedAt',
  'ephemeralKeyId',
  'failureCount',
  'deliverableFormat',
  'deliverableFile',
  'delegationReturned',
  'answeredByAgentId',
  'delegationCompletedAt',
  STEP_OUTCOME_FIELD,
  'error',
  'followUpNotes',
  'sources',
  'rationale',
  'confidence',
  'retrievedSources',
  'retrievedSourceCount',
  'recipeName',
  'recipeVersion',
  'proposal',
  'diff',
  'reasoning',
])

function displayValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (value === undefined || value === null) return null
  if (typeof value === 'object') {
    const text = stringifyValue(value).trim()
    return text.length > 0 ? text : null
  }
  return String(value)
}

/**
 * Emberi olvasható agent-válasz a ticket payloadból.
 * - `answer` (általános ticket)
 * - outputContract mezők (pl. `drafted_proposal`, `research_results`)
 * - egyéb jelentős slot-értékek fallback-ként
 */
export function extractAgentAnswerDisplayBody(
  payload: Record<string, unknown>,
  preferredFields: string[] = [],
): string | null {
  const answer = displayValue(payload.answer)
  if (answer) return answer

  for (const field of preferredFields) {
    const value = displayValue(payload[field])
    if (value) return value
  }

  for (const [key, value] of Object.entries(payload)) {
    if (AGENT_ANSWER_PAYLOAD_SKIP_KEYS.has(key) || key.startsWith('runAs')) continue
    const text = displayValue(value)
    if (text && text.length >= 20) return text
  }

  return null
}

/** `agent_answer` structured mező a payload metaadataiból (badge-ekhez). */
export function agentAnswerStructuredFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {}
  if (typeof payload.model === 'string') structured.model = payload.model
  if (typeof payload.confidence === 'string') structured.confidence = payload.confidence
  if (typeof payload.toolCallCount === 'number') structured.toolCallCount = payload.toolCallCount
  if (typeof payload.memoryVersion === 'number') structured.memoryVersion = payload.memoryVersion
  if (Array.isArray(payload.sources)) structured.sources = payload.sources
  if (typeof payload.rationale === 'string') structured.rationale = payload.rationale
  const outcome = payload[STEP_OUTCOME_FIELD]
  if (outcome != null && typeof outcome === 'object') structured.outcome = outcome
  return structured
}

export type ResolveStepInputOptions = {
  /** Futás szintű input (trigger + config, process.inputPayload). */
  processInput: Record<string, unknown>
  /** Az előző lépés ticket payloadja / resultPayload-ja. */
  previousStepResult?: Record<string, unknown>
}

function slotValuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** #33 — kimeneti mező kitöltött-e (üres string / üres tömb ≠ kitöltött). */
export function isFilledOutputValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value.trim() === '') return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

/**
 * Egy lépés ticket-inputját állítja össze a compiled inputSlots forrása szerint.
 * - `config` / `trigger` → processInput
 * - `step` → previousStepResult (előző lépés kimenete)
 */
export function resolveStepInputPayload(
  rule: Pick<CompiledTicketRule, 'inputSlots'>,
  options: ResolveStepInputOptions,
): Record<string, unknown> {
  const processInput = options.processInput ?? {}
  const previousStepResult = options.previousStepResult ?? {}
  const resolved: Record<string, unknown> = {}

  for (const slot of rule.inputSlots ?? []) {
    const fromProcess = processInput[slot.name]
    const fromStep = previousStepResult[slot.name]

    if (slot.source === 'step') {
      if (slotValuePresent(fromStep)) resolved[slot.name] = fromStep
      continue
    }

    if (slotValuePresent(fromProcess)) {
      resolved[slot.name] = fromProcess
      continue
    }

    // Visszafelé kompatibilitás: ha az előző lépés adta, de a slot még trigger-ként van jelölve.
    if (slot.source === 'trigger' && slotValuePresent(fromStep)) {
      resolved[slot.name] = fromStep
    }
  }

  return resolved
}

/** A ticket payloadból kiszűri a belső/meta mezőket a prompt-rés maphez. */
export function playbookSlotValuesFromTicketPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const skip = new Set([
    'question',
    'answer',
    'toolCallCount',
    'agentVersion',
    'model',
    'memoryVersion',
    'source',
    'createdByAgentId',
    'parentTicketId',
    'conversationId',
    'attachmentDocumentIds',
    'runAsUserId',
  ])
  const slots: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (skip.has(key) || key.startsWith('runAs')) continue
    if (value !== undefined && value !== null && value !== '') slots[key] = value
  }
  return slots
}

/**
 * Agent szöveges válaszából a lépés outputContract mezőit nyeri ki.
 * - JSON objektum a válaszban → kötelező kulcsok
 * - JSON nélkül / hiányos JSON → a mezők HIÁNYZÓNAK számítanak (csak `answer` kerül be
 *   kontextusként), hogy a hard-signal `computeStepOutcome` helyesen `blocked`-ként
 *   jelölje a lépést. Egy kötelező mezőnél a teljes nyers szöveget érvényes értékként
 *   elfogadni régen csendben elfedte, ha a modell nem tett JSON-t a válasz végére
 *   (miközben a runtime mindig kéri azt, ha `outputRequiredFields` nem üres) — a hibás
 *   érték így némán tovaterjedt a következő lépésekbe ahelyett, hogy emberi
 *   felülvizsgálatra terelődött volna.
 */
export function parseAgentStepOutput(
  content: string,
  requiredFields: string[],
): Record<string, unknown> {
  const trimmed = content.trim()
  if (requiredFields.length === 0) {
    return trimmed ? { answer: trimmed } : {}
  }

  const parsed = extractJsonObject(trimmed)
  if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    // Whitespace-normalizált kulcs-index: egyes modellek nyers sortörést szúrnak a kulcsba
    // (pl. `"provider\nName"`), amit az extractJsonObject már parse-olhatóvá tett, de a kulcs
    // így nem egyezne a kötelező mezőnévvel. A normalizált illesztés ezt is helyreteszi.
    const normalizeKey = (key: string) => key.replace(/\s+/g, '')
    const normalizedIndex = new Map<string, unknown>()
    for (const [key, value] of Object.entries(record)) {
      const nk = normalizeKey(key)
      if (!normalizedIndex.has(nk)) normalizedIndex.set(nk, value)
    }
    const out: Record<string, unknown> = {}
    for (const field of requiredFields) {
      const direct = record[field]
      const value = direct !== undefined && direct !== null ? direct : normalizedIndex.get(normalizeKey(field))
      if (!isFilledOutputValue(value)) continue
      out[field] = value
    }
    if (requiredFields.every((f) => out[f] !== undefined)) return out
    if (Object.keys(out).length > 0) return { ...out, answer: trimmed }
  }

  return trimmed ? { answer: trimmed } : {}
}

/** board_write payload összeállítása a lépés outputContract mezőivel. */
export function buildStepCompletionPayload(input: {
  agentContent: string
  outputRequiredFields: string[]
  meta?: Record<string, unknown>
}): Record<string, unknown> {
  const structured = parseAgentStepOutput(input.agentContent, input.outputRequiredFields)
  return {
    ...structured,
    ...(input.meta ?? {}),
  }
}

// --- WP-7 / D12 (§10.1) Determinista step-outcome kényszerítés ---------------

export type StepOutcomeSignals = {
  /** A tool-loop kimenete (`exhausted` → hard hiba). */
  loopStatus: 'completed' | 'exhausted' | string
  /** Hány tool-hívás történt a loopban. */
  toolCallCount: number
  /** A pre-fetch kb_search engedélyezett volt ÉS 0 találatot adott (diagnosztikai jel). */
  kbZeroHit: boolean
  /** Bármely tool-hívást a broker megtagadott (grant/policy DENY) — NEM a skill-hatókör policy-skip. */
  toolDenied?: boolean
  /**
   * Hibapolicy spec §5.1/WP-3 — a lépés outputContract kötelező mezői közül melyik
   * hiányzik a parse-olt agent-kimenetből (üres/hiányzó tömb = teljesült). Ha nem üres,
   * a step NEM zárható néma `ok`-ként — a `done`-ra írás máskülönben az
   * `evaluateTicketTransition` `OUTPUT_CONTRACT_VIOLATION` DENY-jébe futna.
   */
  missingOutputFields?: string[]
  /** #33 — közérthető contract-hiba magyarázat az outcome.message-hez. */
  contractErrorMessage?: string
}

/**
 * A step gépi `outcome`-ja a HARD SIGNALOKBÓL, determinisztikusan — az agent optimista
 * önbevallását felülírva (§10.1). NEM az agent prózáját elemzi.
 *
 *  - `failed`  — a tool-loop kimerült VAGY a broker grant/policy elutasított (NEM skill-hatókör skip);
 *  - `blocked` — a lépés outputContract kötelező mezői hiányoznak a végleges kimenetből;
 *  - `ok`      — egyébként (a happy path érintetlen; visszafelé kompatibilis).
 */
export function computeStepOutcome(signals: StepOutcomeSignals): StepOutcome {
  if (signals.loopStatus === 'exhausted') {
    return { status: 'failed', reason: 'tool_loop_exhausted' }
  }
  if (signals.toolDenied) {
    return { status: 'failed', reason: 'tool_denied' }
  }
  if (signals.missingOutputFields && signals.missingOutputFields.length > 0) {
    return {
      status: 'blocked',
      reason: 'output_contract_unmet',
      missing: signals.missingOutputFields,
      ...(signals.contractErrorMessage
        ? { message: signals.contractErrorMessage }
        : {}),
    }
  }
  return { status: 'ok' }
}

/** Az `outcome`-mező kanonikus kulccsal a completion payloadhoz (routing: `outcome.status`). */
export function withStepOutcome(
  payload: Record<string, unknown>,
  outcome: StepOutcome,
): Record<string, unknown> {
  return { ...payload, [STEP_OUTCOME_FIELD]: outcome }
}

/**
 * A payload `outcome`-mezőjének kiolvasása audit célra (hiba-policy spec §9 —
 * `outcome_status`/`outcome_reason`). A reason lehet runtime hard-hiba
 * (`tool_denied`, `tool_loop_exhausted`), output contract hiba vagy explicit agent/runtime
 * payloadból érkező domain-ok; ez a helper audit-visszakereshetővé teszi.
 */
export function readStepOutcome(
  payload: Record<string, unknown> | undefined,
): { status?: StepOutcomeStatus; reason?: string; message?: string } {
  const outcome = (payload ?? {})[STEP_OUTCOME_FIELD]
  if (outcome == null || typeof outcome !== 'object') return {}
  const status = (outcome as Record<string, unknown>)['status']
  const reason = (outcome as Record<string, unknown>)['reason']
  const message = (outcome as Record<string, unknown>)['message']
  return {
    status: status === 'ok' || status === 'blocked' || status === 'failed' ? status : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
    message: typeof message === 'string' && message.trim() ? message : undefined,
  }
}

/**
 * #33 / #39 — emberi felülvizsgálat ticket címe: közérthető magyarázat,
 * nem `unhandled_blocked` / nyers technikai kód.
 */
export function humanReviewTicketTitle(stepId: string, humanSummary?: string | null): string {
  if (humanSummary && humanSummary.trim()) {
    const oneLine = humanSummary.replace(/\s+/g, ' ').trim()
    const short = oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine
    return `Emberi felülvizsgálat: ${short}`
  }
  return `Emberi felülvizsgálat: ${stepId}`
}

export function outputRequiredFieldsForStep(
  rule: Pick<CompiledTicketRule, 'outputRequiredFields'> | undefined,
  globalRequiredFields: string[],
): string[] {
  const stepFields = rule?.outputRequiredFields ?? []
  if (stepFields.length > 0) return stepFields
  return globalRequiredFields
}

export function formatOutputContractInstruction(requiredFields: string[]): string {
  if (requiredFields.length === 0) return ''
  const keys = requiredFields.join(', ')
  return [
    'Folyamat-lépés kimeneti szerződés (KÖTELEZŐ):',
    `A feladat végén a válaszodban JSON objektum legyen ezekkel a kulcsokkal: ${keys}.`,
    'A JSON lehet a válasz utolsó blokkja (```json ... ``` vagy nyers objektum).',
    'Ha egy kulcs értéke strukturált adat (pl. kutatási eredmény), objektum/tömb formában add meg.',
  ].join('\n')
}

export function missingRequiredInputSlots(
  rule: Pick<CompiledTicketRule, 'inputSlots'>,
  resolved: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  for (const slot of rule.inputSlots ?? []) {
    if (!slot.required) continue
    if (!slotValuePresent(resolved[slot.name])) missing.push(slot.name)
  }
  return missing
}

/**
 * Agent-lépés kimenet normalizálása: ha a contract mező hiányzik, de van `answer`,
 * másoljuk át (legacy runtime / modell csak szöveget ad vissza).
 */
export function normalizeAgentStepResult(
  rule: Pick<CompiledTicketRule, 'outputRequiredFields'> | undefined,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...raw }
  const answer = normalized.answer
  if (typeof answer !== 'string' || !answer.trim()) return normalized

  for (const field of rule?.outputRequiredFields ?? []) {
    if (slotValuePresent(normalized[field])) continue
    // Path-slotba (…Path/…File/…Document) NEM másoljuk a prózát: a szerződés
    // ettől „teljesültnek" látszana, a következő lépés pedig egy több száz
    // karakteres mondatot kapna fájlnév gyanánt. Maradjon hiányzó — így a
    // kimeneti szerződés bukik, és emberi felülvizsgálatra megy a lépés.
    if (isWorkspacePathSlotName(field)) continue
    normalized[field] = answer
  }
  return normalized
}

export type CompiledInputSlotSource = CompiledInputSlot['source']

// --- §4.7b Deliverable (valódi fájl-artefaktum a lépéshez) ------------------

/** A deliverable-formátumhoz tartozó fájl-előállító platform-eszköz. */
export const DELIVERABLE_TOOL_BY_FORMAT: Record<PlaybookDeliverableFormat, string> = {
  html: 'create_html',
  xlsx: 'xlsx_create',
  pptx: 'pptx_create',
  pdf: 'pdf_create',
}

/** A deliverable-formátumhoz tartozó fájlkiterjesztés (a kész fájl felismeréséhez). */
export const DELIVERABLE_EXT_BY_FORMAT: Record<PlaybookDeliverableFormat, string> = {
  html: '.html',
  xlsx: '.xlsx',
  pptx: '.pptx',
  pdf: '.pdf',
}

/** Ha a lépés nem ad `field`-et, ide kerül a kész fájl neve a lépés-payloadban. */
export const DEFAULT_DELIVERABLE_FIELD = 'deliverableFile'

/** A modellnek adott rendszer-utasítás, hogy valódi fájlt gyártson (ne szöveget). */
export function formatDeliverableInstruction(deliverable: PlaybookDeliverable): string {
  const tool = DELIVERABLE_TOOL_BY_FORMAT[deliverable.format]
  const ext = DELIVERABLE_EXT_BY_FORMAT[deliverable.format]
  const nameHint = deliverable.filename ? ` Javasolt fájlnév: ${deliverable.filename}.` : ''
  return [
    `Folyamat-lépés deliverable (KÖTELEZŐ): ennek a lépésnek VALÓDI ${deliverable.format.toUpperCase()} fájlt (${ext}) kell előállítania a(z) \`${tool}\` eszközzel a munkaterületen — NE a válaszba írt szövegként/markupként.${nameHint}`,
    'A fájl a ticket munkaterületére kerül, ahonnan a felhasználó letölti. A szöveges válaszod csak rövid összefoglaló legyen; a teljes tartalom a fájlban van.',
  ].join('\n')
}

/**
 * Az előállított deliverable fájl kiválasztása a munkaterület before/after
 * pillanatképéből: a formátum kiterjesztésére illeszkedő, ÚJ (a futás alatt
 * keletkezett) fájl. Belső fájlokat (`.tool-results/`) kihagyja. Több találatnál
 * a lexikálisan utolsót adja. Ha nincs új találat, `null`.
 */
export function pickDeliverableFile(
  filesBefore: Iterable<string>,
  filesAfter: Iterable<string>,
  format: PlaybookDeliverableFormat,
): string | null {
  const ext = DELIVERABLE_EXT_BY_FORMAT[format]
  const before = new Set(filesBefore)
  const candidates = [...filesAfter]
    .filter((p) => !before.has(p))
    .filter((p) => !p.startsWith('.tool-results/'))
    .filter((p) => p.toLowerCase().endsWith(ext))
    .sort()
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null
}

/** A deliverable-lépés csak ténylegesen létrejött fájllal zárható sikeresen. */
export function requireDeliverableFile(
  deliverable: PlaybookDeliverable,
  filePath: string | null,
): string {
  if (filePath) return filePath
  const requiredTool = DELIVERABLE_TOOL_BY_FORMAT[deliverable.format]
  const filenameHint = deliverable.filename ? ` (${deliverable.filename})` : ''
  throw new Error(
    `Deliverable lépés sikertelen: nem készült új ${deliverable.format.toUpperCase()} fájl${filenameHint}. ` +
      `A lépés csak akkor zárható done-ra, ha az agent meghívja a(z) '${requiredTool}' eszközt és létrejön a fájl.`,
  )
}
