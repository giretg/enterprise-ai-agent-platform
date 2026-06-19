import type { ToolBrokerInvokeInput } from '@/domain/tool-broker/tool-broker-service'
import type { ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import type { GatewayMessage, ModelConfig, ModelGateway } from '@/domain/gateway/model-gateway'
import type { ToolBrokerRepository } from '@/repositories/interfaces'

export const CHAT_PLATFORM_TOOLS = [
  'agent_catalog',
  'agent_resolve',
  'ticket_create',
  'agent_ask',
] as const

export type ChatPlatformToolName = (typeof CHAT_PLATFORM_TOOLS)[number]

const TOOL_INSTRUCTION = `
Platform eszközök (Kanban ticket / szervezeti agentek):
- Ha ticketet kell létrehozni vagy más agentet kell beazonosítani, NE mondd hogy megcsináltad anélkül, hogy eszközt hívnál.
- Eszközhíváskor válaszolj KIZÁRÓLAG egy JSON objektummal, semmi más szöveg nélkül:
  {"tool":"<eszköz>","args":{...}}
- Ha nincs eszközszükséglet, válaszolj természetes magyar szöveggel (NE JSON).

Elérhető eszközök:
1. agent_catalog — args: { "query"?: "nicknév/név", "agentId"?: "uuid", "limit"?: number }
   Teljes szervezeti agent profil: munkaköri leírás, viselkedés, modell, engedélyezett toolok, connectorok, erőforrások, recipe.
   Üres query → minden aktív agent; query → keresés (pl. „Bori”); agentId → egy konkrét agent.
2. agent_resolve — args: { "query": "..." } — gyors keresés (csak alap mezők + score); részletekhez használd agent_catalog-ot.
3. ticket_create — args: { "title": "...", "payload": { "task": "..." }, "assigneeType": "human"|"agent", "assigneeId": "uuid ha agent" }
   - Másik AI agent feladata: assigneeType "agent" + assigneeId a cél agent UUID-ja.
   - Emberi review: assigneeType "human".
4. agent_ask — args: { "targetAgentId": "uuid", "question": "...", "context": {} } — kérdés delegálása MÁSIK agentnek (NE a saját agentId-dre). A tool eredménye tartalmazza a completed és answer mezőket; CSAK completed:true esetén idézd a választ.
`

function isChatPlatformTool(name: string): name is ChatPlatformToolName {
  return (CHAT_PLATFORM_TOOLS as readonly string[]).includes(name)
}

function extractToolCall(content: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = content.trim()

  const codeBlock = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  const candidates = [codeBlock?.[1], trimmed.startsWith('{') ? trimmed : null]

  const inline = trimmed.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/)
  if (inline?.[0]) candidates.push(inline[0])

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown> }
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args }
      }
    } catch {
      // continue
    }
  }
  return null
}

function stripToolArtifacts(content: string): string {
  return content
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, '')
    .replace(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/g, '')
    .trim()
}

function buildToolInvoke(
  tool: ChatPlatformToolName,
  args: Record<string, unknown>,
  base: {
    agentId: string
    agentVersion: number
    conversationId: string
    actingUserId: string
  },
): ToolBrokerInvokeInput {
  const common = {
    agentId: base.agentId,
    agentVersion: base.agentVersion,
    conversationId: base.conversationId,
    actingUserId: base.actingUserId,
  }

  if (tool === 'agent_resolve') {
    return {
      ...common,
      tool: 'agent_resolve',
      args: {
        query: String(args.query ?? ''),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      },
    }
  }

  if (tool === 'agent_catalog') {
    return {
      ...common,
      tool: 'agent_catalog',
      args: {
        query: typeof args.query === 'string' ? args.query : undefined,
        agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      },
    }
  }

  if (tool === 'ticket_create') {
    return {
      ...common,
      tool: 'ticket_create',
      args: {
        title: String(args.title ?? ''),
        payload: (args.payload as Record<string, unknown>) ?? {},
        assigneeType: args.assigneeType === 'agent' ? 'agent' : 'human',
        assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId : undefined,
        sourceDocumentId: typeof args.sourceDocumentId === 'string' ? args.sourceDocumentId : undefined,
      },
    }
  }

  return {
    ...common,
    tool: 'agent_ask',
    args: {
      targetAgentId: String(args.targetAgentId ?? ''),
      question: String(args.question ?? ''),
      context:
        args.context && typeof args.context === 'object' && !Array.isArray(args.context)
          ? (args.context as Record<string, unknown>)
          : undefined,
    },
  }
}

export async function runAgentChatWithTools(params: {
  gateway: ModelGateway
  toolBroker: ToolBrokerService
  toolCaps: ToolBrokerRepository
  agentId: string
  agentVersion: number
  conversationId: string
  actingUserId: string
  messages: GatewayMessage[]
  modelConfig: ModelConfig
  allowedTools: ChatPlatformToolName[]
  maxTurns?: number
}): Promise<{ content: string; toolCallCount: number }> {
  const maxTurns = params.maxTurns ?? 6
  const messages: GatewayMessage[] = [
    ...params.messages,
    { role: 'system', content: TOOL_INSTRUCTION },
    {
      role: 'system',
      content: `A számodra engedélyezett eszközök: ${params.allowedTools.join(', ')}`,
    },
  ]

  let toolCallCount = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    const { content } = await params.gateway.call({
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages,
      modelConfig: params.modelConfig,
    })

    const toolCall = extractToolCall(content)
    if (!toolCall) {
      const cleaned = stripToolArtifacts(content)
      if (cleaned) return { content: cleaned, toolCallCount }

      if (turn < maxTurns - 1) {
        messages.push({
          role: 'user',
          content: '[Belső] Üres válasz. Fogalmazd meg magyarul a felhasználónak.',
        })
        continue
      }
      return { content: content.trim() || 'Nem kaptam választ a modelltől.', toolCallCount }
    }

    if (!isChatPlatformTool(toolCall.tool) || !params.allowedTools.includes(toolCall.tool)) {
      messages.push({
        role: 'user',
        content: `[Belső] Az eszköz „${toolCall.tool}" nem elérhető. Engedélyezett: ${params.allowedTools.join(', ')}`,
      })
      continue
    }

    try {
      const invokeInput = buildToolInvoke(toolCall.tool, toolCall.args, {
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        conversationId: params.conversationId,
        actingUserId: params.actingUserId,
      })

      const result = await params.toolBroker.invoke(invokeInput)
      toolCallCount += 1

      if (result.denied) {
        messages.push({
          role: 'user',
          content: `[Tool eredmény: ${toolCall.tool}] ELUTASÍTVA: ${result.reason}`,
        })
      } else {
        messages.push({
          role: 'user',
          content: `[Tool eredmény: ${toolCall.tool}]\n${JSON.stringify(result.result)}`,
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'tool_call_failed'
      messages.push({
        role: 'user',
        content: `[Tool eredmény: ${toolCall.tool}] HIBA: ${message}`,
      })
    }
  }

  messages.push({
    role: 'system',
    content:
      'Fogalmazd meg a felhasználónak magyarul. agent_ask esetén: ha completed:true és van answer, azt fogalmazd át (ne találj ki extra tényt). Ha completed:false vagy nincs answer, mondd el hogy a delegálás nem sikerült — NE állítsd, hogy megérkezett a válasz. Ne használj JSON tool blokkot.',
  })

  const { content: finalContent } = await params.gateway.call({
    agentId: params.agentId,
    conversationId: params.conversationId,
    messages,
    modelConfig: params.modelConfig,
  })

  return {
    content: stripToolArtifacts(finalContent) || finalContent.trim(),
    toolCallCount,
  }
}

export async function listAllowedChatTools(
  toolCaps: ToolBrokerRepository,
  agentId: string,
): Promise<ChatPlatformToolName[]> {
  const caps = await toolCaps.findCapabilitiesForAgent(agentId)
  return caps
    .filter((c) => c.allowed && isChatPlatformTool(c.toolName))
    .map((c) => c.toolName as ChatPlatformToolName)
}
