/**
 * Szöveges tool-hívás relay a goose harness ChatGPT-OAuth útjához (S6).
 *
 * A valódi ChatGPT-OAuth backend (Responses API) NEM ad vissza natív OpenAI
 * `tool_calls`-t — csak sima szöveget. A goose viszont natív `tool_calls`-ra
 * vár, hogy az MCP eszközt (kb_search / board_write) meghívja. E nélkül az
 * agent sosem tud `board_write`-ot futtatni, és a loop a guardrailig pörög.
 *
 * Ez a modul a már bevált, szöveg-alapú tool-protokollt (`chat-tool-loop.ts`
 * `extractToolCall`) használja: a modell `{"tool":"…","args":{…}}` JSON-t ír a
 * sima szövegbe (a recipe instrukciója szerint), mi ezt natív OpenAI
 * `tool_calls` completionná alakítjuk, így a goose lefuttatja az MCP eszközt.
 * A tool-protokoll a valódi ChatGPT-OAuth modellel a chat-flow-ban már működik.
 */

export type OpenAiToolDef = {
  type?: string
  function?: { name?: string }
}

export type ParsedTextToolCall = {
  tool: string
  args: Record<string, unknown>
}

/** A modell szövegéből kiolvassa a `{"tool":…,"args":{…}}` blokkot (code-fence vagy inline is). */
export function extractTextToolCall(content: string): ParsedTextToolCall | null {
  const trimmed = content.trim()

  const codeBlock = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  const candidates: Array<string | null | undefined> = [
    codeBlock?.[1],
    trimmed.startsWith('{') ? trimmed : null,
  ]

  const inline = trimmed.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/)
  if (inline?.[0]) candidates.push(inline[0])

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { tool?: unknown; args?: unknown }
      if (
        typeof parsed.tool === 'string' &&
        parsed.tool.trim() &&
        parsed.args &&
        typeof parsed.args === 'object' &&
        !Array.isArray(parsed.args)
      ) {
        return { tool: parsed.tool, args: parsed.args as Record<string, unknown> }
      }
    } catch {
      // próbáljuk a következő jelöltet
    }
  }
  return null
}

/**
 * A modell által megnevezett alap-toolnevet (pl. `kb_search`) a goose által
 * küldött tényleges toolnévre képezi (pl. `platform_broker__kb_search`), így a
 * visszaadott `tool_calls` névvel a goose az MCP szerverhez tud routolni.
 */
export function resolveGooseToolName(tools: OpenAiToolDef[], baseName: string): string | null {
  for (const tool of tools) {
    const name = tool.function?.name
    if (!name) continue
    if (name === baseName) return name
    const delimiter = name.lastIndexOf('__')
    if (delimiter !== -1 && name.slice(delimiter + 2) === baseName) return name
  }
  return null
}

export type OpenAiToolCallCompletion = {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: null
      tool_calls: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'tool_calls'
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function buildToolCallCompletion(input: {
  model: string
  name: string
  args: Record<string, unknown>
  usage: { promptTokens: number; completionTokens: number }
}): OpenAiToolCallCompletion {
  return {
    id: `gw_${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${input.name}_${Date.now()}`,
              type: 'function',
              function: { name: input.name, arguments: JSON.stringify(input.args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: input.usage.promptTokens,
      completion_tokens: input.usage.completionTokens,
      total_tokens: input.usage.promptTokens + input.usage.completionTokens,
    },
  }
}

/**
 * Ha a modell szövege egy érvényes, a goose által küldött toolok közül
 * választott tool-hívást tartalmaz, visszaad egy natív `tool_calls`
 * completiont. Egyébként `null` → a hívó sima szöveges (finish_reason: stop)
 * választ adjon vissza (ez a végső agent-válasz).
 */
export function relayTextToolCall(input: {
  content: string
  tools?: OpenAiToolDef[]
  model: string
  usage: { promptTokens: number; completionTokens: number }
}): OpenAiToolCallCompletion | null {
  if (!input.tools?.length) return null

  const parsed = extractTextToolCall(input.content)
  if (!parsed) return null

  const gooseToolName = resolveGooseToolName(input.tools, parsed.tool)
  if (!gooseToolName) return null

  return buildToolCallCompletion({
    model: input.model,
    name: gooseToolName,
    args: parsed.args,
    usage: input.usage,
  })
}
