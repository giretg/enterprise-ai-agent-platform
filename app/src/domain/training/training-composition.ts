import {
  applyMemoryItemChange,
  parseMemoryItems,
  type MemoryItemOperation,
} from './memory-items'
import { detectHardFloorViolation, type HardFloorResult } from './training-hard-floor'

export type TrainingCompositionMode = 'build_on_pending' | 'replace_pending'

export type TrainingInstruction =
  | { kind: 'full_version'; content: string }
  | { kind: 'item_change'; change: MemoryItemOperation }
  | { kind: 'teach'; text: string }

export type ChangeSummary = {
  added: string[]
  removed: string[]
  unchanged: string[]
  rewritten: Array<{ from: string; to: string }>
}

export type ImpactVerdict = 'complements' | 'changes' | 'blocked'

export type ImpactResult = {
  verdict: ImpactVerdict
  added: string[]
  rewritten: Array<{ from: string; to: string }>
  removed: string[]
  hardFloor: HardFloorResult
  nextStep: string | null
}

export class TrainingCompositionError extends Error {
  constructor(
    message: string,
    readonly code: 'composition_required',
  ) {
    super(message)
    this.name = 'TrainingCompositionError'
  }
}

function applyInstruction(baseContent: string, instruction: TrainingInstruction): string {
  if (instruction.kind === 'full_version') return instruction.content
  if (instruction.kind === 'teach') {
    return applyMemoryItemChange(baseContent, { operation: 'add', text: instruction.text })
  }
  return applyMemoryItemChange(baseContent, instruction.change)
}

/**
 * A következő betanított-szabály verzió teljes szövege.
 * Nyitott javaslatnál a compositionMode kötelező (§4.4).
 */
export function composeProposedVersion(params: {
  activeContent: string
  pendingContent: string | null
  instruction: TrainingInstruction
  compositionMode: TrainingCompositionMode | null
}): { proposedVersion: string; base: 'active' | 'pending'; compositionMode: TrainingCompositionMode | null } {
  const hasPending = Boolean(params.pendingContent)
  if (hasPending && !params.compositionMode) {
    throw new TrainingCompositionError(
      'Válaszd ki, a meglévő javaslatba építed-e be, vagy lecseréled',
      'composition_required',
    )
  }

  if (hasPending && params.compositionMode === 'build_on_pending') {
    return {
      proposedVersion: applyInstruction(params.pendingContent ?? '', params.instruction),
      base: 'pending',
      compositionMode: 'build_on_pending',
    }
  }

  return {
    proposedVersion: applyInstruction(params.activeContent, params.instruction),
    base: 'active',
    compositionMode: hasPending ? 'replace_pending' : params.compositionMode,
  }
}

export function summarizeInstructionChange(before: string, after: string): ChangeSummary {
  const prev = parseMemoryItems(before)
  const next = parseMemoryItems(after)
  const prevSet = new Set(prev)
  const nextSet = new Set(next)

  const rewritten: Array<{ from: string; to: string }> = []
  const rewrittenFrom = new Set<string>()
  const rewrittenTo = new Set<string>()
  const limit = Math.min(prev.length, next.length)
  for (let i = 0; i < limit; i++) {
    const from = prev[i]!
    const to = next[i]!
    if (from !== to && !nextSet.has(from) && !prevSet.has(to)) {
      rewritten.push({ from, to })
      rewrittenFrom.add(from)
      rewrittenTo.add(to)
    }
  }

  return {
    added: next.filter((item) => !prevSet.has(item) && !rewrittenTo.has(item)),
    removed: prev.filter((item) => !nextSet.has(item) && !rewrittenFrom.has(item)),
    unchanged: prev.filter((item) => nextSet.has(item)),
    rewritten,
  }
}

export function buildImpactResult(params: {
  changeSummary: ChangeSummary
  proposedVersion: string
}): ImpactResult {
  const hardFloor = detectHardFloorViolation(params.proposedVersion)
  if (hardFloor.blocked) {
    return {
      verdict: 'blocked',
      added: params.changeSummary.added,
      rewritten: params.changeSummary.rewritten,
      removed: params.changeSummary.removed,
      hardFloor,
      nextStep: 'Fogalmazd át a tanítást úgy, hogy csak a munkavégzési szabályt érintse',
    }
  }

  const mutates =
    params.changeSummary.removed.length > 0 || params.changeSummary.rewritten.length > 0
  if (mutates) {
    return {
      verdict: 'changes',
      added: params.changeSummary.added,
      rewritten: params.changeSummary.rewritten,
      removed: params.changeSummary.removed,
      hardFloor,
      nextStep: 'Nézd át, mely régi szabályok íródnak át vagy szűnnek meg',
    }
  }

  return {
    verdict: 'complements',
    added: params.changeSummary.added,
    rewritten: [],
    removed: [],
    hardFloor,
    nextStep: null,
  }
}
