/**
 * Egy chat_completions kérés elküldése egy providernek. A hívó (gateway, nyilvános chat, munkatárs-
 * vázlat) mindig chat_completions választ kap, akkor is, ha a provider másik formátumot beszél.
 */
import { chatToResponsesRequest, responsesJsonToChat, responsesSseToChatSse } from './openai-responses'

export type ProviderEndpoint = {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** `responses`: a provider az OpenAI Responses API-t beszéli. Alap: chat_completions. */
  wireApi?: 'responses'
}

/**
 * Az OpenAI az elfogyott keretet 429-cel jelzi, ami a kliensnél átmeneti hibának látszik. A 402 a
 * platformon az elfogyott kredit jele (OpenRouter-minta): a chat worker erre nem próbálkozik újra.
 */
async function quotaAsPaymentRequired(res: Response): Promise<Response> {
  const text = await res.text()
  return new Response(text, { status: text.includes('insufficient_quota') ? 402 : 429, headers: res.headers })
}

export async function postChatCompletion(
  endpoint: ProviderEndpoint,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const viaResponses = endpoint.wireApi === 'responses'
  const res = await (options.fetchImpl ?? fetch)(
    `${endpoint.baseUrl}/${viaResponses ? 'responses' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...endpoint.headers,
      },
      body: JSON.stringify(viaResponses ? chatToResponsesRequest(body) : body),
      redirect: 'error',
      signal: options.signal,
    },
  )
  if (!viaResponses) return res
  // A hibatest mindkét API-n `{error}` alakú: változatlanul mehet a hívó hibakezelésébe.
  if (!res.ok) return res.status === 429 ? quotaAsPaymentRequired(res) : res
  if (body.stream === true) {
    if (!res.body) return res
    return new Response(res.body.pipeThrough(responsesSseToChatSse(body.model)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
  }
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return new Response(text, { status: 200 })
  }
  return new Response(JSON.stringify(responsesJsonToChat(data, body.model)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
