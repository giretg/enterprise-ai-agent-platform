/** #1111: a hangszolgáltató felülete. A beszélgetés-indítás logikája nem hivatkozhat konkrét szolgáltatóra. */
import type { ReasoningEffort } from '@/lib/agent-model-config'

export type VoiceProviderFailureCode = 'provider_key_rejected' | 'provider_no_access' | 'provider_quota' | 'provider_error'

export type VoiceBrowserSessionInput = {
  apiKey: string
  sdpOffer: string
  voice: string
  voiceInstructions: string
  backendInstructions: string
  greeting: string
  backendReasoningEffort: ReasoningEffort
  mcp: {
    serverUrl: string
    /** Rövid életű token; a böngészőbe nem kerül. */
    token: string
    headers: Record<string, string>
    allowedTools: string[]
  }
}

export type VoiceBrowserSessionResult =
  | { ok: true; sessionId: string; sdpAnswer: string }
  | { ok: false; code: VoiceProviderFailureCode }

export type VoiceProvider = {
  id: string
  model: string
  startBrowserSession(input: VoiceBrowserSessionInput): Promise<VoiceBrowserSessionResult>
}
