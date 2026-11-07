/**
 * #1107 F4: ElevenLabs Agents böngészős (WebRTC) beszélgetés. Az ElevenLabs-részletek itt vannak.
 *
 * A munkaköri leírás nem mehet a böngészőn át, mert a kliens-felülírásokat a böngésző küldi, és átírhatná.
 * Ezért minden indítás előtt a szerver írja át a szolgáltatónál tárolt agentet, a felülírások pedig tiltottak.
 */
import type { ElevenLabsProviderState } from '@/domain/voice/config'
import { voiceCredentialFingerprint } from '@/domain/voice/provider-credential'
import type { VoiceBrowserSessionInput, VoiceBrowserSessionResult, VoiceProvider, VoiceProviderFailureCode } from '@/domain/voice/provider'

export const ELEVENLABS_API_BASE_URL = 'https://api.elevenlabs.io/v1'
export const ELEVENLABS_MODEL = 'elevenlabs_agents'
/** A magyart támogatja, és a leggyorsabb; a v2 multilingual modell nem tud magyarul. */
const TTS_MODEL = 'eleven_flash_v2_5'
const REQUEST_TIMEOUT_MS = 15_000
/** A dokumentált alap a korlátlan megőrzés és a hangfelvétel, ezért mindkettőt kifejezetten állítjuk. */
const TRANSCRIPT_RETENTION_DAYS = 30
const TOOL_TIMEOUT_SECONDS = 20

class ElevenLabsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly step: string,
  ) {
    super(`elevenlabs ${step} ${status}`)
  }
}

export function mapElevenLabsFailure(status: number): VoiceProviderFailureCode {
  if (status === 401) return 'provider_key_rejected'
  if (status === 403 || status === 404) return 'provider_no_access'
  if (status === 402 || status === 429) return 'provider_quota'
  return 'provider_error'
}

export function buildMcpServerSettings(input: VoiceBrowserSessionInput, secretId: string, conversationHeaderName: string) {
  return {
    approval_policy: 'auto_approve_all',
    pre_tool_speech: 'auto',
    tool_call_sound: 'typing',
    response_timeout_secs: TOOL_TIMEOUT_SECONDS,
    request_headers: {
      authorization: { secret_id: secretId },
      ...input.mcp.headers,
      // A szolgáltató hívásonként helyettesíti be; a szerver ebből tudja meg, kinek a beszélgetése ez.
      [conversationHeaderName]: { variable_name: 'system__conversation_id' },
    },
  }
}

export function buildAgentSettings(input: VoiceBrowserSessionInput, mcpServerId: string) {
  return {
    name: `Excellence AI: ${input.agentName}`.slice(0, 120),
    conversation_config: {
      agent: {
        first_message: input.greeting,
        // Az AI-tájékoztatás ebben van, ezért nem szakítható félbe.
        disable_first_message_interruptions: true,
        language: 'hu',
        prompt: { prompt: input.directInstructions, mcp_server_ids: [mcpServerId] },
      },
      tts: { model_id: TTS_MODEL, ...(input.voice ? { voice_id: input.voice } : {}) },
      conversation: {
        max_duration_seconds: input.maxSeconds,
        client_events: ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'agent_tool_request', 'agent_tool_response'],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        conversation_config_override: {
          agent: { first_message: false, language: false, prompt: { prompt: false, llm: false, tool_ids: false, native_mcp_server_ids: false, knowledge_base: false } },
          tts: { voice_id: false, model_id: false },
          conversation: { max_duration_seconds: false },
        },
      },
      privacy: { record_voice: false, retention_days: TRANSCRIPT_RETENTION_DAYS },
    },
  }
}

export function createElevenLabsProvider(options: { conversationHeaderName: string; fetchImpl?: typeof fetch }): VoiceProvider {
  const fetchImpl = options.fetchImpl ?? fetch

  async function call<T>(apiKey: string, step: string, path: string, method: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${ELEVENLABS_API_BASE_URL}${path}`, {
      method,
      headers: { 'xi-api-key': apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new ElevenLabsRequestError(response.status, step)
    return (await response.json().catch(() => ({}))) as T
  }

  /** Minden indításnál újraírja a beállítást, így a kézi módosítás vagy a régi leírás nem marad érvényben. */
  async function provision(input: VoiceBrowserSessionInput, previous: ElevenLabsProviderState | undefined): Promise<ElevenLabsProviderState> {
    const { apiKey } = input
    const fingerprint = voiceCredentialFingerprint(input.mcp.providerCredential)
    let secretId = previous?.credentialFingerprint === fingerprint ? previous.secretId : undefined
    if (!secretId) {
      const created = await call<{ secret_id?: string }>(apiKey, 'secret', '/convai/secrets', 'POST', {
        type: 'new',
        name: `excellence_ai_mcp_${crypto.randomUUID()}`,
        value: `Bearer ${input.mcp.providerCredential}`,
      })
      secretId = requireId(created.secret_id, 'secret')
    }
    const settings = buildMcpServerSettings(input, secretId, options.conversationHeaderName)
    let mcpServerId = previous?.mcpServerId
    if (mcpServerId) {
      await call(apiKey, 'mcp_update', `/convai/mcp-servers/${encodeURIComponent(mcpServerId)}`, 'PATCH', settings)
    } else {
      const created = await call<{ id?: string }>(apiKey, 'mcp_create', '/convai/mcp-servers', 'POST', {
        config: { url: input.mcp.serverUrl, name: `Excellence AI: ${input.agentName}`.slice(0, 120), transport: 'STREAMABLE_HTTP', ...settings },
      })
      mcpServerId = requireId(created.id, 'mcp_create')
    }
    const agentSettings = buildAgentSettings(input, mcpServerId)
    let agentId = previous?.agentId
    if (agentId) {
      await call(apiKey, 'agent_update', `/convai/agents/${encodeURIComponent(agentId)}`, 'PATCH', agentSettings)
    } else {
      const created = await call<{ agent_id?: string }>(apiKey, 'agent_create', '/convai/agents/create', 'POST', agentSettings)
      agentId = requireId(created.agent_id, 'agent_create')
    }
    return { agentId, mcpServerId, secretId, credentialFingerprint: fingerprint }
  }

  return {
    id: 'elevenlabs',
    model: ELEVENLABS_MODEL,
    needsSdpOffer: false,
    async startBrowserSession(input): Promise<VoiceBrowserSessionResult> {
      const previous = input.providerState as ElevenLabsProviderState | undefined
      try {
        let state: ElevenLabsProviderState
        try {
          state = await provision(input, previous)
        } catch (error) {
          // A szolgáltatónál törölt elemet egyszer újra létrehozzuk, különben a munkatárs végleg hibás maradna.
          if (!previous || !(error instanceof ElevenLabsRequestError) || error.status !== 404) throw error
          state = await provision(input, undefined)
        }
        const token = await call<{ token?: unknown; conversation_id?: unknown }>(
          input.apiKey,
          'token',
          `/convai/conversation/token?agent_id=${encodeURIComponent(state.agentId)}`,
          'GET',
        )
        // Azonosító nélkül az eszközhívások nem köthetők a felhasználóhoz, ezért el sem indítjuk.
        if (typeof token.token !== 'string' || !token.token || typeof token.conversation_id !== 'string' || !token.conversation_id) {
          console.warn('[voice] elevenlabs token response is missing the token or the conversation id')
          return { ok: false, code: 'provider_error' }
        }
        return { ok: true, sessionId: token.conversation_id, conversationToken: token.token, providerState: state }
      } catch (error) {
        if (error instanceof ElevenLabsRequestError) {
          console.warn('[voice] elevenlabs request rejected', error.step, error.status)
          return { ok: false, code: mapElevenLabsFailure(error.status) }
        }
        console.warn('[voice] elevenlabs request failed', error instanceof Error ? error.name : 'unknown')
        return { ok: false, code: 'provider_error' }
      }
    },
  }
}

function requireId(value: string | undefined, step: string): string {
  if (typeof value !== 'string' || !value) throw new ElevenLabsRequestError(502, step)
  return value
}
