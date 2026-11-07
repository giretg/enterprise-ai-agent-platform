/**
 * Hangszolgáltatói MCP-azonosítás (#1107 K3). Az ElevenLabsnél az MCP-kapcsolat a szolgáltatónál beállított,
 * tartós adat, hívásonkénti token nem adható át a böngésző érintése nélkül. Ezért két dolog együtt kell:
 * a munkatárshoz kötött titok, és egy futó beszélgetés azonosítója, amelyből a szerver tudja, kinek a nevében fut.
 */
import { createHash, createHmac } from 'node:crypto'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import { CHAT_TURN_TOKEN_AUDIENCE, usableChatTokenKey, type ChatTokenClaims } from '@/domain/platform-chat/chat-token'
import { normalizeTenantSlug } from '@/lib/tenant-policy'
import { readVoiceConfig, VOICE_TOKEN_TTL_SECONDS, type VoiceProviderId } from '@/domain/voice/config'

const PREFIX = 'evc1.'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONVERSATION_ID_RE = /^[\w-]{1,128}$/

export const MCP_VOICE_CONVERSATION_HEADER = 'x-excellence-voice-conversation'

export function isVoiceProviderCredential(token: string): boolean {
  return token.startsWith(PREFIX)
}

/** Nem tároljuk: az aláíró kulcsból, a szervezetből és a munkatársból számolható, így egy szivárgás csak egy munkatárst érint. */
export function voiceProviderMcpCredential(signingKey: string, tenantId: string, agentId: string): string {
  const mac = createHmac('sha256', signingKey).update(`voice-provider-mcp-v1\0${tenantId}\0${agentId}`).digest('base64url')
  return `${PREFIX}${mac}`
}

/** Az aláíró kulcs cseréjekor változik, ezért a szolgáltatónál tárolt titok újra feltöltendő. */
export function voiceCredentialFingerprint(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 32)
}

export type VoiceProviderSessionRow = { action: string; actorId: string | null; createdAt: Date; metadata: unknown }

export type VoiceProviderClaimsDeps = {
  signingKey: string | undefined
  findTenantId: (tenantSlug: string) => Promise<string | null>
  providerEnabled: (input: { tenantId: string; providerId: VoiceProviderId }) => Promise<boolean>
  loadAgent: (input: { tenantId: string; agentId: string }) => Promise<{ kind: string; voiceConfig: unknown } | null>
  /** A beszélgetés indítási és lezárási auditsorai. */
  loadSessionRows: (input: { tenantId: string; agentId: string; sessionId: string; since: Date }) => Promise<VoiceProviderSessionRow[]>
  now?: () => Date
}

export async function resolveVoiceProviderClaims(
  deps: VoiceProviderClaimsDeps,
  input: { credential: string; tenantSlug: string; agentId: string | null; conversationId: string | null },
): Promise<ChatTokenClaims | null> {
  const signingKey = usableChatTokenKey(deps.signingKey)
  const { agentId, conversationId } = input
  if (!signingKey || !agentId || !UUID_RE.test(agentId) || !conversationId || !CONVERSATION_ID_RE.test(conversationId)) return null
  const tenantSlug = normalizeTenantSlug(input.tenantSlug)
  const tenantId = tenantSlug ? await deps.findTenantId(tenantSlug) : null
  if (!tenantSlug || !tenantId) return null
  if (!safeSecretEquals(input.credential, voiceProviderMcpCredential(signingKey, tenantId, agentId))) return null
  if (!(await deps.providerEnabled({ tenantId, providerId: 'elevenlabs' }))) return null

  const agent = await deps.loadAgent({ tenantId, agentId })
  const config = agent ? readVoiceConfig(agent.voiceConfig) : null
  if (agent?.kind !== 'internal' || !config?.enabled || config.provider !== 'elevenlabs') return null

  const now = (deps.now ?? (() => new Date()))()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const rows = await deps.loadSessionRows({
    tenantId,
    agentId,
    sessionId: conversationId,
    since: new Date(now.getTime() - VOICE_TOKEN_TTL_SECONDS * 1000),
  })
  // Pontosan egy indítás, lezárás nélkül: a lezárt vagy lejárt beszélgetés azonosítója már semmit nem nyit.
  const started = rows.length === 1 && rows[0].action === 'voice.session_started' ? rows[0] : null
  const metadata = (started?.metadata ?? null) as { provider?: unknown; turnId?: unknown; jti?: unknown } | null
  if (!started?.actorId || metadata?.provider !== 'elevenlabs' || typeof metadata.turnId !== 'string') return null

  return {
    aud: CHAT_TURN_TOKEN_AUDIENCE,
    sub: started.actorId,
    tenant: tenantSlug,
    tid: tenantId,
    // A jogokat a principal a tagságból számolja újra minden kérésnél, a mező itt nem ad jogot.
    role: 'viewer',
    adminInsight: false,
    turnId: metadata.turnId,
    agentId,
    voice: true,
    jti: typeof metadata.jti === 'string' ? metadata.jti : metadata.turnId,
    iat: Math.floor(started.createdAt.getTime() / 1000),
    exp: nowSeconds + 60,
  }
}
