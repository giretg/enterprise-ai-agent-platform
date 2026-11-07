/** #1111: a hangszolgáltató felülete. A beszélgetés-indítás logikája nem hivatkozhat konkrét szolgáltatóra. */
import type { VoiceProviderId } from '@/domain/voice/config'
import type { ReasoningEffort } from '@/lib/agent-model-config'

export type VoiceProviderFailureCode = 'provider_key_rejected' | 'provider_no_access' | 'provider_quota' | 'provider_error'

export type VoiceBrowserSessionInput = {
  apiKey: string
  /** Üres, ha a szolgáltató nem kér a böngészőtől SDP-ajánlatot. */
  sdpOffer: string
  voice: string
  /** Külön beszélő és háttérmodellhez. */
  voiceInstructions: string
  backendInstructions: string
  /** Ha ugyanaz a modell beszél és használja az eszközöket. */
  directInstructions: string
  greeting: string
  backendReasoningEffort: ReasoningEffort
  agentName: string
  maxSeconds: number
  mcp: {
    serverUrl: string
    /** Rövid életű token; a böngészőbe nem kerül. */
    token: string
    /** Tartós, munkatárshoz kötött titok azoknak a szolgáltatóknak, amelyek nem kaphatnak hívásonkénti tokent. */
    providerCredential: string
    headers: Record<string, string>
    allowedTools: string[]
  }
  /** A szolgáltató korábban visszaadott állapota. */
  providerState?: unknown
}

export type VoiceBrowserSessionResult =
  | {
      ok: true
      sessionId: string
      sdpAnswer?: string
      /** A böngésző ezzel csatlakozik; csak ehhez a beszélgetéshez jó, API-hozzáférést nem ad. */
      conversationToken?: string
      providerState?: unknown
    }
  | { ok: false; code: VoiceProviderFailureCode }

export type VoiceProvider = {
  id: VoiceProviderId
  model: string
  needsSdpOffer: boolean
  startBrowserSession(input: VoiceBrowserSessionInput): Promise<VoiceBrowserSessionResult>
}
