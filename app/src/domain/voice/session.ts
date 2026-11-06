/**
 * #1111 hang-pilot: böngészős hang-beszélgetés indítása és lezárásának naplózása.
 * Minden indítás előtt: munkatárs-típus, hang-kapcsoló, publikált definíció, hozzáférés, céges kulcs.
 */
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import type { AgentDefinitionSnapshot } from '@/domain/agent-definition'
import { CHAT_TURN_TOKEN_AUDIENCE, signChatToken, usableChatTokenKey } from '@/domain/platform-chat/chat-token'
import { readVoiceConfig, VOICE_DEFAULT_REASONING_EFFORT, VOICE_MAX_SESSION_SECONDS, VOICE_TOKEN_TTL_SECONDS } from '@/domain/voice/config'
import { buildVoiceGreeting, buildVoiceInstructions } from '@/domain/voice/prompt'
import type { VoiceProvider, VoiceProviderFailureCode } from '@/domain/voice/provider'
import { redactSensitiveText } from '@/domain/privacy/sensitivity-match-spans'
import { parseAgentModelConfig } from '@/lib/agent-model-config'
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
  loadAgent: (input: { tenantId: string; agentId: string }) => Promise<{ kind: string; voiceConfig: unknown; modelConfig?: unknown } | null>
  /** Publikált + a user láthatja (ugyanaz a szabály, mint az MCP-n). */
  loadUsableDefinition: (input: {
    tenantId: string
    userId: string
    role: UserRole
    agentId: string
  }) => Promise<{ snapshot: Pick<AgentDefinitionSnapshot, 'name' | 'roleInstruction' | 'rules'> } | null>
  loadApiKey: (tenantId: string) => Promise<string | null>
  /** Elkerül-e az átirat szövege a naplóba: ettől függ, elhangzik-e az erről szóló tájékoztatás. */
  transcriptRecorded?: (input: { tenantId: string; userId: string; agentId: string }) => Promise<boolean>
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
  const now = (deps.now ?? (() => new Date()))()
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
    now,
    VOICE_TOKEN_TTL_SECONDS,
  )
  const instructions = buildVoiceInstructions(definition.snapshot, now)
  // Ha a lekérdezés nem sikerül, inkább elhangozzon a tájékoztatás, mint hogy tudtán kívül rögzítsük a hívót.
  const transcriptRecorded = deps.transcriptRecorded
    ? await deps.transcriptRecorded({ tenantId: input.tenantId, userId: input.userId, agentId }).catch(() => true)
    : false
  const greeting = buildVoiceGreeting(definition.snapshot.name, config.greeting, transcriptRecorded)
  const started = await deps.provider.startBrowserSession({
    apiKey,
    sdpOffer: sdp,
    voice: config.voice,
    voiceInstructions: instructions.voice,
    backendInstructions: instructions.backend,
    greeting,
    backendReasoningEffort: parseAgentModelConfig(agent.modelConfig)?.reasoningEffort ?? VOICE_DEFAULT_REASONING_EFFORT,
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

const transcriptSchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant', 'tool']),
      text: z.string().max(8000),
      atSeconds: z.number().min(0).max(86_400).optional(),
    }),
  )
  .min(1)
  .max(300)

const backendWaitsSchema = z.array(z.number().min(0).max(3_600_000)).max(100)

const boundedNumber = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : null

/**
 * A beszélgetés vége és a mért idők a böngésző jelentése, ezért csak tájékoztató adat.
 * Csak a felhasználó saját, még le nem zárt beszélgetéséhez írható sor, így az audit-láncba nem kerülhet kitalált lezárás.
 */
export async function recordVoiceSessionEnd(
  deps: {
    audit?: AuditSink
    sessionAwaitsEnd: (input: { tenantId: string; userId: string; agentId: string; sessionId: string }) => Promise<boolean>
    recordTranscript?: (input: {
      tenantId: string
      userId: string
      agentId: string
      sessionId: string
      lines: unknown[]
      meta: Record<string, unknown>
    }) => Promise<void>
  },
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
  const scope = { tenantId: input.tenantId, userId: input.userId, agentId: b.agentId, sessionId: b.sessionId }
  if (!(await deps.sessionAwaitsEnd(scope))) return { ok: false }
  const measured = {
    seconds: boundedNumber(b.seconds, 86_400),
    backendCalls: boundedNumber(b.backendCalls, 10_000),
    avgBackendWaitMs: boundedNumber(b.avgBackendWaitMs, 3_600_000),
    maxBackendWaitMs: boundedNumber(b.maxBackendWaitMs, 3_600_000),
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
      ...measured,
    },
    tenantId: input.tenantId,
  })
  // Az átirat a böngésző jelentése, és csak az AI-naplóba kerül, titkosítva. A hibája nem bukhat el a lezárást.
  const transcript = transcriptSchema.safeParse(b.transcript)
  if (transcript.success && deps.recordTranscript) {
    const waits = backendWaitsSchema.safeParse(b.backendWaitsMs)
    await deps
      .recordTranscript({
        ...scope,
        // A hang nem a modell-kapun megy át, ezért a kártyaszám és társai itt maradnak ki a naplóból (DPIA 1. pont).
        lines: transcript.data.map((line) => ({ ...line, text: redactSensitiveText(line.text).text })),
        meta: {
          ...measured,
          reportedBy: 'browser',
          truncated: b.transcriptTruncated === true,
          backendWaitsMs: waits.success ? waits.data.map(Math.round) : [],
        },
      })
      .catch((error: unknown) => console.warn('[voice] saving the transcript failed', error instanceof Error ? error.name : 'unknown'))
  }
  return { ok: true }
}
