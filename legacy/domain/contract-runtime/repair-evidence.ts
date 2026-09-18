import type { CompiledContract } from './types'

/** Auditált eszköz-hívás metaadat — nyers tartalom nélkül, csak contract-javításhoz. */
export type ContractRepairToolEvidence = {
  toolName: string
  outcome: string
  hints: Record<string, string>
}

const PATH_LIKE_HINT_KEYS = [
  'kimenet',
  'target',
  'path',
  'outputPath',
  'output',
  'deliverableFile',
  'muveletekPath',
  'leftPath',
  'rightPath',
  'nyilvantartasPath',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strHint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function collectStringHints(source: Record<string, unknown>, into: Record<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    const hint = strHint(value)
    if (hint) into[key] = hint
  }
}

function isFilledContractValue(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Egy persistált tool-hívás audit-meta → javító bizonyíték.
 * Csak `ok` kimenetelű, sikeres hívásokból gyűjt (denied/error kiesik).
 */
export function buildRepairEvidenceFromToolCall(call: {
  toolName: string
  status: string
  outcome?: string | null
  argsMeta?: unknown
  resultMeta?: unknown
  effectSummary?: unknown
}): ContractRepairToolEvidence | null {
  if (call.status !== 'ok') return null
  const outcome = call.outcome ?? 'ok'
  if (outcome !== 'ok') return null

  const hints: Record<string, string> = {}
  if (isRecord(call.argsMeta)) collectStringHints(call.argsMeta, hints)
  if (isRecord(call.resultMeta)) {
    collectStringHints(call.resultMeta, hints)
    const nestedEffect = call.resultMeta.effect
    if (isRecord(nestedEffect)) collectStringHints(nestedEffect, hints)
  }
  if (isRecord(call.effectSummary)) collectStringHints(call.effectSummary, hints)

  if (Object.keys(hints).length === 0) return null
  return { toolName: call.toolName, outcome, hints }
}

export function buildRepairEvidenceFromToolCalls(
  calls: Array<{
    toolName: string
    status: string
    outcome?: string | null
    argsMeta?: unknown
    resultMeta?: unknown
    effectSummary?: unknown
  }>,
): ContractRepairToolEvidence[] {
  const out: ContractRepairToolEvidence[] = []
  for (const call of calls) {
    const evidence = buildRepairEvidenceFromToolCall(call)
    if (evidence) out.push(evidence)
  }
  return out
}

/** Contract-mező kitöltése auditált eszköz-meta alapján — nem talál ki értéket. */
export function resolveFieldFromEvidence(
  fieldName: string,
  evidence: ContractRepairToolEvidence[],
): string | null {
  for (const item of evidence) {
    const direct = item.hints[fieldName]
    if (direct) return direct
  }

  const lower = fieldName.toLowerCase()
  const wantsPathLike =
    lower.endsWith('path') || lower.includes('path') || lower.endsWith('file')
  if (!wantsPathLike) return null

  for (const item of evidence) {
    for (const key of PATH_LIKE_HINT_KEYS) {
      const hint = item.hints[key]
      if (hint) return hint
    }
  }
  return null
}

/**
 * Hiányzó contract-mezők determinisztikus kitöltése eszköz-bizonyítékból,
 * mielőtt modell-alapú repair indulna.
 */
export function enrichCandidateFromEvidence(
  contract: CompiledContract,
  candidate: unknown,
  evidence: ContractRepairToolEvidence[],
): Record<string, unknown> {
  const base =
    candidate != null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? { ...(candidate as Record<string, unknown>) }
      : {}

  if (evidence.length === 0) return base

  for (const field of contract.fieldNames) {
    if (isFilledContractValue(base[field])) continue
    const fromEvidence = resolveFieldFromEvidence(field, evidence)
    if (fromEvidence) base[field] = fromEvidence
  }
  return base
}

export function formatRepairEvidenceForPrompt(
  evidence: ContractRepairToolEvidence[],
): string | null {
  if (evidence.length === 0) return null
  return evidence
    .map((item) => {
      const pairs = Object.entries(item.hints)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ')
      return `- ${item.toolName} (${item.outcome}): ${pairs}`
    })
    .join('\n')
}
