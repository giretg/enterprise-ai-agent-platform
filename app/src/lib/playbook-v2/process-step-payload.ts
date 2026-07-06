/**
 * Playbook folyamat-lépés payload feloldás és agent kimenet normalizálás.
 * Determinisztikus, DB/LLM nélkül tesztelhető segédfüggvények.
 */
import type { CompiledInputSlot, CompiledTicketRule } from '@/domain/playbook/playbook-compiler'
import type {
  PlaybookDeliverable,
  PlaybookDeliverableFormat,
  StepOutcome,
} from '@/lib/playbook-v2/spec'
import { STEP_OUTCOME_FIELD } from '@/lib/playbook-v2/spec'
import { extractJsonObject } from '@/domain/provisioning/provisioning-assistant'

export type ResolveStepInputOptions = {
  /** Futás szintű input (trigger + config, process.inputPayload). */
  processInput: Record<string, unknown>
  /** Az előző lépés ticket payloadja / resultPayload-ja. */
  previousStepResult?: Record<string, unknown>
}

function slotValuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
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
 * - egyetlen kötelező mező → teljes szöveg fallback
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
    const out: Record<string, unknown> = {}
    for (const field of requiredFields) {
      if (record[field] !== undefined && record[field] !== null) {
        out[field] = record[field]
      }
    }
    if (requiredFields.every((f) => out[f] !== undefined)) return out
    if (Object.keys(out).length > 0) return { ...out, answer: trimmed }
  }

  if (requiredFields.length === 1) {
    return { [requiredFields[0]!]: trimmed }
  }

  return { answer: trimmed }
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
  /** A pre-fetch kb_search engedélyezett volt ÉS 0 találatot adott. */
  kbZeroHit: boolean
  /** Bármely tool-hívást a broker megtagadott (denied). */
  toolDenied?: boolean
}

/**
 * A step gépi `outcome`-ja a HARD SIGNALOKBÓL, determinisztikusan — az agent optimista
 * önbevallását felülírva (§10.1). NEM az agent prózáját elemzi.
 *
 *  - `failed`  — a tool-loop kimerült VAGY a broker tool-hívást tagadott meg;
 *  - `blocked` — a pre-fetch kb_search 0 találatot adott ÉS az agent EGYETLEN tool-t sem
 *                hívott (nincs célzott kb_search / file / gmail), tehát a KB-függő állítások
 *                forrás nélküliek → emberrel/másik lépéssel feloldható;
 *  - `ok`      — egyébként (a happy path érintetlen; visszafelé kompatibilis).
 */
export function computeStepOutcome(signals: StepOutcomeSignals): StepOutcome {
  if (signals.loopStatus === 'exhausted') {
    return { status: 'failed', reason: 'tool_loop_exhausted' }
  }
  if (signals.toolDenied) {
    return { status: 'failed', reason: 'tool_denied' }
  }
  if (signals.kbZeroHit && signals.toolCallCount === 0) {
    return { status: 'blocked', reason: 'missing_kb_source' }
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
    if (!slotValuePresent(normalized[field])) {
      normalized[field] = answer
    }
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
