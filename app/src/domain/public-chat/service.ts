/**
 * #1016 WP-3/WP-6: a nyilvános chat-végpont logikája (auth nélkül, `public_web` csatorna).
 *
 * Tenant-határ: a kliens soha nem küld tenant- vagy agentId-t — minden a `slug`-ból oldódik fel a
 * szerveren. A látogató-azonosító (≥ 32 véletlen karakter a böngészőben) a beszélgetés kulcsa.
 */
import { createHash, createHmac } from 'node:crypto'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { platformChatBudgetDay } from '@/lib/platform-chat-settings'
import {
  MAX_VISITOR_MESSAGE_CHARS,
  SESSION_RESUME_DAYS,
  publicView,
  readPublicAssistantConfig,
  type PublicAssistantConfig,
  type PublicAssistantView,
} from './config'
import { normalizeVisitorContext, runPublicTurn, type PublicTurnDeps, type TranscriptEntry } from './runtime'

const VISITOR_RE = /^[A-Za-z0-9_-]{32,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEST_TOKEN_TTL_SECONDS = 60 * 60
/** Új beszélgetés IP-nként óránként (a Turnstile mellett). */
const NEW_SESSIONS_PER_IP_HOUR = 20
const PING_THROTTLE_MS = 5 * 60 * 1000

export const UNAVAILABLE_MESSAGE = 'Az asszisztens most nem érhető el.'

export type AssistantRow = {
  agentId: string
  tenantId: string
  slug: string
  agentName: string
  agentKind: 'internal' | 'public'
  draft: unknown
  published: unknown
  paused: boolean
  lastLoadedAt: Date | null
}

export type SessionRow = {
  id: string
  agentId: string
  visitorId: string
  isTest: boolean
  context: Record<string, unknown> | null
  messages: TranscriptEntry[]
  messageCount: number
  handoff: string
  lastActivityAt: Date
}

export interface PublicChatStore {
  findAssistantBySlug(slug: string): Promise<AssistantRow | null>
  findSession(id: string): Promise<SessionRow | null>
  countRecentSessionsByIp(ipHash: string, since: Date): Promise<number>
  createSession(input: {
    tenantId: string
    agentId: string
    visitorId: string
    isTest: boolean
    context: Record<string, unknown> | null
    ipHash: string | null
    now: Date
  }): Promise<SessionRow>
  saveTurn(input: {
    sessionId: string
    messages: TranscriptEntry[]
    handoff?: { kind: string; contact: string; summary: string }
    now: Date
  }): Promise<void>
  addSignal(input: { tenantId: string; agentId: string; sessionId: string; source: string; question: string }): Promise<void>
  deleteVisitorSessions(input: { agentId: string; visitorId: string; sessionId?: string }): Promise<number>
  markLoaded(input: { agentId: string; domain: string | null; now: Date }): Promise<void>
  spendOn(input: { tenantId: string; day: string }): Promise<number>
  addSpend(input: { tenantId: string; day: string; costUsd: number }): Promise<void>
}

export type PublicChatDeps = {
  store: PublicChatStore
  /** Turnstile-token ellenőrzés (D13); `null` = nincs beállítva (a konfigurátor figyelmeztet). */
  verifyTurnstile: ((token: string, ip: string | null) => Promise<boolean>) | null
  /** A tényleges modell- és eszköz-hívások egy adott asszisztensre szűkítve. */
  turnDeps: (input: {
    tenantId: string
    agentId: string
    sessionId: string
    isTest: boolean
    config: PublicAssistantConfig
    transcript: () => TranscriptEntry[]
  }) => PublicTurnDeps
  /** Teszt-token és IP-hash titka. */
  secret: string
  rateLimit: (key: string) => boolean
  audit?: AuditSink
  onError?: (error: unknown) => void
  now?: () => Date
}

export type PublicChatFailure =
  | 'not_found'
  | 'unavailable'
  | 'bad_request'
  | 'rate_limited'
  | 'bot_check_failed'
  | 'session_limit'
  | 'budget_exhausted'

export type PublicChatResponse = { status: number; body: Record<string, unknown> }

// --- D22: „Kipróbálás látogatóként” token ---

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`public-chat-test|${payload}`).digest('base64url')
}

export function issueTestToken(secret: string, agentId: string, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + TEST_TOKEN_TTL_SECONDS
  const payload = `${agentId}.${exp}`
  return `${payload}.${sign(secret, payload)}`
}

export function verifyTestToken(secret: string, token: unknown, agentId: string, now: Date): boolean {
  if (typeof token !== 'string' || token.length > 200) return false
  const [id, exp, mac] = token.split('.')
  if (!id || !exp || !mac || id !== agentId) return false
  if (Number(exp) < Math.floor(now.getTime() / 1000)) return false
  return safeSecretEquals(mac, sign(secret, `${id}.${exp}`))
}

export function hashIp(secret: string, ip: string | null): string | null {
  return ip ? createHash('sha256').update(`${secret}|ip|${ip}`).digest('hex').slice(0, 32) : null
}

// --- Felület-állapot (oldal-render) ---

export type PublicAssistantState =
  | { state: 'not_found' }
  | { state: 'unavailable'; tenantId: string; displayName: string; supportEmail: string | null }
  | { state: 'ready'; tenantId: string; view: PublicAssistantView; isTest: boolean; messageLimit: number }

/** Mit lát a látogató: test-tokennel a draft (dry-run), egyébként csak a publikált, nem szüneteltetett profil. */
export async function resolvePublicAssistant(
  deps: Pick<PublicChatDeps, 'store' | 'secret' | 'now'>,
  input: { slug: string; testToken?: unknown },
): Promise<{ row: AssistantRow; config: PublicAssistantConfig; isTest: boolean } | PublicAssistantState> {
  const row = await deps.store.findAssistantBySlug(input.slug.toLowerCase())
  if (!row || row.agentKind !== 'public') return { state: 'not_found' }
  const now = (deps.now ?? (() => new Date()))()
  if (input.testToken !== undefined && input.testToken !== null && input.testToken !== '') {
    if (!verifyTestToken(deps.secret, input.testToken, row.agentId, now)) return { state: 'not_found' }
    return { row, config: readPublicAssistantConfig(row.draft, row.agentName), isTest: true }
  }
  if (!row.published || row.paused) {
    const config = readPublicAssistantConfig(row.published ?? row.draft, row.agentName)
    return { state: 'unavailable', tenantId: row.tenantId, displayName: config.displayName, supportEmail: config.supportEmail }
  }
  return { row, config: readPublicAssistantConfig(row.published, row.agentName), isTest: false }
}

export async function loadPublicAssistantState(
  deps: Pick<PublicChatDeps, 'store' | 'secret' | 'now'>,
  input: { slug: string; testToken?: unknown },
): Promise<PublicAssistantState> {
  const resolved = await resolvePublicAssistant(deps, input)
  if ('state' in resolved) return resolved
  return {
    state: 'ready',
    tenantId: resolved.row.tenantId,
    view: publicView(resolved.config),
    isTest: resolved.isTest,
    messageLimit: resolved.config.sessionMessageLimit,
  }
}

function unavailableBody(config: { supportEmail: string | null }, message = UNAVAILABLE_MESSAGE) {
  return {
    error: 'unavailable',
    message: config.supportEmail ? `${message} Írj nekünk ide: ${config.supportEmail}` : message,
  }
}

function sessionUsable(session: SessionRow, agentId: string, visitorId: string, isTest: boolean, now: Date): boolean {
  return (
    session.agentId === agentId &&
    session.isTest === isTest &&
    safeSecretEquals(session.visitorId, visitorId) &&
    now.getTime() - session.lastActivityAt.getTime() <= SESSION_RESUME_DAYS * 86_400_000
  )
}

// --- Műveletek ---

export async function handlePublicChat(
  deps: PublicChatDeps,
  input: { slug: string; body: unknown; ip: string | null; origin: string | null },
): Promise<PublicChatResponse> {
  const now = (deps.now ?? (() => new Date()))()
  const b = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>
  const op = b.op
  if (op !== 'send' && op !== 'history' && op !== 'delete' && op !== 'ping') {
    return { status: 400, body: { error: 'bad_request' } }
  }
  if (!deps.rateLimit(`${input.ip ?? 'unknown'}|${op === 'send' ? 'send' : 'other'}`)) {
    return { status: 429, body: { error: 'rate_limited', message: 'Túl sok üzenet érkezett rövid idő alatt. Várj egy percet, és próbáld újra.' } }
  }
  const resolved = await resolvePublicAssistant(deps, { slug: input.slug, testToken: b.testToken })
  if ('state' in resolved) {
    if (resolved.state === 'not_found') return { status: 404, body: { error: 'not_found' } }
    if (resolved.state === 'unavailable') return { status: 503, body: unavailableBody(resolved) }
    return { status: 500, body: { error: 'unexpected' } }
  }
  const { row, config, isTest } = resolved

  if (op === 'ping') {
    if (!isTest && (!row.lastLoadedAt || now.getTime() - row.lastLoadedAt.getTime() > PING_THROTTLE_MS)) {
      await deps.store.markLoaded({ agentId: row.agentId, domain: originHost(b.embedOrigin) ?? originHost(input.origin), now })
    }
    return { status: 200, body: { ok: true } }
  }

  const visitorId = typeof b.visitorId === 'string' && VISITOR_RE.test(b.visitorId) ? b.visitorId : null
  if (!visitorId) return { status: 400, body: { error: 'bad_request' } }
  const sessionId = typeof b.sessionId === 'string' && UUID_RE.test(b.sessionId) ? b.sessionId : null

  if (op === 'delete') {
    // D18: „Beszélgetés törlése” — a látogató csak a saját (visitorId-hoz kötött) beszélgetéseit törölheti.
    const deleted = await deps.store.deleteVisitorSessions({ agentId: row.agentId, visitorId, sessionId: sessionId ?? undefined })
    await writeAudit(deps.audit, {
      actorType: 'system',
      action: 'public_chat.visitor_deleted',
      targetType: 'agent',
      targetId: row.agentId,
      policyDecision: 'allowed',
      metadata: { deleted, scope: sessionId ? 'session' : 'visitor' },
      tenantId: row.tenantId,
    })
    return { status: 200, body: { ok: true, deleted } }
  }

  const existing = sessionId ? await deps.store.findSession(sessionId) : null
  const session = existing && sessionUsable(existing, row.agentId, visitorId, isTest, now) ? existing : null

  if (op === 'history') {
    return {
      status: 200,
      body: session ? { sessionId: session.id, messages: session.messages } : { sessionId: null, messages: [] },
    }
  }

  // --- send ---
  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message || message.length > MAX_VISITOR_MESSAGE_CHARS) return { status: 400, body: { error: 'bad_request' } }
  const ctx = normalizeVisitorContext(b.context)
  if (!ctx.ok) return { status: 400, body: { error: 'bad_request', message: 'A kontextus túl nagy (legfeljebb 8 kB).' } }

  let active = session
  if (!active) {
    const ipHash = hashIp(deps.secret, input.ip)
    if (!isTest) {
      if (deps.verifyTurnstile && !(await deps.verifyTurnstile(typeof b.turnstileToken === 'string' ? b.turnstileToken : '', input.ip))) {
        return { status: 403, body: { error: 'bot_check_failed', message: 'Nem sikerült ellenőrizni, hogy ember vagy. Frissítsd az oldalt, és próbáld újra.' } }
      }
      if (ipHash && (await deps.store.countRecentSessionsByIp(ipHash, new Date(now.getTime() - 3_600_000))) >= NEW_SESSIONS_PER_IP_HOUR) {
        return { status: 429, body: { error: 'rate_limited', message: 'Túl sok új beszélgetés indult innen. Próbáld újra egy óra múlva.' } }
      }
    }
    active = await deps.store.createSession({
      tenantId: row.tenantId,
      agentId: row.agentId,
      visitorId,
      isTest,
      context: ctx.value,
      ipHash,
      now,
    })
  }

  const visitorTurns = active.messages.filter((m) => m.role === 'user').length
  if (visitorTurns >= config.sessionMessageLimit) {
    return {
      status: 429,
      body: {
        error: 'session_limit',
        sessionId: active.id,
        message: config.supportEmail
          ? `Ebben a beszélgetésben elértük az üzenetkorlátot. Kezdj újat, vagy írj nekünk: ${config.supportEmail}`
          : 'Ebben a beszélgetésben elértük az üzenetkorlátot. Kezdj új beszélgetést.',
      },
    }
  }

  const day = platformChatBudgetDay(now)
  if ((await deps.store.spendOn({ tenantId: row.tenantId, day })) >= config.dailyBudgetUsd) {
    await writeAudit(deps.audit, {
      actorType: 'system',
      action: 'public_chat.budget_exhausted',
      targetType: 'agent',
      targetId: row.agentId,
      policyDecision: 'denied',
      metadata: { day, budgetUsd: config.dailyBudgetUsd },
      tenantId: row.tenantId,
    })
    return { status: 503, body: { ...unavailableBody(config, 'Az asszisztens mára elérte a keretét, holnap újra elérhető.'), sessionId: active.id } }
  }

  const sessionRef = active
  let turn: Awaited<ReturnType<typeof runPublicTurn>>
  try {
    turn = await runPublicTurn(
    deps.turnDeps({
      tenantId: row.tenantId,
      agentId: row.agentId,
      sessionId: sessionRef.id,
      isTest,
      config,
      transcript: () => [...sessionRef.messages, { role: 'user', content: message, at: now.toISOString() }],
    }),
    { config, context: sessionRef.context ?? ctx.value, history: sessionRef.messages, userMessage: message },
    )
  } catch (error) {
    deps.onError?.(error)
    return {
      status: 503,
      body: { ...unavailableBody(config, 'Most nem tudok válaszolni, kérlek, próbáld újra egy perc múlva.'), sessionId: sessionRef.id },
    }
  }
  if (turn.costUsd > 0) await deps.store.addSpend({ tenantId: row.tenantId, day, costUsd: turn.costUsd })
  const at = now.toISOString()
  const messages: TranscriptEntry[] = [
    ...sessionRef.messages,
    { role: 'user', content: message, at },
    { role: 'assistant', content: turn.reply, at: new Date().toISOString() },
  ]
  await deps.store.saveTurn({
    sessionId: sessionRef.id,
    messages,
    ...(turn.handoff && turn.handoffContact && turn.handoffSummary
      ? { handoff: { kind: turn.handoff === 'emailed' ? 'forwarded' : 'callback_requested', contact: turn.handoffContact, summary: turn.handoffSummary } }
      : {}),
    now,
  })
  return { status: 200, body: { sessionId: sessionRef.id, reply: turn.reply, handoff: turn.handoff } }
}

function originHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return new URL(value).host.slice(0, 200) || null
  } catch {
    return null
  }
}
