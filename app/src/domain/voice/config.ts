/** #1111 hang-pilot: a munkatárs hang-beállítása. Szolgáltató-független, a `Agent.voiceConfig` mezőben él. */
import { z } from 'zod'

/** A GPT-Live beépített hangjaiból egy rövid válogatás; az alap a szolgáltató alapértelmezése. */
export const VOICE_NAMES = ['marin', 'cedar', 'coral', 'sage', 'verse', 'ash'] as const
export const VOICE_GREETING_MAX_CHARS = 300
/** Egy beszélgetés leghosszabb ideje. A böngésző tartja be, ezért a token is ehhez igazodik. */
export const VOICE_MAX_SESSION_SECONDS = 600
export const VOICE_TOKEN_TTL_SECONDS = VOICE_MAX_SESSION_SECONDS + 120

const schema = z.object({
  enabled: z.boolean(),
  voice: z.enum(VOICE_NAMES),
  greeting: z.string().trim().max(VOICE_GREETING_MAX_CHARS),
})

export type AgentVoiceConfig = z.infer<typeof schema>

export const DEFAULT_VOICE_CONFIG: AgentVoiceConfig = { enabled: false, voice: 'marin', greeting: '' }

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
