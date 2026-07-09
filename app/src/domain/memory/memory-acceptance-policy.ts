import { MEMORY_CHUNK_TYPES, type MemoryChunkType } from './memory-types'

/**
 * agent-memory-persistent-cross-conversation-spec.md §3 — Memory Acceptance
 * Policy, a MECHANIKUSAN kikényszeríthető rész: engedélyezett típus (§3.1) +
 * kötelező metadata (§3.3). A §3.2 "mit ne írj memóriába" tartalmi útmutatás
 * viselkedési szinten él (§2.3 capture-policy rendszerprompt-blokk, WP-3),
 * nem itt — egy szöveg "ez transzkript-e" jellegű gépi eldöntése megbízhatatlan
 * lenne, és a döntés helye a §2.3 szerint is a prompt, nem a validátor.
 */

export const MEMORY_PROPOSE_OPERATIONS = [
  'create',
  'update',
  'supersede',
  'archive',
  'delete_request',
] as const
export type MemoryProposeOperation = (typeof MEMORY_PROPOSE_OPERATIONS)[number]

const CONTENT_OPERATIONS: readonly MemoryProposeOperation[] = ['create', 'update', 'supersede']
const TARGET_REQUIRED_OPERATIONS: readonly MemoryProposeOperation[] = [
  'update',
  'supersede',
  'archive',
  'delete_request',
]

const MAX_TITLE_LEN = 200
const MAX_SUMMARY_LEN = 500
const MAX_TEXT_LEN = 8000
const MAX_EVIDENCE_LEN = 2000
const MAX_PATH_LEN = 200
const MAX_TAGS = 10
const MAX_TAG_LEN = 40

export type MemoryProposeSourceRef = { type: string; id?: string; path?: string }

export type MemoryProposeInput = {
  operation: MemoryProposeOperation
  type?: string
  workstreamKey?: string
  path?: string
  title?: string
  summary?: string
  text?: string
  tags?: string[]
  salienceHint?: string
  confidence?: string
  supersedes?: string
  reviewAfter?: string
  expiresAt?: string
  sourceRefs?: MemoryProposeSourceRef[]
  evidence?: string
  reason?: string
}

export type NormalizedMemoryProposeInput = {
  operation: MemoryProposeOperation
  type?: MemoryChunkType
  workstreamKey: string | null
  path: string | null
  title: string | null
  summary: string | null
  text: string | null
  tags: string[]
  salienceHint: 'normal' | 'high'
  confidence: 'low' | 'normal' | 'high'
  supersedes: string | null
  reviewAfter: string | null
  expiresAt: string | null
  sourceRefs: MemoryProposeSourceRef[]
  evidence: string | null
  reason: string
}

export type MemoryAcceptanceResult =
  | { ok: true; normalized: NormalizedMemoryProposeInput }
  | { ok: false; reason: string }

function isIsoDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

export function validateMemoryProposeInput(input: MemoryProposeInput): MemoryAcceptanceResult {
  if (!MEMORY_PROPOSE_OPERATIONS.includes(input.operation)) {
    return { ok: false, reason: 'invalid_operation' }
  }
  const reason = input.reason?.trim()
  if (!reason) {
    return { ok: false, reason: 'reason_required' }
  }

  const isContentOp = CONTENT_OPERATIONS.includes(input.operation)
  const needsTarget = TARGET_REQUIRED_OPERATIONS.includes(input.operation)

  if (needsTarget && !input.supersedes?.trim()) {
    return { ok: false, reason: 'target_chunk_required' }
  }

  let type: MemoryChunkType | undefined
  let path: string | null = null
  let title: string | null = null
  let summary: string | null = null
  let text: string | null = null

  if (isContentOp) {
    if (!input.type || !MEMORY_CHUNK_TYPES.includes(input.type as MemoryChunkType)) {
      return { ok: false, reason: 'invalid_type' }
    }
    type = input.type as MemoryChunkType

    path = input.path?.trim() || null
    if (!path || path.length > MAX_PATH_LEN) return { ok: false, reason: 'invalid_path' }

    title = input.title?.trim() || null
    if (!title || title.length > MAX_TITLE_LEN) return { ok: false, reason: 'invalid_title' }

    text = input.text?.trim() || null
    if (!text || text.length > MAX_TEXT_LEN) return { ok: false, reason: 'invalid_text' }

    summary = input.summary?.trim() || null
    if (summary && summary.length > MAX_SUMMARY_LEN) return { ok: false, reason: 'invalid_summary' }
  }

  const salienceHint = input.salienceHint === 'high' ? 'high' : 'normal'
  if (input.salienceHint && input.salienceHint !== 'normal' && input.salienceHint !== 'high') {
    return { ok: false, reason: 'invalid_salience_hint' }
  }

  const confidence =
    input.confidence === 'low' || input.confidence === 'high' ? input.confidence : 'normal'
  if (input.confidence && !['low', 'normal', 'high'].includes(input.confidence)) {
    return { ok: false, reason: 'invalid_confidence' }
  }

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG_LEN)) {
    return { ok: false, reason: 'invalid_tags' }
  }

  if (input.reviewAfter && !isIsoDateString(input.reviewAfter)) {
    return { ok: false, reason: 'invalid_review_after' }
  }
  if (input.expiresAt && !isIsoDateString(input.expiresAt)) {
    return { ok: false, reason: 'invalid_expires_at' }
  }

  const sourceRefs = (input.sourceRefs ?? []).filter(
    (ref): ref is MemoryProposeSourceRef => typeof ref?.type === 'string' && ref.type.trim().length > 0,
  )

  const evidence = input.evidence?.trim() || null
  if (evidence && evidence.length > MAX_EVIDENCE_LEN) {
    return { ok: false, reason: 'invalid_evidence' }
  }

  return {
    ok: true,
    normalized: {
      operation: input.operation,
      type,
      workstreamKey: input.workstreamKey?.trim() || null,
      path,
      title,
      summary,
      text,
      tags,
      salienceHint,
      confidence,
      supersedes: input.supersedes?.trim() || null,
      reviewAfter: input.reviewAfter ?? null,
      expiresAt: input.expiresAt ?? null,
      sourceRefs,
      evidence,
      reason,
    },
  }
}
