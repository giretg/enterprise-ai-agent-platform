type OpenAiMessage = {
  role: string
  content?: string | null
  tool_call_id?: string
  name?: string
}

type OpenAiTool = {
  type?: string
  function?: { name?: string }
}

function extractQuestion(messages: OpenAiMessage[]): string {
  const combined = messages.map((m) => m.content ?? '').join('\n')
  const match = combined.match(/Kérdés:\s*(.+?)(?:\n|$)/i)
  return match?.[1]?.trim() || 'MVP gateway broker'
}

function isKbSearchToolName(name: string | undefined): boolean {
  if (!name) return false
  return name === 'kb_search' || name.endsWith('__kb_search')
}

function resolveToolName(tools: OpenAiTool[], baseName: string): string | null {
  for (const tool of tools) {
    const name = tool.function?.name
    if (!name) continue
    if (name === baseName) return name
    const delimiter = name.lastIndexOf('__')
    if (delimiter !== -1 && name.slice(delimiter + 2) === baseName) return name
  }
  return null
}

function hasKbSearchResult(messages: OpenAiMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'tool' || !isKbSearchToolName(message.name)) return false
    const content = message.content ?? ''
    return (
      content.includes('docId') ||
      content.includes('snippet') ||
      content.includes('"hits"') ||
      content.includes('sourceRef')
    )
  })
}

function toolCallCompletion(model: string, name: string, args: Record<string, unknown>) {
  const id = `call_${name}_${Date.now()}`
  return {
    id: `gw_${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 },
  }
}

export function buildStubOpenAiCompletion(input: {
  messages: OpenAiMessage[]
  tools?: OpenAiTool[]
  model: string
  ticketId?: string
}): { kind: 'tool_calls'; body: Record<string, unknown> } | null {
  if (!input.tools?.length) return null

  const kbSearchTool = resolveToolName(input.tools, 'kb_search')
  const boardWriteTool = resolveToolName(input.tools, 'board_write')
  const question = extractQuestion(input.messages)
  const ticketId = input.ticketId ?? 'unknown-ticket'

  if (!hasKbSearchResult(input.messages) && kbSearchTool) {
    return {
      kind: 'tool_calls',
      body: toolCallCompletion(input.model, kbSearchTool, { query: question, k: 6 }),
    }
  }

  if (hasKbSearchResult(input.messages) && boardWriteTool) {
    return {
      kind: 'tool_calls',
      body: toolCallCompletion(input.model, boardWriteTool, {
        ticketId,
        patch: {
          state: 'done',
          payload: {
            answer:
              'Az MVP célja egy architektúra-teljes walking skeleton; minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.',
            sources: [{ docId: 'memory:stub', sectionRef: 'acceptance:wiki' }],
            rationale: 'Stub harness E2E — kb_search + board_write proof.',
            confidence: 'high',
          },
        },
      }),
    }
  }

  return null
}
