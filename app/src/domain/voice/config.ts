/** #1111 hang-pilot: a munkatárs hang-beállítása. Szolgáltató-független, a `Agent.voiceConfig` mezőben él. */
import { z } from 'zod'

/** A GPT-Live beépített hangjaiból egy rövid válogatás; az alap a szolgáltató alapértelmezése. */
export const VOICE_NAMES = ['marin', 'cedar', 'coral', 'sage', 'verse', 'ash'] as const
export const VOICE_GREETING_MAX_CHARS = 300
/** A beszélő modell ennyit kap a munkaköri leírásból; a beállítási felület figyelmeztet, ha hosszabb. */
export const VOICE_ROLE_MAX_CHARS = 8000
/** Egy beszélgetés leghosszabb ideje. A böngésző tartja be, ezért a token is ehhez igazodik. */
export const VOICE_MAX_SESSION_SECONDS = 600
export const VOICE_TOKEN_TTL_SECONDS = VOICE_MAX_SESSION_SECONDS + 120
/** Élő beszélgetésben a hívó vár a háttérre, ezért beállítás nélkül is a gyors változat fut. */
export const VOICE_DEFAULT_REASONING_EFFORT = 'low'
/** A hang-gomb kinézete: hullámforma (beszélgetős munkatárs) vagy zöld telefon (telefonos munkatárs). A hívást nem változtatja. */
export const VOICE_CALL_STYLES = ['conversation', 'phone'] as const
export type VoiceCallStyle = (typeof VOICE_CALL_STYLES)[number]

/** A munkatárshoz választható hangszolgáltatók. A beszélgetés-indítás logikája ezen kívül nem hivatkozhat rájuk. */
export const VOICE_PROVIDERS = ['openai_live', 'elevenlabs'] as const
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]

/** Az ElevenLabs oldalán létrehozott elemek azonosítói. Titok nincs köztük, és csak a szerver írja. */
const elevenLabsStateSchema = z.object({
  agentId: z.string().min(1).max(128),
  mcpServerId: z.string().min(1).max(128),
  secretId: z.string().min(1).max(128),
  credentialFingerprint: z.string().min(1).max(64),
})
export type ElevenLabsProviderState = z.infer<typeof elevenLabsStateSchema>

const schema = z.object({
  enabled: z.boolean(),
  // A mező előtt mentett beállítások az OpenAI-t használták, ezért ez az alap.
  provider: z.enum(VOICE_PROVIDERS).default('openai_live'),
  voice: z.enum(VOICE_NAMES),
  /** Üresen az ElevenLabs alapértelmezett hangja szól. */
  elevenLabsVoiceId: z.string().regex(/^[A-Za-z0-9]{10,64}$/).optional(),
  elevenLabs: elevenLabsStateSchema.optional(),
  greeting: z.string().trim().max(VOICE_GREETING_MAX_CHARS),
  // A mező előtt mentett beállítások is érvényesek maradnak, különben a hang kikapcsolna náluk.
  callStyle: z.enum(VOICE_CALL_STYLES).default('conversation'),
})

export type AgentVoiceConfig = z.infer<typeof schema>

export const DEFAULT_VOICE_CONFIG: AgentVoiceConfig = { enabled: false, provider: 'openai_live', voice: 'marin', greeting: '', callStyle: 'conversation' }

export function parseVoiceConfig(input: unknown): AgentVoiceConfig {
  return schema.parse(input)
}

/** Hibás vagy hiányzó érték esetén kikapcsolt állapot, hogy rossz adat ne indíthasson beszélgetést. */
export function readVoiceConfig(raw: unknown): AgentVoiceConfig {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_VOICE_CONFIG
}

export function canStartVoiceCall(input: {
  kind: string
  voiceConfig: unknown
  status: string
  currentDefinitionVersionId: string | null
}): boolean {
  return (
    input.kind === 'internal' &&
    readVoiceConfig(input.voiceConfig).enabled &&
    input.status === 'active' &&
    Boolean(input.currentDefinitionVersionId)
  )
}
