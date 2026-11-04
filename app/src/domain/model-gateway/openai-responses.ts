/**
 * Chat Completions ↔ OpenAI Responses API fordítás.
 *
 * A mai OpenAI-modellek (GPT-6 család) eszközt csak a Responses API-n hívnak, a platform kliensei
 * (Hermes, platform-chat worker, nyilvános chat) viszont `chat_completions` formátumot beszélnek.
 * A fordítás ezért a provider-hívás szélén történik: a kliens, az audit, a tartalomszűrő és a
 * tartalék-lánc változatlanul chat_completions választ lát.
 * Forrás: developers.openai.com/api/docs/guides/migrate-to-responses, .../guides/latest-model
 *
 * ponytail: a reasoning itemek nem jutnak vissza a következő körbe, mert a chat_completions kliensek
 * nem őrzik meg őket (`store: false` mellett az `encrypted_content` veszne). A hívás így is működik,
 * csak a modell eszközkörönként újragondolkodik; tokent spórolna, ha a kliens továbbadná őket.
 */
type Json = Record<string, unknown>

const isObj = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** A `max_output_tokens` a gondolkodást is tartalmazza: ennyit tartunk fenn rá (OpenAI-ajánlás). */
const REASONING_HEADROOM_TOKENS = 25_000
const MIN_OUTPUT_TOKENS = 16
const MAX_OUTPUT_TOKENS = 128_000
const MAX_CALL_ID_LENGTH = 64

/**
 * USD / millió token, developers.openai.com/api/docs/pricing (2026-11-04, Standard).
 * ponytail: a 272K feletti felár és a cache-írás díja nincs benne; a napi keret becslése ettől kicsit alacsonyabb.
 * Ismeretlen modellnél nincs `cost`, ilyenkor a platform-chat egységes becslése számol.
 */
const USD_PER_MTOK: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
}

/** A Responses a `call_id`-t 64 karakterben korlátozza; más providertől örökölt id lehet hosszabb. */
const callId = (id: unknown): string => (typeof id === 'string' ? id.slice(-MAX_CALL_ID_LENGTH) : '')

function inputContent(content: unknown): string | Json[] {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: Json[] = []
  for (const part of content) {
    if (!isObj(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image_url') {
      const image = part.image_url
      const url = isObj(image) ? image.url : image
      if (typeof url !== 'string') continue
      const detail = isObj(image) && typeof image.detail === 'string' ? { detail: image.detail } : {}
      parts.push({ type: 'input_image', image_url: url, ...detail })
    } else if (part.type === 'file' && isObj(part.file)) {
      parts.push({ type: 'input_file', ...part.file })
    }
  }
  return parts
}

function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isObj(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function toInputItems(messages: unknown): Json[] {
  const items: Json[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isObj(message)) continue
    switch (message.role) {
      case 'system':
      case 'developer':
        items.push({ role: 'developer', content: inputContent(message.content) })
        break
      case 'user':
        items.push({ role: 'user', content: inputContent(message.content) })
        break
      case 'assistant': {
        const text = plainText(message.content)
        if (text) items.push({ role: 'assistant', content: text })
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          if (!isObj(call) || !isObj(call.function)) continue
          const args = call.function.arguments
          items.push({
            type: 'function_call',
            call_id: callId(call.id),
            name: call.function.name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          })
        }
        break
      }
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: callId(message.tool_call_id),
          output: inputContent(message.content),
        })
        break
    }
  }
  return items
}

function toTools(tools: unknown): Json[] {
  const out: Json[] = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObj(tool) || tool.type !== 'function' || !isObj(tool.function)) continue
    const { name, description, parameters, strict } = tool.function
    // A Responses `strict` nélkül szigorú sémát próbál; a chat_completions alapértéke a nem szigorú.
    out.push({ type: 'function', name, description, parameters, strict: strict === true })
  }
  return out
}

function toToolChoice(choice: unknown): unknown {
  return isObj(choice) && isObj(choice.function) ? { type: 'function', name: choice.function.name } : choice
}

function toTextFormat(format: unknown): Json | null {
  if (!isObj(format)) return null
  if (format.type === 'json_schema' && isObj(format.json_schema)) {
    return { format: { type: 'json_schema', ...format.json_schema } }
  }
  return { format }
}

/** A `minimal` és (Astra/Sol esetén) a `none` érték 400-at adna; a doksi ilyenkor `low`-t ír elő. */
function reasoningEffort(model: unknown, body: Json): string | null {
  const raw = body.reasoning_effort ?? (isObj(body.reasoning) ? body.reasoning.effort : null)
  if (typeof raw !== 'string') return null
  if (raw === 'minimal' || (raw === 'none' && typeof model === 'string' && /astra|sol/i.test(model))) return 'low'
  return raw
}

export function chatToResponsesRequest(body: Json): Json {
  const effort = reasoningEffort(body.model, body)
  const tools = toTools(body.tools)
  const text = toTextFormat(body.response_format)
  const requested = body.max_completion_tokens ?? body.max_tokens
  const out: Json = {
    model: body.model,
    input: toInputItems(body.messages),
    // A kliens minden körben a teljes előzményt küldi: az OpenAI-nál nem kell tárolni.
    store: false,
    stream: body.stream === true,
    ...(tools.length
      ? {
          tools,
          ...(body.tool_choice !== undefined ? { tool_choice: toToolChoice(body.tool_choice) } : {}),
          ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
        }
      : {}),
    ...(text ? { text } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
  }
  if (typeof requested === 'number') {
    const headroom = effort === 'none' ? 0 : REASONING_HEADROOM_TOKENS
    out.max_output_tokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, requested + headroom))
  }
  // Gondolkodó modellnél a `temperature`/`top_p` 400-at ad, és a gateway az agent-konfigból mindig küldene.
  if (effort === 'none') {
    if (body.temperature !== undefined) out.temperature = body.temperature
    if (body.top_p !== undefined) out.top_p = body.top_p
  }
  return out
}

function toChatUsage(usage: unknown, model: unknown): Json | null {
  if (!isObj(usage)) return null
  const input = Number(usage.input_tokens ?? 0)
  const output = Number(usage.output_tokens ?? 0)
  const inputDetails = isObj(usage.input_tokens_details) ? usage.input_tokens_details : {}
  const outputDetails = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {}
  const cached = Number(inputDetails.cached_tokens ?? 0)
  const price = typeof model === 'string' ? USD_PER_MTOK[model] : undefined
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output),
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: Number(outputDetails.reasoning_tokens ?? 0) },
    ...(price
      ? { cost: ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000 }
      : {}),
  }
}

function finishReason(response: Json, sawToolCall: boolean): string {
  if (response.status === 'incomplete') {
    const reason = isObj(response.incomplete_details) ? response.incomplete_details.reason : null
    return reason === 'content_filter' ? 'content_filter' : 'length'
  }
  return sawToolCall ? 'tool_calls' : 'stop'
}

/** `{error}` alak: a hívók a 200-as hibatestet már így ismerik fel (OpenRouter-minta). */
function errorPayload(error: unknown): Json {
  const source = isObj(error) ? error : {}
  return {
    error: {
      code: source.code ?? 'provider_error',
      message: typeof source.message === 'string' ? source.message : 'The model provider returned an error.',
    },
  }
}

export function responsesJsonToChat(data: unknown, requestedModel: unknown): Json {
  if (!isObj(data)) return errorPayload(null)
  if (data.status === 'failed' || isObj(data.error)) return errorPayload(data.error)
  let text = ''
  const toolCalls: Json[] = []
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!isObj(item)) continue
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
      })
    } else if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isObj(part)) continue
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
        if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal
      }
    }
  }
  const usage = toChatUsage(data.usage, requestedModel)
  return {
    id: data.id,
    object: 'chat.completion',
    created: data.created_at,
    model: data.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason(data, toolCalls.length > 0),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

/**
 * Responses SSE → chat_completions SSE.
 *
 * Az első kimenő `data:` sor csak az első valódi kimenetnél (vagy hibánál) indul: a gateway eddig
 * válthat tartalék modellre, a `response.created` után érkező `response.failed` tehát még nem késő.
 */
export function responsesSseToChatSse(requestedModel: unknown): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  let id: unknown = null
  let created: unknown = null
  let model: unknown = requestedModel
  let roleSent = false
  let terminal = false
  const toolIndexes = new Map<unknown, number>()
  const argsStreamed = new Set<unknown>()

  const line = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
  const chunk = (delta: Json, finish: string | null = null) => {
    const withRole = roleSent ? delta : { role: 'assistant', ...delta }
    roleSent = true
    return line({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: withRole, finish_reason: finish }],
    })
  }
  const remember = (response: unknown) => {
    if (!isObj(response)) return
    id = response.id ?? id
    created = response.created_at ?? created
    model = response.model ?? model
  }
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, error: unknown) => {
    terminal = true
    controller.enqueue(line(errorPayload(error)))
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
  }

  const handle = (event: Json, controller: TransformStreamDefaultController<Uint8Array>) => {
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        remember(event.response)
        break
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof event.delta === 'string') controller.enqueue(chunk({ content: event.delta }))
        break
      case 'response.output_item.added': {
        const item = event.item
        if (!isObj(item) || item.type !== 'function_call') break
        const index = toolIndexes.size
        toolIndexes.set(event.output_index, index)
        controller.enqueue(
          chunk({
            content: null,
            tool_calls: [{ index, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }],
          }),
        )
        break
      }
      case 'response.function_call_arguments.delta':
        argsStreamed.add(event.output_index)
        controller.enqueue(
          chunk({ tool_calls: [{ index: toolIndexes.get(event.output_index) ?? 0, function: { arguments: event.delta } }] }),
        )
        break
      case 'response.function_call_arguments.done':
        // Ha a provider nem küldött deltát, a teljes argumentum itt érkezik.
        if (!argsStreamed.has(event.output_index) && typeof event.arguments === 'string') {
          controller.enqueue(
            chunk({ tool_calls: [{ index: toolIndexes.get(event.output_index) ?? 0, function: { arguments: event.arguments } }] }),
          )
        }
        break
      case 'response.completed':
      case 'response.incomplete': {
        terminal = true
        const response = isObj(event.response) ? event.response : {}
        remember(response)
        controller.enqueue(chunk({}, finishReason(response, toolIndexes.size > 0)))
        const usage = toChatUsage(response.usage, requestedModel)
        if (usage) {
          controller.enqueue(line({ id, object: 'chat.completion.chunk', created, model, choices: [], usage }))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        break
      }
      case 'response.failed':
        fail(controller, isObj(event.response) ? event.response.error : null)
        break
      case 'error':
        fail(controller, isObj(event.error) ? event.error : event)
        break
    }
  }

  const processLine = (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = raw.trim()
    if (terminal || !trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const event: unknown = JSON.parse(data)
      if (isObj(event)) handle(event, controller)
    } catch {
      // csonka/idegen SSE-sor: nem állítja meg a streamet
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) processLine(raw, controller)
    },
    flush(controller) {
      processLine(pending + decoder.decode(), controller)
      if (!terminal) fail(controller, { code: 'stream_incomplete', message: 'The response stream ended before completion.' })
    },
  })
}
