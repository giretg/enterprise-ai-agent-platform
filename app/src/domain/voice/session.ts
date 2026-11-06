/**
 * #1111 hang-pilot: böngészős hang-beszélgetés indítása és lezárásának naplózása.
 * Minden indítás előtt: munkatárs-típus, hang-kapcsoló, publikált definíció, hozzáférés, céges kulcs.
 */
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import type { AgentDefinitionSnapshot } from '@/domain/agent-definition'
import { CHAT_TURN_TOKEN_AUDIENCE, signChatToken, usableChatTokenKey } from '@/domain/platform-chat/chat-token'
import { readVoiceConfig, VOICE_MAX_SESSION_SECONDS, VOICE_TOKEN_TTL_SECONDS } from '@/domain/voice/config'
import { buildVoiceGreeting, buildVoiceInstructions } from '@/domain/voice/prompt'
import type { VoiceProvider, VoiceProviderFailureCode } from '@/domain/voice/provider'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SDP_CHARS = 64_000

export type VoiceSessionFailureCode =
  | 'bad_request'
  | 'agent_unavailable'
  | 'voice_disabled'
  | 'key_missing'
  | 'not_configured'
  | VoiceProviderFailureCode

export type VoiceSessionDeps = {
  signingKey: string | undefined
  publicOrigin: string
  agentHeaderName: string
  allowedTools: string[]
  provider: VoiceProvider
  loadTenantSlug: (tenantId: string) => Promise<string | null>
  loadAgent: (input: { tenantId: string; agentId: string }) => Promise<{ kind: string; voiceConfig: unknown } | null>
  /** Publikált + a user láthatja (ugyanaz a szabály, mint az MCP-n). */
  loadUsableDefinition: (input: {
    tenantId: string
    userId: string
    role: UserRole
    agentId: string
  }) => Promise<{ snapshot: Pick<AgentDefinitionSnapshot, 'name' | 'roleInstruction' | 'rules'> } | null>
  loadApiKey: (tenantId: string) => Promise<string | null>
  audit?: AuditSink
  now?: () => Date
}

export type VoiceSessionResult =
  | { ok: true; sessionId: string; sdpAnswer: string; greeting: string; maxSeconds: number }
  | { ok: false; code: VoiceSessionFailureCode }

export async function startVoiceSession(
  deps: VoiceSessionDeps,
  input: { userId: string; tenantId: string; role: UserRole; body: unknown },
): Promise<VoiceSessionResult> {
  const signingKey = usableChatTokenKey(deps.signingKey)
  if (!signingKey) return { ok: false, code: 'not_configured' }
  const body = (input.body ?? {}) as Record<string, unknown>
  const { agentId, sdp } = body
  if (
    typeof agentId !== 'string' ||
    !UUID_RE.test(agentId) ||
    typeof sdp !== 'string' ||
    !sdp.startsWith('v=0') ||
    sdp.length > MAX_SDP_CHARS
  ) {
    return { ok: false, code: 'bad_request' }
  }
  const scope = { tenantId: input.tenantId, agentId }
  const agent = await deps.loadAgent(scope)
  if (!agent || agent.kind !== 'internal') return { ok: false, code: 'agent_unavailable' }
  const config = readVoiceConfig(agent.voiceConfig)
  if (!config.enabled) return { ok: false, code: 'voice_disabled' }
  const definition = await deps.loadUsableDefinition({ ...scope, userId: input.userId, role: input.role })
  if (!definition) return { ok: false, code: 'agent_unavailable' }
  const tenantSlug = await deps.loadTenantSlug(input.tenantId)
  if (!tenantSlug) return { ok: false, code: 'agent_unavailable' }
  const apiKey = await deps.loadApiKey(input.tenantId)
  if (!apiKey) return { ok: false, code: 'key_missing' }

  const turnId = `voice-${randomUUID()}`
  const { token, claims } = signChatToken(
    {
      aud: CHAT_TURN_TOKEN_AUDIENCE,
      sub: input.userId,
      tenant: tenantSlug,
      tid: input.tenantId,
      role: input.role,
      adminInsight: false,
      turnId,
      agentId,
      voice: true,
    },
    signingKey,
    (deps.now ?? (() => new Date()))(),
    VOICE_TOKEN_TTL_SECONDS,
  )
  const instructions = buildVoiceInstructions(definition.snapshot)
  const greeting = buildVoiceGreeting(definition.snapshot.name, config.greeting)
  const started = await deps.provider.startBrowserSession({
    apiKey,
    sdpOffer: sdp,
    voice: config.voice,
    voiceInstructions: instructions.voice,
    backendInstructions: instructions.backend,
    greeting,
    mcp: {
      serverUrl: `${deps.publicOrigin}/api/mcp/${encodeURIComponent(tenantSlug)}`,
      token,
      headers: { [deps.agentHeaderName]: agentId },
      allowedTools: deps.allowedTools,
    },
  })
  if (!started.ok) return started
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: input.userId,
    action: 'voice.session_started',
    targetType: 'agent',
    targetId: agentId,
    policyDecision: 'allowed',
    metadata: { provider: deps.provider.id, model: deps.provider.model, sessionId: started.sessionId, turnId, jti: claims.jti },
    tenantId: input.tenantId,
  })
  return { ok: true, sessionId: started.sessionId, sdpAnswer: started.sdpAnswer, greeting, maxSeconds: VOICE_MAX_SESSION_SECONDS }
}

const boundedNumber = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : null

/** A beszélgetés vége és a mért idők a böngésző jelentése, ezért csak tájékoztató adat. */
export async function recordVoiceSessionEnd(
  deps: { audit?: AuditSink },
  input: { userId: string; tenantId: string; body: unknown },
): Promise<{ ok: boolean }> {
  const b = (input.body ?? {}) as Record<string, unknown>
  if (
    typeof b.agentId !== 'string' ||
    !UUID_RE.test(b.agentId) ||
    typeof b.sessionId !== 'string' ||
    !/^[\w-]{1,128}$/.test(b.sessionId)
  ) {
    return { ok: false }
  }
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: input.userId,
    action: 'voice.session_ended',
    targetType: 'agent',
    targetId: b.agentId,
    policyDecision: 'allowed',
    metadata: {
      reportedBy: 'browser',
      sessionId: b.sessionId,
      closeReason: typeof b.reason === 'string' ? b.reason.slice(0, 40) : null,
      seconds: boundedNumber(b.seconds, 86_400),
      backendCalls: boundedNumber(b.backendCalls, 10_000),
      avgBackendWaitMs: boundedNumber(b.avgBackendWaitMs, 3_600_000),
      maxBackendWaitMs: boundedNumber(b.maxBackendWaitMs, 3_600_000),
    },
    tenantId: input.tenantId,
  })
  return { ok: true }
}
