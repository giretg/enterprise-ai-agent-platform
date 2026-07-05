import type {
  AgentRepository,
  DocumentRepository,
  PlaybookV2Repository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import { buildEffectivePrompt } from '@/lib/playbook-v2/effective-prompt'
import {
  buildStepCompletionPayload,
  formatOutputContractInstruction,
  outputRequiredFieldsForStep,
  playbookSlotValuesFromTicketPayload,
} from '@/lib/playbook-v2/process-step-payload'
import { readTicketPromptText } from '@/lib/wiki-ticket-payload'
import { formatHitsForPrompt, type KbHit } from '@/lib/kb-format'
import type { ModelGateway, ModelConfig } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../file-editor/workspace-storage'
import { formatAttachmentBlock } from './agent-chat-runtime'
import { listAllowedChatTools, runAgentToolLoop } from './chat-tool-loop'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttachmentIds(payload: Record<string, unknown>): string[] {
  const ids = payload.attachmentDocumentIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

function safeToolResultName(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'tool-result'
}

type ProcessStepContext = {
  compiled: CompiledSpec
  stepRule: CompiledSpec['ticketRules'][number]
  outputRequiredFields: string[]
}

/**
 * Kontextus-agnosztikus feladat-runtime: chatből, delegálásból vagy agent-tool
 * útján létrehozott ticketeket dolgoz fel az egységes {@link runAgentToolLoop}-pal,
 * majd az eredményt `board_write`-tal visszaírja a ticketbe. A wiki-specifikus
 * `WikiAgentRuntime`-ot váltja ki minden nem-wiki forrásnál.
 */
export class GeneralTaskRuntime {
  constructor(
    private agents: AgentRepository,
    private documents: DocumentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private toolBroker: ToolBrokerService,
    private toolCaps: ToolBrokerRepository,
    private workspaceStorage: WorkspaceStorage,
    private playbooks?: PlaybookV2Repository,
  ) {}

  async processTicket(params: { ticketId: string; agentId: string }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.agentId !== params.agentId) throw new Error('Ticket not assigned to this agent')

    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const processStep = await this.loadProcessStepContext(ticket)
    let question = readTicketPromptText(payload) || ticket.title
    if (processStep) {
      const { prompt } = buildEffectivePrompt({
        agentPersona: '',
        instructionTemplate: processStep.stepRule.instructionTemplate,
        slots: playbookSlotValuesFromTicketPayload(payload),
      })
      if (prompt.trim()) question = prompt.trim()
    }
    const attachmentIds = readAttachmentIds(payload)
    if (!question && attachmentIds.length === 0) {
      throw new Error('Ticket payload is missing question')
    }

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion

    const attachmentDocs = await this.loadDocuments(attachmentIds)
    const attachmentBlock = formatAttachmentBlock(attachmentDocs)

    const kbSearch = await this.fetchKbSearchContext({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      query: question,
    })

    const messages = await this.buildTaskMessages({
      agentDetails,
      question,
      attachmentBlock,
      kbSearch,
      processStep,
    })

    const allowedTools = await listAllowedChatTools(this.toolCaps, params.agentId)

    const { content: answer, toolCallCount } = await runAgentToolLoop({
      gateway: this.gateway,
      toolBroker: this.toolBroker,
      toolCaps: this.toolCaps,
      agentId: params.agentId,
      agentVersion,
      context: { ticketId: ticket.id },
      mode: 'task',
      messages,
      modelConfig,
      allowedTools,
      archiveLargeToolResult: (input) =>
        this.archiveLargeToolResult(ticket.tenantId ?? 'global', ticket.id, input),
    })

    const completionPayload = processStep
      ? buildStepCompletionPayload({
          agentContent: answer,
          outputRequiredFields: processStep.outputRequiredFields,
          meta: {
            toolCallCount,
            agentVersion,
            model: modelConfig.model,
            memoryVersion: agentDetails.memoryVersion,
          },
        })
      : {
          answer,
          toolCallCount,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
        }

    const write = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'board_write',
      args: {
        ticketId: ticket.id,
        patch: {
          payload: completionPayload,
          state: 'done',
        },
      },
    })
    if (write.denied) {
      throw new Error(`board_write denied: ${write.reason}`)
    }

    const updated = await this.tickets.findById(ticket.id)
    return {
      ticketId: ticket.id,
      answer,
      toolCallCount,
      ticket: updated,
    }
  }

  private async loadProcessStepContext(
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>,
  ): Promise<ProcessStepContext | null> {
    if (
      !ticket.processInstanceId ||
      !ticket.playbookVersionId ||
      !ticket.playbookStepId ||
      !this.playbooks
    ) {
      return null
    }

    const version = await this.playbooks.findVersion(ticket.tenantId, ticket.playbookVersionId)
    const compiled = version?.compiledSpec as CompiledSpec | undefined
    if (!compiled) return null

    const stepRule = compiled.ticketRules.find((r) => r.stepId === ticket.playbookStepId)
    if (!stepRule) return null

    return {
      compiled,
      stepRule,
      outputRequiredFields: outputRequiredFieldsForStep(stepRule, compiled.outputRequiredFields),
    }
  }

  private async loadDocuments(ids: string[]) {
    const docs = await Promise.all(ids.map((id) => this.documents.findById(id)))
    return docs.filter((doc): doc is NonNullable<(typeof docs)[number]> => Boolean(doc))
  }

  private async archiveLargeToolResult(
    tenantId: string,
    ticketId: string,
    input: { toolName: string; callId: string; turn: number; content: string },
  ): Promise<{ path: string; bytes: number } | null> {
    const bytes = Buffer.from(input.content, 'utf8')
    const path = [
      '.tool-results',
      `${String(input.turn + 1).padStart(2, '0')}-${safeToolResultName(input.toolName)}-${safeToolResultName(input.callId)}.json`,
    ].join('/')

    try {
      await this.workspaceStorage.write(tenantId, ticketId, path, bytes)
      return { path, bytes: bytes.length }
    } catch {
      return null
    }
  }

  private async fetchKbSearchContext(params: {
    agentId: string
    agentVersion: number
    ticketId: string
    query: string
  }): Promise<{ enabled: boolean; hits: KbHit[] }> {
    const capability = await this.toolCaps.findCapability(params.agentId, 'kb_search')
    if (!capability?.allowed || !params.query.trim()) {
      return { enabled: false, hits: [] }
    }

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      ticketId: params.ticketId,
      tool: 'kb_search',
      args: { query: params.query.trim(), k: 6 },
    })

    if (search.denied || !('hits' in search.result) || !Array.isArray(search.result.hits)) {
      return { enabled: true, hits: [] }
    }

    return { enabled: true, hits: search.result.hits as KbHit[] }
  }

  private async buildTaskMessages(params: {
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>
    question: string
    attachmentBlock: string
    kbSearch: { enabled: boolean; hits: KbHit[] }
    processStep: ProcessStepContext | null
  }) {
    const allAgents = await this.agents.findMany()
    const orgRoster = formatOrgRoster(allAgents)

    const messages: Array<{ role: 'user' | 'system'; content: string }> = [
      { role: 'system', content: composeSystemPrompt(params.agentDetails.agent) },
    ]

    if (params.agentDetails.memoryContent?.trim()) {
      messages.push({
        role: 'system',
        content: `Memória (aktív verzió):\n${params.agentDetails.memoryContent.trim()}`,
      })
    }

    if (params.processStep) {
      const outputInstruction = formatOutputContractInstruction(
        params.processStep.outputRequiredFields,
      )
      if (outputInstruction) {
        messages.push({ role: 'system', content: outputInstruction })
      }
    }

    if (params.kbSearch.enabled) {
      const answerInstruction =
        params.kbSearch.hits.length === 0
          ? 'A tudásbázis (kb_search) nem adott találatot erre a feladatra. Ez NEM jelenti, hogy nincs megoldás: email/postafiók feladatnál gmail_search, fájl/munkaterület feladatnál file_* eszköz — ha engedélyezve van. Csak akkor mondd, hogy nincs elég forrás, ha a releváns eszközök sem adnak adatot.'
          : 'A belső tudásbázis tényállításaihoz kizárólag az alábbi kb_search találatokra támaszkodj. Minden lényegi állításhoz adj forráshivatkozást.'
      messages.push({
        role: 'system',
        content: `${answerInstruction}\n\nTudásbázis találatok (kb_search):\n${formatHitsForPrompt(params.kbSearch.hits)}`,
      })
    }

    messages.push({ role: 'system', content: orgRoster })

    const userContent = params.attachmentBlock
      ? `${params.question || '(csatolmányok)'}${params.attachmentBlock}`.trim()
      : params.question
    messages.push({ role: 'user', content: userContent })

    return messages
  }
}
