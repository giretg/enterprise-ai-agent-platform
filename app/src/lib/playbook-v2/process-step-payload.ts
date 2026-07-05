/**
 * Playbook folyamat-lépés payload feloldás és agent kimenet normalizálás.
 * Determinisztikus, DB/LLM nélkül tesztelhető segédfüggvények.
 */
import type { CompiledInputSlot, CompiledTicketRule } from '@/domain/playbook/playbook-compiler'
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
