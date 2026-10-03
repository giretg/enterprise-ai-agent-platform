/**
 * AI Interaction Audit (#746 V1-5): ki, mikor, melyik agenttel mit kérdezett, mit kapott a modell és milyen
 * toolokat használt — a gateway (`source: gateway`) és a Hermes Guard (`source: guard`) közös naplója.
 * A tartalom AES-GCM-mel titkosított és csak a policy audit-mélységéig tárolódik (ami kívül esik, az nincs meg).
 * Az `AuditLog`-ot nem váltja ki: ez a nagy volumenű tartalom-napló.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { openAesGcm, sealAesGcm } from '@/domain/privacy/aes-gcm-envelope'
import { resolveSecret } from '@/lib/crypto/secret-resolver'
import type { ModelCallAuditSink, ModelCallEvent } from '@/domain/model-gateway/proxy'

export const MAX_EVENTS_PER_BATCH = 100
export const MAX_CONTENT_BYTES = 256 * 1024
export const MAX_META_BYTES = 16 * 1024
export const MAX_BATCH_BYTES = 8 * 1024 * 1024
export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_SWEEP_LIMIT = 5000
export const MAX_LIST_LIMIT = 500

export type AuditDepth = 'metadata' | 'prompt_and_response' | 'plus_tool_results'
export type AuditKind = 'user_prompt' | 'model_call' | 'tool_call' | 'final'
export type AuditSource = 'gateway' | 'guard'

const DEPTH_RANK: Record<AuditDepth, number> = { metadata: 0, prompt_and_response: 1, plus_tool_results: 2 }

/** Ismeretlen szint → a legkevesebbet tároló (adatvédelmi irány). */
export function normalizeDepth(value: unknown): AuditDepth {
  return typeof value === 'string' && value in DEPTH_RANK ? (value as AuditDepth) : 'metadata'
}

/** A tool-hívás tartalma (argumentum + eredmény) a „+ tool-eredmények" szinthez tartozik. */
export function contentAllowed(depth: AuditDepth, kind: AuditKind): boolean {
  return DEPTH_RANK[depth] >= (kind === 'tool_call' ? 2 : 1)
}

export type AiInteractionRow = {
  id: string
  tenantId: string
  userId: string
  agentId: string
  installId: string
  sessionId: string | null
  turnId: string | null
  kind: AuditKind
  source: AuditSource
  /** Titkosított boríték (`v1.iv.ct.tag`), vagy null (metaadat-mélység). */
  content: string | null
  meta: Record<string, unknown>
  policyVersion: string
  createdAt: Date
  expiresAt: Date
}

export type AiInteractionFilter = {
  tenantId: string
  userId?: string
  agentId?: string
  sessionId?: string
  from?: Date
  to?: Date
  limit: number
}

export interface AiInteractionStore {
  /** A már létező `(tenantId, id)` kimarad (idempotens); a ténylegesen beírt sorok számát adja. */
  insertMany(rows: AiInteractionRow[]): Promise<number>
  list(filter: AiInteractionFilter): Promise<AiInteractionRow[]>
  /** Lejárt sorok törlése, legfeljebb `limit` darab. A ténylegesen töröltek számát adja. */
  deleteExpired(now: Date, limit: number): Promise<number>
}

export type AiAuditDeps = {
  store: AiInteractionStore
  /** A V1-1 effektív policy `audit_depth`-je erre a user+agent párra. */
  depthFor: (input: { tenantId: string; userId: string; agentId: string }) => Promise<AuditDepth>
  now?: () => Date
  retentionDays?: () => number
}

// --- Titkosítás: tenantonként származtatott kulcs, a gyökér a meglévő platform-titok ---
let root: string | undefined
function tenantKey(tenantId: string): Buffer {
  root ??= resolveSecret(
    ['AI_AUDIT_ENCRYPTION_KEY', 'PRIVACY_SURROGATE_HMAC_KEY', 'WRITE_GATE_SECRET'],
    'dev-ai-audit-key-change-in-prod',
  )
  return createHmac('sha256', root).update(`ai-audit:v1:${tenantId}`).digest()
}

export const encryptContent = (tenantId: string, text: string): string =>
  sealAesGcm(tenantKey(tenantId), Buffer.from(text, 'utf8'))

export const decryptContent = (tenantId: string, envelope: string): string =>
  openAesGcm(tenantKey(tenantId), envelope, 'ai-audit').toString('utf8')

export function retentionDaysFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AI_AUDIT_RETENTION_DAYS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

const serialize = (value: unknown): string => JSON.stringify(value)
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')

type EventInput = {
  id: string
  ctx: Pick<AiInteractionRow, 'tenantId' | 'userId' | 'agentId' | 'installId' | 'policyVersion'>
  sessionId: string | null
  turnId: string | null
  kind: AuditKind
  source: AuditSource
  content: unknown
  meta: Record<string, unknown>
}

function buildRow(deps: AiAuditDeps, depth: AuditDepth, e: EventInput): AiInteractionRow {
  const now = (deps.now ?? (() => new Date()))()
  const days = (deps.retentionDays ?? retentionDaysFromEnv)()
  const keep = e.content != null && contentAllowed(depth, e.kind)
  return {
    ...e.ctx,
    id: e.id,
    sessionId: e.sessionId,
    turnId: e.turnId,
    kind: e.kind,
    source: e.source,
    content: keep ? encryptContent(e.ctx.tenantId, serialize(e.content)) : null,
    meta: e.meta,
    createdAt: now,
    expiresAt: new Date(now.getTime() + days * 86_400_000),
  }
}

// --- Ingest a Guardtól ---
const ingestEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  turnId: z.string().max(200).nullish(),
  // `model_call` csak a gatewayé: a Guard nem hamisíthat gateway-rekordot (megkerülés-észlelés alapja).
  kind: z.enum(['user_prompt', 'tool_call', 'final']),
  content: z.unknown().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
})
// A tenant/user/agent/install a tokenből jön: a payload ilyen mezői a zod-strip miatt eldobódnak.

export type IngestResult =
  | { ok: true; received: number; stored: number }
  | { ok: false; status: 400 | 413; code: 'bad_request' | 'too_many_events' | 'content_too_large' | 'meta_too_large' }

export async function ingestGuardEvents(
  deps: AiAuditDeps,
  ctx: EventInput['ctx'],
  payload: unknown,
): Promise<IngestResult> {
  const events = (payload as { events?: unknown } | null)?.events
  if (!Array.isArray(events) || events.length === 0) return { ok: false, status: 400, code: 'bad_request' }
  if (events.length > MAX_EVENTS_PER_BATCH) return { ok: false, status: 413, code: 'too_many_events' }
  const parsed = z.array(ingestEventSchema).safeParse(events)
  if (!parsed.success) return { ok: false, status: 400, code: 'bad_request' }

  for (const e of parsed.data) {
    if (e.content != null && byteLength(serialize(e.content)) > MAX_CONTENT_BYTES) {
      return { ok: false, status: 413, code: 'content_too_large' }
    }
    if (byteLength(JSON.stringify(e.meta)) > MAX_META_BYTES) return { ok: false, status: 413, code: 'meta_too_large' }
  }

  const depth = await deps.depthFor(ctx)
  const rows = parsed.data.map((e) =>
    buildRow(deps, depth, { ...e, ctx, turnId: e.turnId ?? null, source: 'guard', content: e.content ?? null }),
  )
  return { ok: true, received: rows.length, stored: await deps.store.insertMany(rows) }
}

// --- Gateway-írás (a V1-3 audit-interfész implementációja) ---
const TOOL_RESULT_PLACEHOLDER = '[tool-eredmény: az audit-mélységen kívül, nem tárolt]'

/** A „prompt + válasz" mélységben a tool-eredmények nem tárolódnak: a `tool` szerepű üzenetek tartalma kiesik. */
function stripToolResults(request: unknown): unknown {
  const body = request as { messages?: unknown } | null
  if (!body || !Array.isArray(body.messages)) return request
  return {
    ...body,
    messages: body.messages.map((m) =>
      m && typeof m === 'object' && (m as { role?: unknown }).role === 'tool'
        ? { ...m, content: TOOL_RESULT_PLACEHOLDER }
        : m,
    ),
  }
}

export function createGatewayAuditSink(deps: AiAuditDeps): ModelCallAuditSink {
  return {
    async record(e: ModelCallEvent) {
      const ctx = { tenantId: e.tenantId, userId: e.userId, agentId: e.agentId, installId: e.installId, policyVersion: e.policyVersion }
      const depth = await deps.depthFor(ctx)
      const row = buildRow(deps, depth, {
        id: randomUUID(),
        ctx,
        sessionId: e.sessionId,
        turnId: e.turnId,
        kind: 'model_call',
        source: 'gateway',
        content: e.request == null && e.response == null
          ? null
          : { request: depth === 'plus_tool_results' ? e.request : stripToolResults(e.request), response: e.response },
        meta: {
          model: e.model,
          requestedModel: e.requestedModel,
          substituted: e.substituted,
          failedCandidates: e.failedCandidates,
          outcome: e.outcome,
          policyDecision: e.outcome === 'blocked' ? 'denied' : e.outcome === 'ok' ? 'allowed' : e.outcome,
          blockReason: e.blockReason,
          errorClass: e.errorClass,
          stream: e.stream,
          usage: e.usage,
          latencyMs: e.latencyMs,
        },
      })
      await deps.store.insertMany([row])
    },
  }
}

// --- Admin olvasás ---
export type AuditEventView = Omit<AiInteractionRow, 'content'> & { hasContent: boolean; content?: unknown }

export async function listAuditEvents(
  store: AiInteractionStore,
  filter: AiInteractionFilter,
  opts: { decrypt: boolean; now?: Date },
): Promise<AuditEventView[]> {
  const now = opts.now ?? new Date()
  const rows = await store.list({ ...filter, limit: Math.min(Math.max(filter.limit, 1), MAX_LIST_LIMIT) })
  return rows
    .filter((r) => r.expiresAt.getTime() > now.getTime())
    .map(({ content, ...rest }) => {
      const view: AuditEventView = { ...rest, hasContent: content != null }
      if (opts.decrypt && content != null) {
        view.content = JSON.parse(decryptContent(rest.tenantId, content))
      }
      return view
    })
}

/** Lejárt `AiInteractionEvent` sorok törlése. A Cloud Scheduler ezt hívja a retention-route-on. */
export async function sweepExpiredAiAuditEvents(
  store: Pick<AiInteractionStore, 'deleteExpired'>,
  input: { now?: Date; limit?: number } = {},
): Promise<{ deleted: number }> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? DEFAULT_SWEEP_LIMIT
  return { deleted: await store.deleteExpired(now, Math.max(1, limit)) }
}
