/** #1111: OpenAI GPT-Live böngészős (WebRTC) munkamenet. A szerveroldali OpenAI-részletek itt vannak; az adatcsatorna eseményeit a `voice-call-events` dolgozza fel. */
import { OPENAI_BASE_URL } from '@/lib/openai-tenant-key'
import type { VoiceBrowserSessionInput, VoiceBrowserSessionResult, VoiceProvider, VoiceProviderFailureCode } from '@/domain/voice/provider'

export const OPENAI_LIVE_MODEL = 'gpt-live-1'
export const OPENAI_LIVE_BACKEND_MODEL = 'gpt-6-luna'
const REQUEST_TIMEOUT_MS = 15_000

export function buildLiveSessionRequest(input: VoiceBrowserSessionInput, backendModel = OPENAI_LIVE_BACKEND_MODEL) {
  return {
    session: {
      model: OPENAI_LIVE_MODEL,
      instructions: input.voiceInstructions,
      audio: { output: { voice: input.voice } },
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: `Kezdd a beszélgetést ezzel a mondattal, majd várd meg a választ: ${input.greeting}` }],
        },
      ],
      // A böngésző csak lezárni és az első mondatot kérni tudja, a beállításokat nem írhatja át.
      client: { data_channel: { allowed_client_events: ['session.close', 'session.commentary.append'] } },
      delegation: {
        type: 'responses',
        responses: {
          model: backendModel,
          instructions: input.backendInstructions,
          tool_choice: 'auto',
          tools: [
            {
              type: 'mcp',
              server_label: 'platform',
              server_url: input.mcp.serverUrl,
              authorization: input.mcp.token,
              headers: input.mcp.headers,
              allowed_tools: input.mcp.allowedTools,
              require_approval: 'never',
            },
          ],
        },
      },
    },
    transport: { type: 'webrtc', sdp: input.sdpOffer },
  }
}

export function mapLiveFailure(status: number, errorCode: string | undefined): VoiceProviderFailureCode {
  if (status === 401) return 'provider_key_rejected'
  if (status === 403 || status === 404 || errorCode === 'model_not_found') return 'provider_no_access'
  if (status === 402 || status === 429) return 'provider_quota'
  return 'provider_error'
}

export function createOpenAiLiveProvider(options: { fetchImpl?: typeof fetch; backendModel?: string } = {}): VoiceProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    id: 'openai_live',
    model: OPENAI_LIVE_MODEL,
    async startBrowserSession(input): Promise<VoiceBrowserSessionResult> {
      let response: Response
      try {
        response = await fetchImpl(`${OPENAI_BASE_URL}/live/sessions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(buildLiveSessionRequest(input, options.backendModel)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        console.warn('[voice] openai live session request failed', error instanceof Error ? error.name : 'unknown')
        return { ok: false, code: 'provider_error' }
      }
      const payload = (await response.json().catch(() => null)) as {
        session?: { id?: unknown }
        transport?: { sdp?: unknown }
        error?: { code?: unknown; type?: unknown }
      } | null
      if (!response.ok) {
        const errorCode = typeof payload?.error?.code === 'string' ? payload.error.code : undefined
        console.warn('[voice] openai live session rejected', response.status, errorCode ?? payload?.error?.type ?? 'unknown')
        return { ok: false, code: mapLiveFailure(response.status, errorCode) }
      }
      const sessionId = payload?.session?.id
      const sdpAnswer = payload?.transport?.sdp
      if (typeof sessionId !== 'string' || typeof sdpAnswer !== 'string' || !sdpAnswer) {
        console.warn('[voice] openai live session response is missing the session id or SDP answer')
        return { ok: false, code: 'provider_error' }
      }
      return { ok: true, sessionId, sdpAnswer }
    },
  }
}
