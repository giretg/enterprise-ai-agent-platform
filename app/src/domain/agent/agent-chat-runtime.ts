import { randomUUID } from 'node:crypto'
import type { Message, Prisma, ToolCall } from '@prisma/client'
import {
  ActiveAgentTurnExistsError,
  OWNED_AGENT_TURN_STATUSES,
  type AgentRepository,
  type AgentTurnRepository,
  type AuditRepository,
  type DocumentRepository,
  type FinalizeAgentTurnInput,
  type PlaybookV2Repository,
  type ProcessDefinitionRepository,
  type TicketRepository,
  type ToolBrokerRepository,
} from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import type { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { resolveAddressableColleagues } from '@/domain/agent-access/addressable-colleagues'
import { AgentAccessError } from '@/domain/agent-access/agent-access-errors'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'
import { formatHitsForPrompt, type KbHit } from '@/lib/kb-format'
import { attachmentPageCount } from '@/lib/document-read'
import { assertDocumentsReachableFromTenant } from '@/lib/document-tenant-access'
import { chatAttachmentWorkspacePath } from '@/lib/attachment-workspace'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { pollCancelRequested } from '@/lib/cancel-flag-poll'
import {
  applyChatTriggerAttachments,
  chatTriggerSlotDescriptors,
  missingRequiredTriggerSlots,
  resolveChatTriggerInputPayload,
} from '@/lib/playbook-v2/trigger-input'
import type { ModelGateway } from '../gateway/model-gateway'
import { StreamingSensitiveTextRedactor } from '../gateway/sensitivity-router'
import { createWebUiStreamingResolver } from '../privacy/streaming-surrogate-resolver'
import { resolveEgressTextForSurface } from '../privacy/resolve-display-text'
import type { ResolvedPrivacyEgressMatrix } from '../privacy/privacy-egress-matrix'
import { resolvePrivacyEgressMatrix } from '../privacy/privacy-egress-matrix'
import type { SurrogateEngine } from '../privacy/surrogate-engine'
import {
  buildEntityMarkers,
  type PrivacyEntityMarker,
} from '../privacy/privacy-observability'
import type { ResolvedPrivacyCategoryPolicy } from '../privacy/privacy-category-policy'
import type { PrivacyGatewayMode } from '../privacy/privacy-mode'
import type { ChatPrivacyMarkerContext } from '@/lib/privacy-chat-markers'
import type { ConversationService } from '../conversation/conversation-service'
import {
  assembleContext,
  buildMemoryRetrievalQuery,
  type ContextAssemblyMessage,
} from '../conversation/context-assembly'
import { MEMORY_RETRIEVAL_USAGE_PROMPT, kbSearchAnswerInstruction } from '@/lib/memory-prompt'
import {
  buildMemoryRetrievalRequest,
  loadProjectMemoryContext,
  memoryContextSystemMessages,
  trainedRulesSystemMessages,
} from '../memory/memory-runtime-helper'
import { resolveWorkProjectBrief } from '../work-project/work-project-service'
import type { MemoryRetrievalService } from '../memory/memory-retrieval-service'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../file-editor/workspace-storage'
import { createWorkspaceToolResultArchiver } from './tool-result-archive'
import type { CompiledSpec } from '../playbook/playbook-compiler'
import type { ProcessService } from '../playbook/process-service'
import {
  AgentToolLoopCancelledError,
  listAllowedChatTools,
  MODEL_WAIT_HEARTBEAT_MS,
  resolveToolLoopMaxTurns,
  runAgentToolLoop,
  type LoadSkillFn,
  type LoadSkillAttachmentFn,
  type ToolLoopActivityEvent,
  type ToolLoopStopReason,
} from './chat-tool-loop'
import { formatPreapprovedRunSummary } from '../tool-broker/consequence-gate-policy'
import type { SkillService } from '../skill/skill-service'
import { assembleGatewayMessages, type PromptSegments } from './prompt-assembler'
import {
  buildPromotedTaskAttachmentTransfer,
  buildSkillTaskPromotionBinding,
  buildSkillTaskPromotionMessage,
  buildSkillTaskTitle,
  shouldPromoteSkillRunToTask,
} from './skill-task-promotion'
import {
  assembleTaskBriefingDraft,
  briefingToPayloadValue,
  type TaskBriefing,
} from '@/lib/work-traceability'
import {
  buildReturnedDelegationPrompt,
  buildTurnContinuationPrompt,
  isExplicitContinuationRequest,
  shouldInjectTurnContinuation,
  type ContinuationActivity,
  type ReturnedDelegation,
} from './turn-continuation'
import {
  agentTurnRunner,
  type AgentChatStreamEvent,
  type AgentTurnEmit,
} from './agent-turn-runner'
import {
  TurnSnapshotFlusher,
  guardTurnPartialText,
  type TurnSnapshotFlush,
} from './agent-turn-snapshot'
import { resolveStaleTurnMs, closeTurnAsWatchdog } from './agent-turn-watchdog'
import {
  buildStoredTurnInput,
  parseStoredTurnInput,
  StoredTurnInputError,
} from './chat-turn-input'
import { createInProcessChatTurnLauncher, type ChatTurnLauncher } from './chat-turn-launcher'
import {
  cancelQueuedChatTurn,
  launchAcceptedChatTurn,
  recoverQueuedChatTurns,
  type RecoverQueuedChatTurnsSummary,
} from './chat-turn-dispatch'
import {
  isInternalWorkspaceFile,
  referencedWorkspaceFiles,
} from '@/lib/workspace-file-visibility'
import { buildThreadContextPrompt } from '@/lib/ticket-thread-prompt'
import { readTicketPromptText } from '@/lib/wiki-ticket-payload'

/**
 * Ugyanarra a forduló-azonosítóra már fut futtatás EBBEN a processben. Ez a
 * runner process-lokális védelme; a beszélgetés-szintű „egy aktív forduló"
 * invariánst (D7) a küldés elején álló foglalás intézi (#61).
 */
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i
const IMAGE_MARKER = /^(\[image:([^\]]+)\])([\s\S]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TOOL_CALL_META_NOISE_KEYS = new Set([
  'ticketId',
  'conversationId',
  'actingUserId',
  'acting_user_id',
  'connector_id',
  'connectorId',
  'connector_type',
  'access_mode',
  'grant_id',
])

/**
 * A korábbi fordulók agent-válaszai eddig csak nyers szövegként kerültek a
 * promptba — a ténylegesen lefutott tool-hívások (pl. melyik fájlt szerkesztette
 * a file_edit) elvesztek, ezért a modell a következő körben nem tudott a saját
 * korábbi munkájára hivatkozni (l. repo_prepare/file_edit → PR-kérés eset).
 * Ez a szinopszis a ToolCall.resultMeta releváns mezőit adja vissza tömören.
 */
function formatToolCallSynopsisLine(call: ToolCall): string {
  const status = call.status === 'ok' ? 'siker' : call.status === 'denied' ? 'megtagadva' : 'hiba'
  const meta = isRecord(call.resultMeta) ? call.resultMeta : {}
  const details = Object.entries(meta)
    .filter(([key, value]) => !TOOL_CALL_META_NOISE_KEYS.has(key) && value !== null && value !== undefined)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
  return `  • ${call.toolName} (${status})${details ? `: ${details}` : ''}`
}

function formatToolCallSynopsisBlock(calls: ToolCall[]): string {
  if (calls.length === 0) return ''
  return `\n\n[Ebben a körben lefutott eszközhívások]\n${calls.map(formatToolCallSynopsisLine).join('\n')}`
}

export type CancelledTurnSnapshot = {
  completedReply?: string | null
  activities?: ToolLoopActivityEvent[]
  turnToolCalls?: ToolCall[]
}

/**
 * Megszakított chat-forduló értelmes, DB-be menthető összefoglalója. Nem stream-chunkot
 * tárol, hanem a lefutott tool-hívások szinopszisát és — ha már kész volt — a teljes választ.
 */
export function buildCancelledTurnMessage(snapshot: CancelledTurnSnapshot): string {
  const completedReply = snapshot.completedReply?.trim() ?? ''
  const turnToolCalls = snapshot.turnToolCalls ?? []
  const activities = snapshot.activities ?? []

  const parts: string[] = ['⏹️ Megszakítva — a felhasználó leállította a választ.']

  const okTools = turnToolCalls.filter((call) => call.status === 'ok')
  const deniedTools = turnToolCalls.filter((call) => call.status === 'denied')
  if (okTools.length > 0 || deniedTools.length > 0) {
    const labels = [
      ...okTools.map((call) => call.toolName),
      ...deniedTools.map((call) => `${call.toolName} (megtagadva)`),
    ]
    parts.push(`\nLefutott eszközök: ${labels.join(', ')}.`)
  } else {
    const doneToolActivities = activities.filter(
      (activity) => activity.status === 'done' && activity.kind === 'tool',
    )
    if (doneToolActivities.length > 0) {
      parts.push('\n[Lefutott lépések]')
      for (const activity of doneToolActivities) {
        parts.push(
          `• ${activity.title}${activity.detail ? ` — ${activity.detail}` : ''}`,
        )
      }
    }
  }

  if (completedReply) {
    parts.push('\n[Válasz]')
    parts.push(completedReply)
  } else if (okTools.length > 0 || deniedTools.length > 0 || activities.some((activity) => activity.status === 'done')) {
    parts.push(
      '\nA válasz kidolgozása félbemaradt. Folytatáshoz írd: *folytasd*, vagy pontosítsd, mit szeretnél a fenti eredményből.',
    )
  } else {
    parts.push(
      '\nA válasz generálása még nem kezdődött el. Folytatáshoz ismételd meg a kérdést, vagy írd: *folytasd*.',
    )
  }

  return parts.join('\n')
}

/**
 * Hibára futott forduló hétköznapi nyelvű magyarázata.
 *
 * ÜZLETI PROBLÉMA: a hibaág eddig csak egy röpke SSE `error` eseményt küldött és
 * az `agent_turns.error` mezőbe írt. Aki nem nézte épp a képernyőt — vagy csak
 * újratöltötte az oldalt —, az a beszélgetésben CSAK a saját üzenetét látta:
 * mintha az agent szó nélkül megállt volna. A megcsinált munka (pl. egy már
 * kitöltött Excel) ott volt a workspace-ben, de erről semmi nem szólt.
 *
 * A `budget` ág külön kezelendő, mert nem hiba, hanem üzemeltetési döntés
 * (keret) — ezt a felhasználó máshogy kezeli, mint egy technikai hibát.
 */
export function describeTurnFailure(error: string): string {
  const budget = error.match(
    /budget gate: (Token|Call) limit exceeded: (\d+)\/(\d+) per (day|week|month) \(scope=(\w+)\)/,
  )
  if (budget) {
    const [, kind, used, limit, period, scope] = budget
    const periodLabel = period === 'day' ? 'napi' : period === 'week' ? 'heti' : 'havi'
    const scopeLabel =
      scope === 'agent' ? 'erre az agentre' : scope === 'tenant' ? 'a szervezetre' : `a(z) ${scope} keretre`
    const kindLabel = kind === 'Token' ? 'token' : 'hívás'
    const format = (value: string) => Number(value).toLocaleString('hu-HU')
    return (
      `⚠️ **Elfogytam a keretből — a válasz nem készült el.** ` +
      `A(z) ${periodLabel} ${kindLabel}-keret ${scopeLabel} betelt ` +
      `(${format(used)} / ${format(limit)}).\n\n` +
      `A keret gördülő ${period === 'day' ? '24 órás' : period === 'week' ? '7 napos' : '30 napos'} ablakra vonatkozik, ` +
      `így magától felszabadul, ahogy a régebbi hívások kiesnek belőle. Ha előbb kell, kérd meg az adminisztrátort a keret megemelésére.`
    )
  }
  return `⚠️ **A válasz nem készült el — hiba történt a futás közben.**\n\nA hiba: ${error}`
}

export type FailedTurnSnapshot = CancelledTurnSnapshot & { error: string }

/**
 * Hibára futott chat-forduló DB-be menthető lezáró üzenete. Ugyanaz az elv, mint
 * a megszakításnál: mondja meg, MI történt, MI maradt meg, és hogyan tovább.
 */
export function buildFailedTurnMessage(snapshot: FailedTurnSnapshot): string {
  const completedReply = snapshot.completedReply?.trim() ?? ''
  const turnToolCalls = snapshot.turnToolCalls ?? []
  const activities = snapshot.activities ?? []

  const parts: string[] = [describeTurnFailure(snapshot.error)]

  const okTools = turnToolCalls.filter((call) => call.status === 'ok')
  const deniedTools = turnToolCalls.filter((call) => call.status === 'denied')
  if (okTools.length > 0 || deniedTools.length > 0) {
    const labels = [
      ...okTools.map((call) => call.toolName),
      ...deniedTools.map((call) => `${call.toolName} (megtagadva)`),
    ]
    parts.push(`\n**Ami a leállásig lefutott:** ${labels.join(', ')}.`)
    parts.push(
      'Az elkészült fájlok és részeredmények a beszélgetés workspace-ében megmaradtak — nem kell elölről kezdeni.',
    )
  } else {
    const doneToolActivities = activities.filter(
      (activity) => activity.status === 'done' && activity.kind === 'tool',
    )
    if (doneToolActivities.length > 0) {
      parts.push('\n**Ami a leállásig lefutott:**')
      for (const activity of doneToolActivities) {
        parts.push(`• ${activity.title}${activity.detail ? ` — ${activity.detail}` : ''}`)
      }
    }
  }

  if (completedReply) {
    parts.push('\n**Az addig elkészült válasz:**')
    parts.push(completedReply)
  } else {
    parts.push('\nFolytatáshoz írd: *folytasd*, vagy küldd el újra a kérést.')
  }

  return parts.join('\n')
}

type StreamTurnContext = {
  conversationId: string
  userMessageCreatedAt: Date
  agentId: string
  agentVersion: number
  createdById: string
  model: string
  activities: ToolLoopActivityEvent[]
  completedReply: string | null
  finalized: boolean
  /**
   * A perzisztált `AgentTurn` rekord azonosítója (spec §4). `null`, ha a rekord
   * nem jött létre — a forduló-perzisztencia megfigyelési réteg, nem szabad
   * miatta elbukni a chatnek (l. `openTurnRecord`).
   */
  turnRecordId: string | null
  /** A rekordot az indító process claimeli azonnal (Tier-2, §10-kiegészítés). */
  turnRecordLockToken: string | null
  turnRecordClosed: boolean
  /** Utolsó kiírt heartbeat ideje (ritkításhoz). */
  lastHeartbeatAt: number
  /**
   * #516 — a tulajdonoshoz kötött írás (heartbeat / progress) `null`-t adott:
   * a rekordot közben más zárta le vagy vette át. Innentől nincs új modell-
   * vagy tool-hívás, és a beszélgetésbe sem írunk lezáró üzenetet — azt a
   * tényleges tulajdonos (watchdog / új futtató) teszi.
   */
  ownershipLost: boolean
}

/** A futás a tulajdonjog elvesztése miatt áll le — a checkpointok dobják. */
export class TurnOwnershipLostError extends Error {
  constructor() {
    super('A forduló tulajdonjoga elveszett (más futtató vagy a watchdog vette át).')
    this.name = 'TurnOwnershipLostError'
  }
}

/**
 * A korábbi (user/agent) fordulókat gateway-üzenetekké alakítja VALÓDI
 * párbeszéd-szerepekkel: a felhasználó fordulói `user`, az agent korábbi
 * válaszai `assistant` szerepűek. Ez kritikus a többfordulós kontextushoz — ha
 * minden korábbi üzenet `user` szerepet kap (mint korábban a `[Korábbi agent
 * válasz]` prefix-szel), a gyenge modellek (pl. qwen3) nem látják, hogy ők maguk
 * már válaszoltak, és a következő fordulóban „nem volt előző kérésed"-et
 * mondanak. Az agent-fordulóhoz a saját tool-hívásainak szinopszisát is
 * hozzáfűzzük (melyik fájlt szerkesztette stb.). Exportálva, hogy a
 * kontextus-átvitel DB/gateway nélkül is tesztelhető legyen.
 */
export function buildHistoryGatewayMessages(
  historyMessages: ContextAssemblyMessage[],
  toolCalls: ToolCall[],
  latestAttachmentBlock: string,
  latestUserTextOverride?: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const visible = historyMessages.filter((m) => m.content && !m.contentDeletedAt)
  for (let i = 0; i < visible.length; i++) {
    const message = visible[i]
    if (!message.content) continue

    if (message.role === 'user') {
      const parsed = parseStoredMessage(message.content)
      const isLatest = i === visible.length - 1
      const userText =
        isLatest && latestUserTextOverride !== undefined
          ? latestUserTextOverride
          : parsed.text
      const content =
        isLatest && latestAttachmentBlock
          ? `${userText || '(csatolmányok)'}${latestAttachmentBlock}`.trim()
          : userText
      result.push({ role: 'user', content })
    } else if (message.role === 'agent') {
      // A fordulóhoz tartozó tool-hívások: az előző (user) üzenet és ez az
      // agent-üzenet létrejötte közötti időablakban lefutott ToolCall-ok —
      // e nélkül a modell csak a nyers válaszszövegből következtethetne
      // vissza arra, mit módosított (l. repo_prepare/file_edit → PR-kérés eset).
      const windowStart = i > 0 ? visible[i - 1].createdAt : new Date(0)
      const turnToolCalls = toolCalls.filter(
        (call) => call.createdAt > windowStart && call.createdAt <= message.createdAt,
      )
      result.push({
        role: 'assistant',
        content: `${message.content}${formatToolCallSynopsisBlock(turnToolCalls)}`,
      })
    }
  }
  return result
}

/**
 * Egy kész szöveget streamelhető darabokra bont (a szóközöket a darabhoz
 * tartva), hogy szimulált token-by-token megjelenítést adjon a tool-os ágon,
 * ahol a modellhívás nem streamelhető élőben.
 */
function chunkForStreaming(text: string): string[] {
  if (!text) return []
  return text.match(/\S+\s*/g) ?? [text]
}

function isImageDocument(doc: { filename: string; extractedText: string | null }): boolean {
  if (IMAGE_EXT.test(doc.filename)) return true
  return Boolean(doc.extractedText?.startsWith('[image:'))
}

function chatAttachmentViewFromDocument(doc: {
  id: string
  filename: string
  extractedText: string | null
}): ChatAttachmentView {
  const kind = isImageDocument(doc) ? 'image' : 'text'
  let previewDataUrl: string | null = null
  if (kind === 'image' && doc.extractedText) {
    const imageMatch = doc.extractedText.match(IMAGE_MARKER)
    if (imageMatch?.[2] && imageMatch[3]) {
      previewDataUrl = `data:${imageMatch[2]};base64,${imageMatch[3]}`
    }
  }
  return {
    documentId: doc.id,
    filename: doc.filename,
    kind,
    previewDataUrl,
  }
}

export function formatAttachmentBlock(
  docs: Array<{
    id: string
    filename: string
    extractedText: string | null
    metadata?: unknown
  }>,
): string {
  if (docs.length === 0) return ''
  const parts = docs.map((doc) => {
    if (isImageDocument(doc)) {
      return `[Csatolmány (kép): ${doc.filename}, documentId=${doc.id}]`
    }
    const text = doc.extractedText?.trim() ?? ''
    const pageCount = attachmentPageCount(doc.metadata, doc.extractedText)
    const preview = text.slice(0, 600)
    const pageLabel = pageCount > 0 ? `, ~${pageCount} oldal/blokk` : ''
    const guidance =
      `A teljes tartalom NEM a promptban van. Olvasd a document_read eszközzel:\n` +
      `  document_read({ documentId: "${doc.id}", pages: "1-2" })\n` +
      `  document_read({ documentId: "${doc.id}", query: "kulcsszó" })\n` +
      `Ne próbáld a teljes fájlt file_read-del végigolvasni.`
    if (preview) {
      return (
        `[Csatolmány: ${doc.filename}, documentId=${doc.id}${pageLabel}]\n` +
        `${guidance}\n` +
        `Előnézet (első ~600 kar):\n${preview}`
      )
    }
    return `[Csatolmány: ${doc.filename}, documentId=${doc.id}${pageLabel}]\n${guidance}`
  })
  return `\n\n--- Csatolmányok ---\n${parts.join('\n\n')}`
}

export type ChatAttachmentView = {
  documentId: string
  filename: string
  kind: 'text' | 'image'
  previewDataUrl?: string | null
}

export type ChatMessageView = {
  id: string
  role: 'user' | 'agent' | 'system' | 'tool'
  text: string
  attachments: ChatAttachmentView[]
  createdAt: Date
  privacyMarkers?: PrivacyEntityMarker[]
  contentDeletedAt?: Date | null
  ticketRefId?: string | null
}

export type ChatSessionView = {
  id: string
  title: string
  preview: string | null
  lastMessageAt: string
  createdAt: string
}

function parseStoredMessage(content: string): { text: string; attachmentIds: string[] } {
  try {
    const parsed = JSON.parse(content) as { text?: string; attachmentIds?: string[] }
    if (typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        attachmentIds: Array.isArray(parsed.attachmentIds)
          ? parsed.attachmentIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }
  } catch {
    // plain text legacy
  }
  return { text: content, attachmentIds: [] }
}

function encodeStoredMessage(text: string, attachmentIds: string[]): string {
  if (attachmentIds.length === 0) return text
  return JSON.stringify({ text, attachmentIds })
}

/**
 * A chat a legérzékenyebb agent-felület: prompt-kontextus, memória és workspace is
 * az agent tenantján fut. Idegen tenant agentje opak 'Agent not found'-ot kap, hogy
 * az azonosító ismerete se legyen felderítési csatorna.
 */
function assertAgentReachableForChat(
  agentTenantId: string | null,
  actorTenantId: string | null,
): void {
  if (!isAgentReachableFromTenant(agentTenantId, actorTenantId)) {
    throw new Error('Agent not found')
  }
}

type ChatProcessReply = {
  text: string
  ticketRefId?: string | null
}

export type AgentChatSendParams = {
  agentId: string
  content: string
  createdById: string
  tenantId?: string | null
  conversationId?: string
  /** Új beszélgetésnél a memória-hatókör. Meglévő szálon, ha a kliens küldi, a kulcs frissül. */
  projectKey?: string
  attachmentDocumentIds?: string[]
  processDefinitionId?: string
  processInputPayload?: Record<string, unknown>
  /**
   * issue #97 — ez a forduló egy következmény-jóváhagyás FOLYTATÁSA: a külső,
   * nem megbízható tartalom az előzményben már ott van, ezért a forduló már
   * „tainted"-ként indul, és a hátralévő mellékhatásos lépések ismét kaput
   * kapnak. Kizárólag szerveroldalról (a validált jóváhagyás után) állítható.
   */
  consequenceApprovalContinuation?: boolean
  /** OAuth-grant megadása utáni folytatás — a szerver adja a promptot. */
  connectorGrantContinuation?: boolean
  /** #375 — a felhasználó által jóváhagyott feladat-eligazítás. */
  taskBriefing?: TaskBriefing | null
  /**
   * Beágyazott agent-chat (#481 D4): a beágyazó app `postMessage`-kontextusa,
   * a stream-route által MÁR burkolva (`embeddedContextToModelPrefix`). Csak a modellnek szóló
   * promptba kerül be (`latestUserTextOverride` elé fűzve) — a perzisztált
   * user-üzenet (és így a beszélgetés-előzmény) NEM tartalmazza, hogy a
   * felhasználó chatje ne teljen meg a külső app nyers adatával.
   */
  modelContextPrefix?: string | null
}

type ChatModelConfig = {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
}

type AgentDetails = NonNullable<Awaited<ReturnType<AgentRepository['findByIdForRuntime']>>>

/** A `/slash` skill-feloldás eredménye a fordulóhoz (előtöltés + keret + promóció). */
type SlashSkillResolution = {
  modelFacingText: string
  preloadedSkillPrompts: string[]
  loadedSkillNames: string[]
  loadedSkillVersionIds: string[]
  /** A futásidejű readiness-kapun elakadt skillek (hiányzó capability-grant). */
  blocked: Array<{ name: string; missingTools: string[]; reason: string }>
  /** A betöltött skillek `allowed-tools` uniója — a forduló eszköz-hatóköre. */
  requiredTools?: string[]
  /** Van-e Level-2 melléklet az előtöltött skilleken. */
  attachmentsAvailable?: boolean
  runtimeHints?: {
    maxWallClockMs?: number
    maxToolCalls?: number
    preferredMode?: 'chat' | 'task'
  }
}

/**
 * Minden, amit a kérés-scope-ban elő KELL készíteni (auth, beszélgetés,
 * csatolmányok, a user-üzenet perzisztálása, a forduló tulajdonjoga), hogy a
 * tényleges futás már kérés nélkül is elmehessen.
 */
type PreparedTurn = {
  params: AgentChatSendParams
  turn: StreamTurnContext
  /**
   * A futás azonosítója — ugyanaz, amivel a runner regisztrálva van. A Stop
   * ERRE hivatkozik (#65), nem a beszélgetésre.
   */
  turnId: string
  agentDetails: AgentDetails
  modelConfig: ChatModelConfig
  conversationId: string
  text: string
  tenantKey: string
  attachmentBlock: string
  attachmentDocs: Array<{
    id: string
    filename: string
    extractedText: string | null
    mimeType: string | null
    metadata?: unknown
  }>
  workspaceFiles: string[]
}

/** A detached futás eredménye — a lezáró pont kimenete (D2/D11). */
type TurnExecutionResult = {
  outcome: FinalizeAgentTurnInput
  reply: string
  messageId: string | null
  ticketRefId?: string | null
}

/**
 * A lefoglalt forduló-hely fogantyúja (D7). A foglalás MEGELŐZI a user-üzenet
 * perzisztálását, tehát a `StreamTurnContext` létrejöttekor a rekord már áll —
 * ezért kell külön objektumban élnie.
 */
type TurnRecordHandle = {
  /** `null`, amíg a rekord nem jött létre. */
  id: string | null
}

type BeginTurnResult =
  | {
      kind: 'error'
      error: Error
      /** Ha a user-üzenet már perzisztálódott, a kliensnek ACK-ot kell kapnia róla. */
      meta?: { conversationId: string; userMessageId: string }
    }
  | {
      /** Már fut forduló a beszélgetésre (D7) — a kérés-úton ebből `409` lesz. */
      kind: 'conflict'
      conversationId: string
      activeTurnId: string | null
    }
  | {
      kind: 'started'
      turnId: string
      conversationId: string
      userMessageId: string
      /** Élő esemény-busz, ha a futás EBBEN a processben megy (in-process launcher). */
      subscribe: (() => AsyncGenerator<AgentChatStreamEvent, void, unknown>) | null
    }

export class AgentChatRuntime {
  constructor(
    private agents: AgentRepository,
    private documents: DocumentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private conversations: ConversationService,
    private toolBroker: ToolBrokerService,
    private toolCaps: ToolBrokerRepository,
    private workspaceStorage: WorkspaceStorage,
    private audit: AuditRepository,
    private processDefinitions?: ProcessDefinitionRepository,
    private playbooksV2?: PlaybookV2Repository,
    private processService?: ProcessService,
    private skills?: SkillService,
    private memoryRetrieval?: MemoryRetrievalService,
    /**
     * Chat "thinking-trace" spec §D7/WP-6 — tenant-szintű kapcsoló (fail-closed,
     * alapból kikapcsolva). Ha nincs injektálva vagy false-t ad, reasoning-esemény
     * sem generálódik (E4 — nem csak UI-szűrés, a bridge/loop szintjén sem).
     */
    private isThinkingTraceEnabled?: (tenantId: string | null) => Promise<boolean>,
    /**
     * chat-agent-turn-resilience-spec.md §4 — a perzisztált forduló-rekord tára.
     * Opcionális: ha nincs bekötve (unit-tesztek, régi hívók), a chat pontosan
     * ugyanúgy működik, csak nem keletkezik forduló-rekord.
     */
    private agentTurns?: AgentTurnRepository,
    /** issue #97 — következmény-kapu pending jóváhagyások. */
    private consequenceApprovals?: import('../tool-broker/consequence-approval-service').ConsequenceApprovalService,
    /**
     * Agent-hozzáférési gráf (#142). A prompt-roster ezen keresztül szűr: csak
     * MEGSZÓLÍTHATÓ, aktív, azonos tenantos kollégák kerülhetnek a system promptba.
     * Ha nincs bekötve, a roster ÜRES (fail-closed) — nem a teljes agent-lista.
     */
    private agentAccess?: AgentAccessService,
    /** APG-06 — megjelenítési feloldás a web UI streamjén. Hiányában a töredék álnév akkor is bent marad. */
    private surrogateEngine?: SurrogateEngine | null,
    /** APG-19 — tenant-szintű egress-mátrix (web UI felület). Hiányában platform-alapértelmezés. */
    private resolvePrivacyEgressMatrix?: (
      tenantId: string | null,
    ) => Promise<ResolvedPrivacyEgressMatrix>,
    /** APG-22 — a valós chat-forduló marker-státuszai ugyanabból a runtime policy-ból. */
    private resolvePrivacyObservability?: (
      tenantId: string | null,
      agentId: string,
    ) => Promise<{
      mode: PrivacyGatewayMode
      policy: ResolvedPrivacyCategoryPolicy
    }>,
    private workProjects?: import('@/repositories/interfaces').WorkProjectRepository,
    /**
     * Chatből nyitott feladat azonnali indítása. A dispatcher worker
     * LISTEN/cron-jától függetlenül hívandó; a System-oldali dispatcher-kapu
     * továbbra is dönt — szüneteltetéskor a ticket ready-ben marad.
     */
    private dispatchTicket?: (ticketId: string) => Promise<unknown>,
    /**
     * #516 — a tartósan felvett forduló indítási határa. Alapból in-process
     * (Tier-1 runner); a mag (`runReservedTurn`) ettől független, DB-ből tölt.
     */
    launcher?: ChatTurnLauncher,
  ) {
    this.launcher =
      launcher ??
      createInProcessChatTurnLauncher((request, emit) =>
        // #518: a felszabadult hely azonnal a következő sorban állóé — ne
        // várjon a dispatch-ciklus következő körére.
        this.runReservedTurn(request, emit).finally(() => this.kickQueuedTurns()),
      )
  }

  private launcher: ChatTurnLauncher

  /**
   * A forduló-hely FOGLALÁSA (spec §5.1/3–4, D7). Ez a művelet kényszeríti ki az
   * „egy beszélgetés = egy aktív forduló" invariánst: nem előzetes lekérdezéssel,
   * hanem a beszúrásra csattanó részleges egyedi indexszel, így két párhuzamos
   * küldésből pontosan egy nyer.
   *
   * A foglalás MEGELŐZI a user-üzenet perzisztálását — az elutasított küldés így
   * nem hagy árva üzenetet a beszélgetésben.
   *
   * A NEM-ütközéses hibák fail-softak: ha a rekord-tár elérhetetlen, a chat
   * rekord nélkül fut tovább, mert a perzisztencia megfigyelési réteg. Az
   * ütközés viszont már nem az — abból `409` lesz a kérés-úton.
   */
  private async reserveTurnRecord(
    record: TurnRecordHandle,
    params: {
      conversationId: string
      tenantId: string | null
      agentId: string
      agentVersion: number
      createdById: string
      input: Prisma.InputJsonValue
    },
  ): Promise<{ ok: true } | { ok: false; activeTurnId: string | null }> {
    const turns = this.requireTurnStore()

    /**
     * Egy foglalási kísérlet. #516: a rekord `queued`, lock NÉLKÜL — a
     * tulajdonjogot a futtatómag szerzi meg (`claim`). DB-hiba itt HIBA, nem
     * fail-soft: rekord nélkül nincs tartós bemenet, amiből a futás elindulhatna,
     * tehát elfogadást sem szabad jelezni.
     */
    const attempt = async (): Promise<'reserved' | 'conflict'> => {
      try {
        const created = await turns.create({
          conversationId: params.conversationId,
          tenantId: params.tenantId,
          agentId: params.agentId,
          agentVersion: params.agentVersion,
          createdById: params.createdById,
          status: 'queued',
          input: params.input,
        })
        record.id = created.id
        return 'reserved'
      } catch (error) {
        if (error instanceof ActiveAgentTurnExistsError) return 'conflict'
        throw error
      }
    }

    if ((await attempt()) !== 'conflict') return { ok: true }

    // Ütközés: vagy tényleg fut egy forduló, vagy egy ELHALT rekord blokkol.
    const active = await turns.findActiveByConversation(params.conversationId).catch(() => null)
    if (active) {
      // #517: a queued fordulónak nincs futási tulajdonosa — a 120s heartbeat
      // watchdog csak running/streaming loopra vonatkozik. Queued = indításra vár,
      // D7 szerint a beszélgetés foglalt (409), nem „elhalt futás".
      const owned = (OWNED_AGENT_TURN_STATUSES as readonly string[]).includes(active.status)
      const heartbeatAt = active.heartbeatAt?.getTime?.()
      const alive =
        !owned ||
        typeof heartbeatAt !== 'number' ||
        Number.isNaN(heartbeatAt) ||
        heartbeatAt > Date.now() - resolveStaleTurnMs()
      if (alive) return { ok: false, activeTurnId: active.id }

      console.warn(
        '[agent-chat] elhalt forduló visszavétele a beszélgetésen',
        params.conversationId,
        active.id,
      )
      try {
        // A `null`/`skipped` is rendben van: azt jelenti, más már lezárta —
        // a hely mindkét esetben felszabadult. Ugyanaz a lezárás, mint a
        // ciklusos watchdogé (üzenet + failed/watchdog).
        await closeTurnAsWatchdog(
          { turns, conversations: this.conversations },
          active,
        )
      } catch (error) {
        console.error('[agent-chat] elhalt forduló visszavétele sikertelen', error)
        return { ok: false, activeTurnId: active.id }
      }
    }

    // A hely felszabadult — a blokkoló forduló közben lezárult, vagy most vettük
    // vissza. Pontosan EGY újrapróba: ha erre is ütközünk, valaki megelőzött.
    if ((await attempt()) !== 'conflict') return { ok: true }
    const retried = await turns.findActiveByConversation(params.conversationId).catch(() => null)
    return { ok: false, activeTurnId: retried?.id ?? null }
  }

  /**
   * #516 — a forduló-tár kötelező: e nélkül nincs tartós bemenet, amiből a
   * futás (akár másik processzben) rekonstruálható lenne.
   */
  private requireTurnStore(): AgentTurnRepository {
    if (!this.agentTurns) throw new Error('A forduló-tár nincs bekötve — a chat nem indítható.')
    return this.agentTurns
  }

  /**
   * Egy már LEFOGLALT, de futásba sosem induló rekord elengedése. E nélkül a
   * foglalás megmaradna, és a részleges egyedi index a beszélgetést lezárná —
   * pont az a befagyás, ami ellen a lejárat való. Fail-soft.
   */
  private async releaseReservedTurnRecord(
    record: TurnRecordHandle,
    error: string,
  ): Promise<void> {
    if (!this.agentTurns || !record.id) return
    try {
      await this.agentTurns.finalize(record.id, { status: 'failed', reason: 'error', error })
    } catch (e) {
      console.error('[agent-chat] lefoglalt forduló elengedése sikertelen', e)
    }
  }

  /**
   * Körönkénti életjel (D8/D10): ettől ismerhető fel kívülről az elhalt futás.
   * Egy kör egy modellhívás, tehát ez másodperces nagyságrendű, elsődleges kulcs
   * szerinti UPDATE — nem indokolt tovább ritkítani. Fail-soft: a heartbeat hibája
   * nem buktathatja a futást.
   */
  private async heartbeatTurnRecord(turn: StreamTurnContext): Promise<void> {
    if (!this.agentTurns || !turn.turnRecordId || !turn.turnRecordLockToken) return
    if (turn.turnRecordClosed) return
    const now = new Date()
    turn.lastHeartbeatAt = now.getTime()
    try {
      const owned = await this.agentTurns.heartbeat(turn.turnRecordId, turn.turnRecordLockToken, now)
      this.noteOwnership(turn, owned)
    } catch (error) {
      console.error('[agent-chat] forduló-heartbeat sikertelen', error)
    }
  }

  /**
   * #516 — a tulajdonoshoz kötött írás eredménye. `null` = a rekord már nem a
   * miénk (watchdog / Stop-lezárás / másik futtató). Egyszer megjegyzett
   * állapot: a következő checkpoint `TurnOwnershipLostError`-ral áll le.
   */
  private noteOwnership(turn: StreamTurnContext, owned: unknown): void {
    if (owned === null && !turn.ownershipLost) {
      turn.ownershipLost = true
      console.warn('[agent-chat] forduló tulajdonjoga elveszett', turn.turnRecordId)
    }
  }

  /**
   * Köztes snapshot a futó fordulóra (spec §5.3 / D9, #63). Fail-soft: a
   * snapshot hibája nem buktathatja a futást. Csak a lock birtokosa ír.
   */
  private async persistTurnProgress(
    turn: StreamTurnContext,
    flush: TurnSnapshotFlush | null,
  ): Promise<void> {
    if (!flush || !this.agentTurns || !turn.turnRecordId || !turn.turnRecordLockToken) return
    if (turn.turnRecordClosed) return
    if (flush.partialText === undefined && flush.activities === undefined) return
    try {
      const owned = await this.agentTurns.updateProgress(turn.turnRecordId, turn.turnRecordLockToken, {
        ...(flush.partialText !== undefined ? { partialText: flush.partialText } : {}),
        ...(flush.activities !== undefined
          ? { activities: flush.activities as unknown as Prisma.InputJsonValue }
          : {}),
      })
      this.noteOwnership(turn, owned)
    } catch (error) {
      console.error('[agent-chat] forduló-snapshot írás sikertelen', error)
    }
  }

  /**
   * issue #180 WP-1 — a loop-elszámolók kiírása a FUTÓ forduló rekordjára.
   *
   * Enélkül a `turn_count` / `tool_call_count` / `denied_count` csak a lezáráskor
   * kap értéket, tehát pont amíg egy futás elszalad, addig nulla látszik. Kör
   * eleji hívás, tehát ugyanolyan ritka, mint a heartbeat. Fail-soft: a
   * megfigyelhetőség hibája nem buktathatja a fordulót.
   */
  private async persistTurnCounters(
    turn: StreamTurnContext,
    counters: { turnCount: number; toolCallCount: number; deniedCount: number },
  ): Promise<void> {
    if (!this.agentTurns || !turn.turnRecordId || !turn.turnRecordLockToken) return
    if (turn.turnRecordClosed) return
    try {
      const owned = await this.agentTurns.updateProgress(
        turn.turnRecordId,
        turn.turnRecordLockToken,
        counters,
      )
      this.noteOwnership(turn, owned)
    } catch (error) {
      console.error('[agent-chat] forduló-számlálók írása sikertelen', error)
    }
  }

  /**
   * Forduló-rekord terminális lezárása. A repository csak aktív fordulót zár.
   * Átmeneti DB-hiba: egy újrapróbálás; ha az is elhasal, a rekord running
   * marad, és a watchdog a stale heartbeatből zár (#519). A `turnRecordClosed`
   * flag csak sikeres írás után áll — így a `finally` újra próbálhat.
   */
  private async closeTurnRecord(
    turn: StreamTurnContext | null,
    data: FinalizeAgentTurnInput,
  ): Promise<void> {
    if (!this.agentTurns || !turn?.turnRecordId || turn.turnRecordClosed) return
    const rawPartial = data.partialText ?? turn.completedReply ?? ''
    const payload: FinalizeAgentTurnInput = {
      ...data,
      partialText: guardTurnPartialText(rawPartial),
      activities: data.activities ?? (turn.activities as unknown as Prisma.InputJsonValue),
    }
    const write = () =>
      this.agentTurns!.finalize(turn.turnRecordId!, payload, turn.turnRecordLockToken ?? undefined)
    try {
      await write()
      turn.turnRecordClosed = true
    } catch (error) {
      // #519: átmeneti DB-kiesés — egy újrapróbálás, különben a watchdog zárja
      // a stale heartbeatből. Sikertelen írásra NEM jelöljük closednak.
      try {
        await write()
        turn.turnRecordClosed = true
      } catch (retryError) {
        console.error('[agent-chat] forduló-rekord lezárása sikertelen', retryError ?? error)
      }
    }
  }

  /**
   * Level-0 skill-index + `load_skill` végrehajtó összeállítása egy futáshoz
   * (skill-catalog-spec.md WP-5). Ha nincs SkillService bekötve vagy nincs
   * hozzárendelt skill, üres promptot és undefined callbacket ad — ilyenkor a
   * load_skill tool sem jelenik meg.
   */
  private async buildSkillBinding(
    agentId: string,
    tenantId: string | null,
  ): Promise<{
    skillIndexPrompt: string
    loadSkill?: LoadSkillFn
    loadSkillAttachment?: LoadSkillAttachmentFn
  }> {
    if (!this.skills) return { skillIndexPrompt: '' }
    const skills = this.skills
    const skillIndexPrompt = await skills.buildSkillIndexPrompt(agentId)
    if (!skillIndexPrompt) return { skillIndexPrompt: '' }
    const actor = { actorId: null, actorTenantId: tenantId, isPlatformAdmin: false }
    const loadSkill: LoadSkillFn = (skillVersionId) =>
      skills.loadSkillForAgent({ agentId, skillVersionId, actor })
    const loadSkillAttachment: LoadSkillAttachmentFn = (skillVersionId, path) =>
      skills.loadSkillAttachmentForAgent({ agentId, skillVersionId, path, actor })
    return { skillIndexPrompt, loadSkill, loadSkillAttachment }
  }

  private async resolveSlashSkillsForMessage(
    agentId: string,
    tenantId: string | null,
    messageText: string,
  ): Promise<SlashSkillResolution> {
    if (!this.skills) {
      return {
        modelFacingText: messageText,
        preloadedSkillPrompts: [],
        loadedSkillNames: [],
        loadedSkillVersionIds: [],
        blocked: [],
      }
    }
    const resolved = await this.skills.resolveSlashSkillLoads({
      agentId,
      messageText,
      actor: { actorId: null, actorTenantId: tenantId, isPlatformAdmin: false },
    })
    return {
      modelFacingText: resolved.modelFacingText,
      preloadedSkillPrompts: resolved.preloadedPrompts,
      loadedSkillNames: resolved.loadedSkillNames,
      loadedSkillVersionIds: resolved.loadedSkillVersionIds,
      blocked: resolved.blocked,
      ...(resolved.requiredTools ? { requiredTools: resolved.requiredTools } : {}),
      ...(resolved.attachmentsAvailable ? { attachmentsAvailable: true } : {}),
      runtimeHints: resolved.runtimeHints,
    }
  }

  /**
   * issue #161 — `preferredMode: 'task'` board-promóció.
   *
   * A hosszú skillt nem a chat fordulójában nyújtjuk ki: ticketet nyitunk
   * ugyanennek az agentnek, átvisszük a kérést, a csatolmányokat és a betöltött
   * skill-verziókat, majd azonnal elindítjuk `task` módban (ott a keretek eleve
   * tágabbak, és a részeredmény a ticketen marad). A dispatcher workerre nem várunk.
   *
   * `null` → nincs promóció, a chat a szokásos módon fut. A ticket felvételének
   * hibája NEM buktatja el a fordulót: ilyenkor is `null`-lal térünk vissza, és
   * a chat végzi el a feladatot — a szűkebb kerettel, de elvégzi.
   */
  private async trySkillTaskPromotion(input: {
    params: AgentChatSendParams
    agentDetails: AgentDetails
    conversationId: string
    userText: string
    slashResolved: SlashSkillResolution
    attachmentDocs: PreparedTurn['attachmentDocs']
  }): Promise<ChatProcessReply | null> {
    const { slashResolved } = input
    if (
      !shouldPromoteSkillRunToTask({
        runtimeHints: slashResolved.runtimeHints,
        loadedSkillNames: slashResolved.loadedSkillNames,
      })
    ) {
      return null
    }

    const question = (slashResolved.modelFacingText || input.userText).trim()
    if (!question) return null

    const title = buildSkillTaskTitle({
      skillNames: slashResolved.loadedSkillNames,
      userText: question,
    })
    const binding = buildSkillTaskPromotionBinding({
      conversationId: input.conversationId,
      documents: input.attachmentDocs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        mimeType: doc.mimeType,
        kind: isImageDocument(doc) ? 'screenshot' : 'file',
      })),
    })
    const attachmentTransfer = buildPromotedTaskAttachmentTransfer(input.attachmentDocs)
    const briefing =
      input.params.taskBriefing ??
      assembleTaskBriefingDraft({
        userText: question,
        attachmentNames: input.attachmentDocs.map((doc) => doc.filename),
        skillNames: slashResolved.loadedSkillNames,
      })

    try {
      const ticket = await this.tickets.create(
        {
          tenantId: input.params.tenantId ?? null,
          type: 'interaction',
          title,
          state: 'ready',
          assigneeType: 'agent',
          assigneeId: input.params.agentId,
          agentId: input.params.agentId,
          payload: {
            question,
            source: 'chat_skill_promotion',
            conversationId: binding.conversationId,
            attachmentDocumentIds: binding.attachmentDocumentIds,
            preferredSkillVersionIds: slashResolved.loadedSkillVersionIds,
            promotedSkillNames: slashResolved.loadedSkillNames,
            briefing: briefingToPayloadValue(briefing),
          } as Prisma.JsonValue,
          sourceDocumentId: attachmentTransfer.sourceDocumentId,
          conversationId: binding.conversationId,
          executeAfter: null,
          dueBy: null,
          createdById: input.params.createdById,
        },
        { attachments: attachmentTransfer.attachments },
      )

      await this.audit.append({
        actorType: 'human',
        actorId: input.params.createdById,
        agentVersion: input.agentDetails.agent.currentVersion,
        action: 'skill.task_promoted',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'allowed',
        tenantId: input.params.tenantId ?? null,
        conversationId: input.conversationId,
        ticketId: ticket.id,
        metadata: {
          skillNames: slashResolved.loadedSkillNames,
          skillVersionIds: slashResolved.loadedSkillVersionIds,
          attachmentCount: binding.attachmentDocumentIds.length,
        },
      })

      await this.triggerImmediateDispatch(ticket)

      return {
        text: buildSkillTaskPromotionMessage({
          skillNames: slashResolved.loadedSkillNames,
          ticketTitle: title,
          attachmentCount: binding.attachmentDocumentIds.length,
        }),
        ticketRefId: ticket.id,
      }
    } catch (error) {
      // Fail-soft: a promóció kényelem, nem kapu. Ha a ticket nem jött létre,
      // a chat futtatja a feladatot — inkább szűkebb kerettel, mint sehogy.
      console.error('[agent-chat] skill → board promóció sikertelen', error)
      return null
    }
  }

  /**
   * Nem-streamelő küldés. Ugyanazon az előkészítő és **ugyanazon a lezáró
   * ponton** megy át, mint a stream (D11): a különbség csak annyi, hogy nincs
   * feliratkozó, és megvárjuk a futás végét, hogy szinkron választ adhassunk.
   */
  /**
   * A forduló előkészítése a kérés-scope-ban, majd a futás **leválasztott**
   * indítása (spec §5.1, D3). Ami ide tartozik: jogosultság, a beszélgetés
   * feloldása, a csatolmányok munkaterületre tükrözése, a felhasználói üzenet
   * perzisztálása és a forduló **tulajdonjogának** megszerzése. Ami már NEM:
   * a prompt összeállítása, a tool-loop és a válasz — az a detached futásban
   * megy, és a kérés lezárása nem szakítja meg.
   */
  /**
   * Az agent-hozzáférési gráf user→agent kapuja a chat-indításnál (#142).
   *
   * `null`-t ad, ha a beszélgetés indítható; különben a KÉSZ hiba-eredményt, amit a
   * hívó változtatás nélkül visszaad. A hibaszöveg a felfedési szintből következik:
   * ha a felhasználó látja is az agentet, megtudja, hogy nincs joga megszólítani;
   * ha nem látja, opak „Agent not found" — a cél létezése nem szivárog ki.
   *
   * FAIL-CLOSED: ha a gráf-szolgáltatás nincs bekötve, a chat nem indul el.
   */
  private async assertChatAddressAllowed(
    params: AgentChatSendParams,
  ): Promise<BeginTurnResult | null> {
    if (!this.agentAccess) {
      return { kind: 'error', error: new Error('Agent not found') }
    }
    if (!params.tenantId) {
      return { kind: 'error', error: new Error('Agent not found') }
    }
    try {
      await this.agentAccess.assertCanAccessAgent({
        subject: { kind: 'user', userId: params.createdById, tenantId: params.tenantId },
        targetAgentId: params.agentId,
        verb: 'address',
        audit: {
          channel: 'chat',
          conversationId: params.conversationId ?? null,
          initiatingUserId: params.createdById,
        },
      })
      return null
    } catch (error) {
      if (error instanceof AgentAccessError) {
        return { kind: 'error', error: new Error(error.message) }
      }
      throw error
    }
  }

  private async beginTurn(params: AgentChatSendParams): Promise<BeginTurnResult> {
    const text = params.content.trim()
    const attachmentIds = params.attachmentDocumentIds ?? []
    if (!text && attachmentIds.length === 0) {
      return { kind: 'error', error: new Error('Message is required') }
    }

    const agentDetails = await this.agents.findByIdForRuntime(params.agentId)
    if (!agentDetails) return { kind: 'error', error: new Error('Agent not found') }
    if (!isAgentReachableFromTenant(agentDetails.agent.tenantId, params.tenantId ?? null)) {
      return { kind: 'error', error: new Error('Agent not found') }
    }
    // #142 — a chat-stream indítása user→agent `address` ige. A `view` jog
    // függvényében determinisztikusan 403- vagy 404-jellegű hibát ad, és minden
    // explicit próbát auditál (`agent.access.granted` / `agent.access.denied`).
    const chatGate = await this.assertChatAddressAllowed(params)
    if (chatGate) return chatGate

    let conversationId = params.conversationId
    if (conversationId) {
      const existing = await this.conversations.getConversation(
        conversationId,
        params.tenantId ?? null,
      )
      if (existing.conversation.agentId !== params.agentId) {
        return { kind: 'error', error: new Error('Conversation agent mismatch') }
      }
      if (
        params.projectKey &&
        params.tenantId &&
        params.projectKey !== existing.conversation.projectKey
      ) {
        await this.conversations.setProjectKey({
          conversationId,
          tenantId: params.tenantId,
          projectKey: params.projectKey,
        })
      }
    } else {
      const title = (text || 'Új beszélgetés').slice(0, 80)
      const created = await this.conversations.createConversation({
        agentId: params.agentId,
        createdById: params.createdById,
        tenantId: params.tenantId ?? null,
        title,
        projectKey: params.projectKey ?? '__general__',
      })
      conversationId = created.id
    }

    // Aktív-forduló foglalás (§5.1/3, D7). Szándékosan MINDEN további munka —
    // user-üzenet, indítás — előtt: ha a beszélgetésen már fut forduló, ez a
    // küldés semmilyen nyomot nem hagy. #516: a rekord a verziózott bemenettel
    // együtt, `queued` állapotban jön létre; a lassú csatolmány- / workspace-
    // előkészítés már a futtatóban (`runReservedTurn`) történik.
    const turnRecord: TurnRecordHandle = { id: null }
    const reservation = await this.reserveTurnRecord(turnRecord, {
      conversationId,
      tenantId: params.tenantId ?? null,
      agentId: params.agentId,
      agentVersion: agentDetails.agent.currentVersion,
      createdById: params.createdById,
      input: buildStoredTurnInput({ ...params, content: text }) as unknown as Prisma.InputJsonValue,
    })
    if (!reservation.ok) {
      return { kind: 'conflict', conversationId, activeTurnId: reservation.activeTurnId }
    }
    const turnId = turnRecord.id!

    const userFacingText = text || '(csatolmányok)'
    let persistedUserMessage: Message | null = null
    let userMessage: Message
    try {
      userMessage = await this.conversations.appendMessage({
        conversationId,
        role: 'user',
        content: encodeStoredMessage(userFacingText, attachmentIds),
        actingUserId: params.createdById,
        actorType: 'human',
        actorId: params.createdById,
        onPersisted: (message) => {
          persistedUserMessage = message
        },
      })
      // A foglalás a user-üzenet ELŐTT történt, így a rekord csak most kapja meg
      // a hivatkozást. Ez NEM fail-soft: bekötés nélkül a futtató nem találná
      // az eredeti feladatot, tehát a fogadás sem lenne igaz.
      await this.requireTurnStore().attachUserMessage(turnRecord.id!, userMessage.id)
    } catch (error) {
      // Az üzenet commitja után az audit/ref frissítés még hibázhat. Ilyenkor az
      // ACK-nak meg kell előznie a hibát, különben a kliens egy DB-ben lévő sort törölne.
      // A már lefoglalt helyet MINDENKÉPP el kell engedni, különben a beszélgetés
      // a foglalással együtt bezárul.
      await this.releaseReservedTurnRecord(
        turnRecord,
        error instanceof Error ? error.message : 'Message persist failed',
      )
      return {
        kind: 'error',
        error: error instanceof Error ? error : new Error('Message persist failed'),
        ...(persistedUserMessage
          ? {
              meta: {
                conversationId,
                userMessageId: (persistedUserMessage as Message).id,
              },
            }
          : {}),
      }
    }

    // Tartós fogadás megvan: a rekord, a bemenet és a user-üzenet összekötve.
    // Az indítás innentől a launcher + egyeztető ciklus dolga; a gyors
    // próbálkozás csak optimalizáció. Átmeneti / elveszett válasz NEM zárja
    // le a fordulót — a ciklus egyeztet és újrapróbál (#517).
    const accepted = await this.requireTurnStore().findById(turnId)
    if (!accepted) {
      return {
        kind: 'error',
        error: new Error('A forduló nem található a fogadás után.'),
        meta: { conversationId, userMessageId: userMessage.id },
      }
    }
    const launched = await launchAcceptedChatTurn(
      {
        turns: this.requireTurnStore(),
        launcher: this.launcher,
        conversations: this.conversations,
      },
      accepted,
    )
    if (launched.kind === 'failed') {
      return {
        kind: 'error',
        error: new Error(launched.error),
        meta: { conversationId, userMessageId: userMessage.id },
      }
    }

    return {
      kind: 'started',
      turnId,
      conversationId,
      userMessageId: userMessage.id,
      subscribe: agentTurnRunner.isRunning(turnId) ? () => agentTurnRunner.subscribe(turnId)! : null,
    }
  }

  /** ponytail: finish-kick only looks at 5 waiters; the rest wait for the ~30s dispatch cycle. Drain until waiting/global_full if kick latency becomes the bottleneck. */
  private kickQueuedTurns(): void {
    if (!this.agentTurns) return
    this.recoverQueuedTurns({ limit: 5 }).catch((error) => {
      console.error('[agent-chat] sorban álló fordulók indítása sikertelen', error)
    })
  }

  /**
   * #517 — a dispatch-ciklus hívja: tartós, még el nem indult queued fordulók
   * egyeztetése és indítása. Stale running loopot nem játssza újra.
   */
  async recoverQueuedTurns(input: {
    limit?: number
    now?: Date
  } = {}): Promise<RecoverQueuedChatTurnsSummary> {
    return recoverQueuedChatTurns({
      turns: this.requireTurnStore(),
      launcher: this.launcher,
      conversations: this.conversations,
      now: input.now,
      limit: input.limit,
    })
  }

  /**
   * #516 — a KÖZÖS FUTTATÓMAG. Kizárólag a forduló azonosítójából dolgozik:
   * DB-ből tölti a rekordot és a verziózott bemenetet, atomi `queued → running`
   * claimet szerez saját tulajdonos-tokennel, elvégzi a lassú előkészítést
   * (csatolmányok, workspace), majd végrehajt és finalizál. Nem függ a
   * webprocessz closure-jeitől, GCP SDK-tól vagy event-busztól — az `emit` csak
   * egy opcionális megfigyelő (in-process módban a Tier-1 runner busza).
   *
   * A `launchId` az indítás korrelációja; NEM azonos a tulajdonos-tokennel:
   * két azonos indításból a claim miatt legfeljebb egy fut.
   */
  async runReservedTurn(
    request: { turnId: string; launchId: string },
    emit: AgentTurnEmit = () => {},
  ): Promise<void> {
    const turns = this.requireTurnStore()
    const { turnId, launchId } = request
    const record = await turns.findById(turnId)
    if (!record) throw new Error(`A forduló nem található: ${turnId}`)
    // #519: Stop után a késői worker ne claimeljen és ne indítson eszközt —
    // a queued visszavonás tartós, a claim `cancelRequested`-et is nézi.
    if (record.status === 'queued' && record.cancelRequested) {
      await cancelQueuedChatTurn(turns, turnId)
      return
    }
    // A bemenet ellenőrzése a claim ELŐTT: hiányos / ismeretlen verziójú
    // rekordot nem veszünk át (ne fusson más kontextussal). A hiba viszont
    // TERMINÁLIS — queued-en hagyni D7-zárolná a beszélgetést a watchdogig.
    let input
    try {
      input = parseStoredTurnInput(record.input)
      if (!record.userMessageId) {
        throw new StoredTurnInputError('A forduló mentett bemenetéhez nem tartozik user-üzenet.')
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'A forduló mentett bemenete érvénytelen.'
      emit({ type: 'error', message })
      const failed: StreamTurnContext = {
        conversationId: record.conversationId,
        userMessageCreatedAt: record.startedAt,
        agentId: record.agentId,
        agentVersion: record.agentVersion,
        createdById: record.createdById,
        model: '',
        activities: [],
        completedReply: null,
        finalized: false,
        turnRecordId: turnId,
        turnRecordLockToken: null,
        turnRecordClosed: false,
        lastHeartbeatAt: Date.now(),
        ownershipLost: false,
      }
      await this.persistFailedTurn(failed, message)
      await this.closeTurnRecord(failed, { status: 'failed', reason: 'error', error: message })
      return
    }

    const ownerToken = randomUUID()
    const claimed = await turns.claim(turnId, ownerToken, new Date(), launchId)
    if (!claimed) {
      // Más futtató már átvette, a launchId lejárt, vagy a forduló időközben
      // terminális lett (Stop / watchdog). Mellékhatás nélkül kilépünk.
      console.warn('[agent-chat] forduló-claim sikertelen — más tulajdonos vagy lezárt forduló', {
        turnId,
        launchId,
      })
      return
    }

    const params: AgentChatSendParams = {
      agentId: record.agentId,
      content: input.content,
      createdById: record.createdById,
      tenantId: record.tenantId,
      conversationId: record.conversationId,
      projectKey: input.projectKey,
      attachmentDocumentIds: input.attachmentDocumentIds,
      processDefinitionId: input.processDefinitionId,
      processInputPayload: input.processInputPayload,
      consequenceApprovalContinuation: input.consequenceApprovalContinuation,
      connectorGrantContinuation: input.connectorGrantContinuation,
      taskBriefing: input.taskBriefing,
      modelContextPrefix: input.modelContextPrefix,
    }
    const turn: StreamTurnContext = {
      conversationId: record.conversationId,
      userMessageCreatedAt: record.startedAt,
      agentId: record.agentId,
      agentVersion: record.agentVersion,
      createdById: record.createdById,
      model: '',
      activities: [],
      completedReply: null,
      finalized: false,
      turnRecordId: turnId,
      turnRecordLockToken: ownerToken,
      turnRecordClosed: false,
      lastHeartbeatAt: Date.now(),
      ownershipLost: false,
    }

    let prepared: PreparedTurn
    try {
      // Tenant-védelem újra, a futtató saját jogosultságával: a rekord nem
      // bizonyíték arra, hogy az agent MOST is elérhető a tenantból.
      const agentDetails = await this.agents.findByIdForRuntime(record.agentId)
      if (
        !agentDetails ||
        !isAgentReachableFromTenant(agentDetails.agent.tenantId, record.tenantId)
      ) {
        throw new Error('Agent not found')
      }
      const modelConfig = agentDetails.agent.modelConfig as ChatModelConfig
      turn.model = modelConfig.model
      turn.agentVersion = record.agentVersion

      const history = await this.conversations.getConversation(record.conversationId, record.tenantId)
      const userMessage = history.messages.find((m) => m.id === record.userMessageId)
      if (!userMessage) {
        throw new Error('A forduló user-üzenete nem található a beszélgetésben.')
      }
      turn.userMessageCreatedAt = userMessage.createdAt

      const attachmentDocs = await this.loadDocuments(input.attachmentDocumentIds, record.tenantId)
      const attachmentBlock = formatAttachmentBlock(attachmentDocs)
      const tenantKey = record.tenantId ?? 'global'
      // A fájlokat a beszélgetés munkaterületére tükrözzük, hogy az agent
      // fájl-eszközei a pontos néven, teljes tartalommal elérjék őket. Sorrend
      // számít: a chat-csatolmányok elsőbbséget élveznek az azonos nevű
      // tudásbázis-fájllal szemben, és a korábbi körök fájljait nem írjuk felül.
      const presentFiles = new Set(await this.listWorkspaceFiles(tenantKey, record.conversationId))
      await this.materializeDocumentsToWorkspace(
        tenantKey,
        record.conversationId,
        attachmentDocs,
        presentFiles,
        'user',
      )
      const knowledgeDocs = await this.loadAgentKnowledgeDocuments(record.agentId)
      await this.materializeDocumentsToWorkspace(
        tenantKey,
        record.conversationId,
        knowledgeDocs,
        presentFiles,
        'internal',
      )
      const workspaceFiles = await this.listUserFacingWorkspaceFiles(tenantKey, record.conversationId)

      prepared = {
        params,
        turn,
        turnId,
        agentDetails,
        modelConfig,
        conversationId: record.conversationId,
        text: input.content,
        tenantKey,
        attachmentBlock,
        attachmentDocs,
        workspaceFiles,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Turn preparation failed'
      emit({ type: 'error', message })
      await this.persistFailedTurn(turn, message)
      await this.closeTurnRecord(turn, { status: 'failed', reason: 'error', error: message })
      return
    }

    await this.executeTurn(prepared, emit)
  }

  /**
   * A forduló tényleges végrehajtása — **ez a kliens-független lezáró pont** (D2).
   * A hívója a runner, nem a HTTP-kérés: az események egy buszra mennek, amire
   * feliratkozó lehet, de nem kötelező. A végleges assistant-üzenet írása és a
   * forduló-rekord terminális lezárása minden kilépési úton itt, a `finally`-ban
   * történik — akkor is, ha közben senki nem olvas.
   */
  private async executeTurn(
    prepared: PreparedTurn,
    emit: AgentTurnEmit,
  ): Promise<TurnExecutionResult> {
    const {
      params,
      turn,
      turnId,
      agentDetails,
      modelConfig,
      conversationId,
      text,
      tenantKey,
      attachmentBlock,
      attachmentDocs,
      workspaceFiles,
    } = prepared

    let outcome: FinalizeAgentTurnInput = { status: 'failed', reason: 'error' }
    let reply = ''
    let messageId: string | null = null
    let ticketRefId: string | null = null
    // A tool-loop erőforrás-alapú leállásának indoka (#62). `null`, ha a loop
    // normálisan futott végig — ilyenkor a forduló `completed`.
    let loopStopReason: ToolLoopStopReason | null = null
    // A forduló-rekord számlálói. E nélkül a `finalize` alapértéken hagyja őket,
    // és a lezárt forduló nullát mutat akkor is, ha tucatnyi eszközhívás futott —
    // az üzemeltető a hibakereső exportban nem látja, min ment el a keret, a
    // prompt-eval red-line pedig üres méréssel fut. A körszámot az `onTurnStart`
    // adja (a loop kívülről csak ott jelzi a kör indulását), a tool-számlálókat
    // a loop visszatérési értéke.
    let loopTurnCount = 0
    let loopToolCallCount = 0
    let loopDeniedCount = 0
    // Köztes snapshot fojtás + tartalom-őr (#63 / D9 / Q4).
    // DB-backed cancel cache: in-memory flag VAGY periodikus DB-olvasás (D6 / multi-instance).
    let dbCancelRequested = false
    let lastDbCancelCheckAt = 0
    const CANCEL_DB_POLL_MS = 1_000

    const refreshCancelFromDb = async (): Promise<boolean> => {
      if (!turn.turnRecordId || !this.agentTurns) return dbCancelRequested
      const now = Date.now()
      if (now - lastDbCancelCheckAt < CANCEL_DB_POLL_MS && lastDbCancelCheckAt > 0) {
        return dbCancelRequested
      }
      lastDbCancelCheckAt = now
      dbCancelRequested = await pollCancelRequested({
        read: () => this.agentTurns!.isCancelRequested(turn.turnRecordId!),
        previous: dbCancelRequested,
      })
      return dbCancelRequested
    }

    const isCancelRequestedNow = (): boolean => {
      // A helyi jel csak gyorsítás; az igazság forrása a rekord DB-flagje (#65).
      // #516 — elvesztett tulajdonjog = azonnali kooperatív leállás: nincs több
      // modell-/tool-hívás; a checkpoint `TurnOwnershipLostError`-ral zár.
      if (turn.ownershipLost) return true
      if (agentTurnRunner.isCancelRequested(turnId) || dbCancelRequested) return true
      // Async refresh kick — a következő checkpointon érvényesül.
      void refreshCancelFromDb()
      return dbCancelRequested
    }
    const snapshot = new TurnSnapshotFlusher()

    const egressMatrix = await this.loadEgressMatrix(params.tenantId ?? null)
    const displayResolver = createWebUiStreamingResolver({
      engine: this.surrogateEngine,
      tenantId: params.tenantId ?? null,
      conversationId,
      requesterUserId: params.createdById,
      matrix: egressMatrix,
      emit: async (text) => {
        emit({ type: 'token', chunk: text })
        await this.persistTurnProgress(turn, snapshot.pushToken(text))
      },
    })
    const emitToken = async (chunk: string) => {
      await displayResolver.push(chunk)
    }
    const finishDisplay = async () => {
      await displayResolver.finish()
    }
    const emitActivity = async (activity: ToolLoopActivityEvent) => {
      const flush = snapshot.pushActivity(activity)
      turn.activities = snapshot.activityList
      emit({ type: 'activity', activity })
      await this.persistTurnProgress(turn, flush)
    }

    /**
     * Modell-hívás NÉLKÜL előálló válasz kiadása (Folyamat-indítás, skill →
     * board-promóció): ugyanaz a stream-szerződés, mint a modellezett fordulóé —
     * darabolt tokenek, Stop-ellenőrzés minden darabnál, majd terminális lezárás.
     */
    const deliverPreparedReply = async (prepared: ChatProcessReply): Promise<void> => {
      reply = prepared.text
      turn.completedReply = prepared.text
      for (const chunk of chunkForStreaming(prepared.text)) {
        await refreshCancelFromDb()
        if (isCancelRequestedNow()) {
          await finishDisplay()
          const cancelledId = await this.cancelTurnIfRequested(turn, true)
          if (cancelledId) {
            messageId = cancelledId
            outcome = {
              status: 'cancelled',
              reason: 'cancelled',
              assistantMessageId: cancelledId,
            }
            emit({
              type: 'done',
              conversationId,
              messageId: cancelledId,
              reason: 'cancelled',
            })
            return
          }
        }
        await emitToken(chunk)
        await new Promise<void>((r) => setTimeout(r, 12))
      }
      await finishDisplay()
      const persistedId = await this.finalizeAgentTurn(turn, prepared.text, {
        ticketRefId: prepared.ticketRefId ?? null,
      })
      turn.finalized = true
      messageId = persistedId
      ticketRefId = prepared.ticketRefId ?? null
      outcome = { status: 'completed', assistantMessageId: persistedId }
      emit({
        type: 'done',
        conversationId,
        messageId: persistedId,
        ticketRefId: prepared.ticketRefId ?? null,
      })
    }

    const runBody = async (): Promise<void> => {
      const processReply = await this.tryStartChatTriggeredProcess({
        tenantId: params.tenantId ?? null,
        processDefinitionId: params.processDefinitionId,
        message: text,
        explicitPayload: params.processInputPayload,
        conversationId,
        startedByUserId: params.createdById,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        modelConfig,
        attachmentDocs,
        taskBriefing: params.taskBriefing,
      })
      if (processReply) {
        await deliverPreparedReply(processReply)
        return
      }

      const slashResolved = await this.resolveSlashSkillsForMessage(
        params.agentId,
        params.tenantId ?? null,
        text,
      )

      // Futásidejű readiness-kapu: ha a kért skill hiányzó capability miatt nem
      // tölthető be, NEM indítjuk el a fordulót „skill nélkül" — az pont az a
      // csendes félrefutás, ami hiányos munkaterméket ad késznek. Helyette
      // megmondjuk, mi hiányzik és ki tudja megadni.
      if (slashResolved.blocked.length > 0) {
        for (const b of slashResolved.blocked) {
          await emitActivity({
            id: `skill-blocked-${b.name}`,
            kind: 'tool',
            title: `Skill blokkolva: ${b.name}`,
            detail: `hiányzó eszköz-jogosultság: ${b.missingTools.join(', ')}`,
            status: 'skipped',
          })
        }
        await deliverPreparedReply({
          text: slashResolved.blocked.map((b) => b.reason).join('\n\n'),
        })
        return
      }

      // issue #161 — `preferredMode: 'task'`: a hosszú skillt nem a chatben
      // nyújtjuk 15 percre, hanem ticketet nyitunk és azonnal elindítjuk.
      // A chat rövid marad; a felhasználó a ticket hivatkozását kapja vissza.
      const promotion = await this.trySkillTaskPromotion({
        params,
        agentDetails,
        conversationId,
        userText: text,
        slashResolved,
        attachmentDocs,
      })
      if (promotion) {
        for (const skillName of slashResolved.loadedSkillNames) {
          await emitActivity({
            id: `skill-slash-${skillName}`,
            kind: 'tool',
            title: `Képesség betöltve: ${skillName}`,
            detail: 'Felhasználói /slash parancs alapján',
            status: 'done',
          })
        }
        await deliverPreparedReply(promotion)
        return
      }
      const latestUserTextOverride = params.modelContextPrefix
        ? `${params.modelContextPrefix}\n\n${slashResolved.modelFacingText}`
        : slashResolved.modelFacingText !== text
          ? slashResolved.modelFacingText
          : undefined
      const kbSearch = await this.fetchKbSearchContext({
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        conversationId,
        actingUserId: params.createdById,
        query: slashResolved.modelFacingText || text,
      })
      const history = await this.conversations.getConversation(
        conversationId,
        params.tenantId ?? null,
      )
      const memoryContext = await this.retrieveProjectMemoryContext({
        agentDetails,
        projectKey: history.conversation.projectKey,
        query: buildMemoryRetrievalQuery({
          queryKind: 'chat',
          latestUserMessage: slashResolved.modelFacingText || text,
          recentMessages: history.messages,
        }),
        tenantId: params.tenantId ?? null,
        conversationId,
      })
      // A betanított szabály-blokk ugyanúgy fix prompt-teher, mint a
      // retrieval-blokk — a történet-budgetből le kell vonni, különben a
      // beszélgetés-előzmény túlcsordítja a keretet.
      const trainedRulesTokens = trainedRulesSystemMessages({
        content: agentDetails.memoryContent,
        version: agentDetails.memoryVersion,
      }).tokens
      const assembledContext = await assembleContext({
        audit: this.audit,
        conversationId,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        actingUserId: params.createdById,
        messages: history.messages,
        memoryVersion: agentDetails.memoryVersion,
        memoryContextTokens: memoryContext.tokens + trainedRulesTokens,
        documentAliases: this.contextDocumentAliases(attachmentDocs, workspaceFiles, kbSearch.hits),
      })
      const priorToolCalls = await this.toolCaps.listToolCallsForConversation(conversationId)
      const continuationPrompt = await this.buildContinuationPrompt(conversationId, workspaceFiles)
      const delegationPrompt = await this.buildReturnedDelegationPrompt(conversationId)
      const ticketDiscussionPrompt = await this.buildTicketDiscussionPrompt(
        history.conversation.continuedFromTicketId,
      )
      const gatewayPrompt = await this.buildGatewayMessages(
        agentDetails,
        assembledContext.messages,
        attachmentBlock,
        kbSearch,
        workspaceFiles,
        priorToolCalls,
        latestUserTextOverride,
        memoryContext.block,
        continuationPrompt,
        delegationPrompt,
        ticketDiscussionPrompt,
      )

      const allowedChatTools = await listAllowedChatTools(
        this.toolCaps,
        params.agentId,
        agentDetails.agent,
      )
      const maxTurns = resolveToolLoopMaxTurns(modelConfig, allowedChatTools)
      const skillBinding = await this.buildSkillBinding(params.agentId, params.tenantId ?? null)
      // Futásidejű skill-snapshot perzisztálás a reprodukálhatósághoz (WP-5/D9/D12):
      // a conversationhoz kötve rögzítjük, mely skill-verziók voltak élők a futáskor.
      if (this.skills && skillBinding.loadSkill) {
        await this.skills.recordRunSkillSnapshot({
          agentId: params.agentId,
          context: { conversationId },
          actorTenantId: params.tenantId ?? null,
        })
      }

      for (const skillName of slashResolved.loadedSkillNames) {
        const activity: ToolLoopActivityEvent = {
          id: `skill-slash-${skillName}`,
          kind: 'tool',
          title: `Képesség betöltve: ${skillName}`,
          detail: 'Felhasználói /slash parancs alapján',
          status: 'done',
        }
        await emitActivity(activity)
      }

      // A tool-loop akkor is fut, ha nincs capability-tool, de van hozzárendelt skill
      // (a load_skill elérhetőségéhez), különben az index behúzhatatlan lenne (WP-5).
      if (
        allowedChatTools.length > 0 ||
        skillBinding.loadSkill ||
        slashResolved.preloadedSkillPrompts.length > 0
      ) {
        const thinkingEnabled = this.isThinkingTraceEnabled
          ? await this.isThinkingTraceEnabled(params.tenantId ?? null)
          : false

        const result = await runAgentToolLoop({
          gateway: this.gateway,
          toolBroker: this.toolBroker,
          toolCaps: this.toolCaps,
          agentId: params.agentId,
          agentVersion: agentDetails.agent.currentVersion,
          // issue #180 WP-2 — a forduló azonosítója végigmegy a gateway-hívásokon,
          // így a per-forduló token- és cache-költség egyetlen lekérdezéssel
          // megkapható (nem időbélyeg-illesztéssel).
          context: {
            conversationId,
            ...(params.tenantId ? { tenantId: params.tenantId } : {}),
            ...(turn.turnRecordId ? { agentTurnId: turn.turnRecordId } : {}),
          },
          mode: 'chat',
          actingUserId: params.createdById,
          promptSegments: gatewayPrompt,
          modelConfig,
          allowedTools: allowedChatTools,
          maxTurns,
          skillIndexPrompt: skillBinding.skillIndexPrompt,
          preloadedSkillPrompts: slashResolved.preloadedSkillPrompts,
          loadSkill: skillBinding.loadSkill,
          loadSkillAttachment: skillBinding.loadSkillAttachment,
          ...(slashResolved.attachmentsAvailable
            ? { initialSkillAttachmentsAvailable: true }
            : {}),
          initialSkillRuntimeHints: slashResolved.runtimeHints,
          ...(slashResolved.requiredTools
            ? { initialSkillToolScope: slashResolved.requiredTools }
            : {}),
          // #468 D4: a korábban már hívott toolok discovery nélkül aktiválódnak.
          priorToolNames: [...new Set(priorToolCalls.map((c) => c.toolName))],
          archiveLargeToolResult: createWorkspaceToolResultArchiver(this.workspaceStorage, tenantKey, conversationId),
          writeWorkspaceFile: async (path, content, audience = 'internal') => {
            try {
              const bytes = Buffer.from(content, 'utf8')
              await this.workspaceStorage.write(tenantKey, conversationId, path, bytes)
              await this.workspaceStorage.setFileAudience(tenantKey, conversationId, path, audience)
              return { bytes: bytes.length }
            } catch {
              return null
            }
          },
          listWorkspaceFiles: () => this.listWorkspaceFiles(tenantKey, conversationId),
          readWorkspaceFile: async (path) => {
            try {
              const buf = await this.workspaceStorage.read(tenantKey, conversationId, path)
              return buf ? buf.toString('utf8') : null
            } catch {
              return null
            }
          },
          resumeCheckpoint:
            Boolean(continuationPrompt) || isExplicitContinuationRequest(text),
          shouldCancel: () => isCancelRequestedNow(),
          // Körönkénti életjel: ettől ismerhető fel kívülről az elhalt futás (D10).
          // A `turnIndex` 0-alapú, tehát a MEGKEZDETT körök száma index+1 — így a
          // rekord akkor is a valós körszámot mutatja, ha a loop kivétellel áll le.
          onTurnStart: async (turnIndex: number, counters) => {
            loopTurnCount = turnIndex + 1
            loopToolCallCount = counters.toolCallCount
            loopDeniedCount = counters.deniedCount
            await this.heartbeatTurnRecord(turn)
            // #516 — az életjel tulajdonvesztést jelzett: MÉG a kör modellhívása
            // előtt állunk le (a loop saját cancel-checkpointja a kör elején, az
            // életjel ELŐTT van, tehát az csak a következő körben venné észre).
            if (turn.ownershipLost) throw new TurnOwnershipLostError()
            // issue #180 WP-1 — a számlálók a FUTÓ fordulón is látszanak, nem
            // csak lezárás után: egy elszaladt futásba csak így lehet beavatkozni.
            await this.persistTurnCounters(turn, {
              turnCount: loopTurnCount,
              toolCallCount: loopToolCallCount,
              deniedCount: loopDeniedCount,
            })
            await refreshCancelFromDb()
          },
          onActivity: async (activity) => {
            await emitActivity(activity)
            // Modell-várakozási életjel: hosszú modellhívás alatt a loop
            // újra kiadja a futó állapotot — a `heartbeatAt` is frissül,
            // különben a chat-forduló tévesen „megállt"-ot mutatna. A fojtás
            // miatt legfeljebb az életjel-ütemben ír DB-t. Fail-soft.
            if (Date.now() - (turn.lastHeartbeatAt ?? 0) >= MODEL_WAIT_HEARTBEAT_MS) {
              await this.heartbeatTurnRecord(turn)
            }
          },
          ...(thinkingEnabled
            ? {
                onReasoning: (turnId: string, delta: string) =>
                  emit({ type: 'thinking', turnId, delta }),
              }
            : {}),
          resolveAssistantDisplay: async (text: string) => {
            let out = ''
            const egressMatrix = await this.loadEgressMatrix(params.tenantId ?? null)
            const resolver = createWebUiStreamingResolver({
              engine: this.surrogateEngine,
              tenantId: params.tenantId ?? null,
              conversationId,
              requesterUserId: params.createdById,
              matrix: egressMatrix,
              emit: (chunk) => {
                out += chunk
              },
            })
            await resolver.push(text)
            await resolver.finish()
            return out
          },
          onMemoryCandidate: (candidate) => emit({ type: 'memory_candidate', candidate }),
          // Folytatás: a külső tartalom envelope továbbra is releváns a modellnek,
          // de a consequence gate már risk-class (nem taint) alapú — initialTainted
          // legacy jel, a kapu nem használja workspace-írás blokkolására.
          initialTainted: params.consequenceApprovalContinuation === true,
          ...(this.consequenceApprovals
            ? {
                createConsequenceApproval: async (invoke) =>
                  this.consequenceApprovals!.createFromBlocked({
                    invoke,
                    tenantId: params.tenantId ?? null,
                  }),
                onConsequenceApproval: (approval) =>
                  emit({ type: 'consequence_approval', approval }),
              }
            : {}),
          onConnectorGrantNeeded: (grant) => emit({ type: 'connector_grant_needed', grant }),
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )

        if (!result.ok) {
          if (result.error instanceof AgentToolLoopCancelledError) {
            await refreshCancelFromDb()
            await finishDisplay()
            const cancelledId = await this.cancelTurnIfRequested(turn, true)
            messageId = cancelledId
            outcome = {
              status: 'cancelled',
              reason: 'cancelled',
              assistantMessageId: cancelledId,
            }
            if (cancelledId) {
              emit({
                type: 'done',
                conversationId,
                messageId: cancelledId,
                reason: 'cancelled',
              })
            }
            return
          }
          const message = result.error instanceof Error ? result.error.message : 'Tool loop failed'
          outcome = { status: 'failed', reason: 'error', error: message }
          emit({ type: 'error', message })
          await finishDisplay()
          await this.persistFailedTurn(turn, message, snapshot.partialText)
          return
        }
        const preapprovedNotice = formatPreapprovedRunSummary(
          result.value.preapprovedWriteSummary ?? [],
        )
        reply = preapprovedNotice
          ? `${result.value.content.trim()}\n\n_${preapprovedNotice}_`
          : result.value.content
        await this.publishReferencedWorkspaceFiles(tenantKey, conversationId, reply)
        loopToolCallCount = result.value.toolCallCount
        loopDeniedCount = result.value.deniedCount
        // Fallback-attribúció: ha a loop tartalék modellen dolgozott, az üzeneten
        // a TÉNYLEGES modell álljon, ne a konfigurált. Mért eset (2026-09-15):
        // `gpt-5.5` szerepelt az üzeneten, miközben 52 hívást a deepseek vitt —
        // a költség- és minőség-elemzés máshogy hamis.
        const executedModel = result.value.executedModel
        if (executedModel?.model) turn.model = executedModel.model
        if (result.value.status === 'exhausted') {
          loopStopReason = result.value.reason
        }
        turn.completedReply = reply
        for (const chunk of chunkForStreaming(reply)) {
          await refreshCancelFromDb()
          if (isCancelRequestedNow()) {
            await finishDisplay()
            const cancelledId = await this.cancelTurnIfRequested(turn, true)
            if (cancelledId) {
              messageId = cancelledId
              outcome = {
                status: 'cancelled',
                reason: 'cancelled',
                assistantMessageId: cancelledId,
              }
              emit({
                type: 'done',
                conversationId,
                messageId: cancelledId,
                reason: 'cancelled',
              })
              return
            }
          }
          await emitToken(chunk)
          await new Promise<void>((r) => setTimeout(r, 12))
        }
        await finishDisplay()
        reply = snapshot.partialText
        turn.completedReply = reply
      } else {
        // Chat "thinking-trace" (tool nélküli ág): a reasoning-summary deltákat
        // közös stateful tartalom-őr (D5) mögött gyűjtjük, és a következő token
        // előtt ürítjük ki `thinking` eseményként. turnId egyetlen körre `reasoning-0`.
        const thinkingEnabled = this.isThinkingTraceEnabled
          ? await this.isThinkingTraceEnabled(params.tenantId ?? null)
          : false
        const pendingThinking: string[] = []
        const reasoningRedactor = new StreamingSensitiveTextRedactor((value) =>
          pendingThinking.push(value),
        )
        const onReasoningDelta = thinkingEnabled
          ? (delta: string) => reasoningRedactor.push(delta)
          : undefined
        const gatewayInput = {
          agentId: params.agentId,
          agentVersion: agentDetails.agent.currentVersion,
          conversationId,
          // issue #180 WP-2 — a tool nélküli ág költsége is a fordulóhoz kötve.
          ...(turn.turnRecordId ? { agentTurnId: turn.turnRecordId } : {}),
          actingUserId: params.createdById,
          messages: assembleGatewayMessages(gatewayPrompt),
          modelConfig,
          ...(onReasoningDelta ? { onReasoningDelta } : {}),
        }
        for await (const chunk of this.gateway.callStream(gatewayInput)) {
          await refreshCancelFromDb()
          if (isCancelRequestedNow()) {
            await finishDisplay()
            const cancelledId = await this.cancelTurnIfRequested(turn, true)
            if (cancelledId) {
              messageId = cancelledId
              outcome = {
                status: 'cancelled',
                reason: 'cancelled',
                assistantMessageId: cancelledId,
              }
              emit({
                type: 'done',
                conversationId,
                messageId: cancelledId,
                reason: 'cancelled',
              })
              return
            }
          }
          while (pendingThinking.length > 0) {
            emit({ type: 'thinking', turnId: 'reasoning-0', delta: pendingThinking.shift()! })
          }
          await emitToken(chunk)
        }
        reasoningRedactor.finish()
        while (pendingThinking.length > 0) {
          emit({ type: 'thinking', turnId: 'reasoning-0', delta: pendingThinking.shift()! })
        }
        await finishDisplay()
        reply = snapshot.partialText
        turn.completedReply = reply
      }

      const persistedId = await this.finalizeAgentTurn(turn, reply)
      turn.finalized = true
      messageId = persistedId
      // A loop erőforrás-korlát miatti leállása a rekordon is látszik (#62): a
      // válasz megvan, de a forduló nem futott végig — ezt `exhausted` jelöli.
      outcome = loopStopReason
        ? { status: 'exhausted', reason: loopStopReason, assistantMessageId: persistedId }
        : { status: 'completed', assistantMessageId: persistedId }
      emit({ type: 'done', conversationId, messageId: persistedId })
    }

    try {
      await runBody()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent turn failed'
      outcome = {
        status: 'failed',
        reason: error instanceof TurnOwnershipLostError ? 'ownership_lost' : 'error',
        error: message,
      }
      emit({ type: 'error', message })
      // Az SSE `error` esemény múlékony: aki nem nézi épp a képernyőt, vagy
      // újratölt, annak nyoma sem marad. A lezáró üzenet a beszélgetésbe kerül,
      // így a leállás oka utólag is látszik (a watchdog-lezárás mintájára).
      await finishDisplay()
      await this.persistFailedTurn(turn, message, snapshot.partialText)
    } finally {
      // Terminális teljes részszöveg (§5.3): completedReply, vagy ami a flusherben
      // már összegyűlt (pl. stream közbeni hiba / cancel, mielőtt a reply kész).
      await this.closeTurnRecord(turn, {
        ...outcome,
        partialText: turn.completedReply ?? snapshot.partialText,
        turnCount: loopTurnCount,
        toolCallCount: loopToolCallCount,
        deniedCount: loopDeniedCount,
      })
    }

    return { outcome, reply, messageId, ticketRefId }
  }

  private async findAgentReplyAfterTurn(turn: StreamTurnContext): Promise<string | null> {
    const { messages } = await this.conversations.getConversation(turn.conversationId)
    const existing = messages.find(
      (message) => message.role === 'agent' && message.createdAt > turn.userMessageCreatedAt,
    )
    return existing?.id ?? null
  }

  /**
   * Hibára futott forduló lezáró üzenete a beszélgetésbe. E nélkül a felhasználó
   * újratöltés után csak a saját üzenetét látja — mintha az agent némán megállt
   * volna (l. `buildFailedTurnMessage`). Fail-soft: az üzenet hiánya
   * megfigyelhetőségi veszteség, nem állapot-hiba, a forduló attól még lezárul.
   */
  private async persistFailedTurn(
    turn: StreamTurnContext,
    error: string,
    streamedPartialText = '',
  ): Promise<void> {
    // Elvesztett tulajdonjognál a lezáró üzenet a tényleges tulajdonosé
    // (watchdog / új futtató) — a régi futó nem ír a beszélgetésbe.
    if (turn.finalized || turn.ownershipLost) return
    try {
      if (await this.findAgentReplyAfterTurn(turn)) return
      const toolCalls = await this.toolCaps.listToolCallsForConversation(turn.conversationId)
      const content = buildFailedTurnMessage({
        error,
        // A tool-loop a teljes reply-t előre megadja, a streaming gateway viszont
        // csak chunkonként építi fel. Stream közbeni hibánál ezért a snapshot az
        // egyetlen forrás, ami a már megjelent részválaszt hiánytalanul őrzi.
        completedReply:
          turn.completedReply ?? guardTurnPartialText(streamedPartialText),
        activities: turn.activities,
        turnToolCalls: toolCalls.filter((call) => call.createdAt > turn.userMessageCreatedAt),
      })
      await this.conversations.appendMessage({
        conversationId: turn.conversationId,
        role: 'agent',
        content,
        actingUserId: turn.createdById,
        agentVersion: turn.agentVersion,
        model: turn.model,
        actorType: 'agent',
        actorId: turn.agentId,
      })
      turn.finalized = true
    } catch (e) {
      console.error('[agent-chat] hiba-lezáró üzenet írása sikertelen', turn.conversationId, e)
    }
  }

  private async persistCancelledTurn(turn: StreamTurnContext): Promise<string | null> {
    if (await this.findAgentReplyAfterTurn(turn)) return null

    const toolCalls = await this.toolCaps.listToolCallsForConversation(turn.conversationId)
    const turnToolCalls = toolCalls.filter(
      (call) => call.createdAt > turn.userMessageCreatedAt,
    )
    const content = buildCancelledTurnMessage({
      completedReply: turn.completedReply,
      activities: turn.activities,
      turnToolCalls,
    })

    const agentMessage = await this.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content,
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      model: turn.model,
      actorType: 'agent',
      actorId: turn.agentId,
    })
    return agentMessage.id
  }

  /**
   * A forduló válaszának perzisztálása. MINDIG azonosítót ad: vagy a már meglévő
   * agent-üzenetét, vagy a most beszúrtét. Szándékosan nem `string | null` — egy
   * `null` ág a hívóknál csendes `return`-t jelentene, ami a forduló-rekordot a
   * kezdeti `failed` állapotban hagyná, holott a válasz létezik. Ha a beszúrás
   * nem megy, az dobjon: azt a hívó `catch`-e kezeli valódi hibaként.
   */
  private async finalizeAgentTurn(
    turn: StreamTurnContext,
    content: string,
    extras?: { ticketRefId?: string | null },
  ): Promise<string> {
    const existingId = await this.findAgentReplyAfterTurn(turn)
    if (existingId) return existingId

    const agentMessage = await this.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content: content.trim(),
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      model: turn.model,
      actorType: 'agent',
      actorId: turn.agentId,
      ticketRefId: extras?.ticketRefId ?? null,
    })
    return agentMessage.id
  }

  /**
   * A megszakítás-kérést a hívó checkpoint dönti el (`isCancelRequestedNow`),
   * ez a metódus csak a részeredmény megőrzését végzi: az addig összegyűlt szöveg
   * bekerül a beszélgetésbe, és a forduló megszakított végállapotra zárul (E3).
   */
  private async cancelTurnIfRequested(
    turn: StreamTurnContext,
    cancelRequested: boolean,
  ): Promise<string | null> {
    if (turn.ownershipLost) throw new TurnOwnershipLostError()
    if (turn.finalized || !cancelRequested) return null
    const messageId = await this.persistCancelledTurn(turn)
    if (messageId) turn.finalized = true
    return messageId
  }

  /**
   * A streamelő küldés — innentől **nézet a futás fölött**, nem a futás hajtóereje
   * (spec §5.1/6, D3/D5). Előkészít, elindítja a leválasztott futást, majd
   * feliratkozik az eseményeire. Ha a fogyasztó eldobja ezt a generátort
   * (ablakbezárás, hard-refresh, abort), az CSAK a feliratkozást szünteti meg:
   * a forduló fut tovább, és a válasz a lezáráskor bekerül a beszélgetésbe.
   */
  async *sendMessageStream(
    params: AgentChatSendParams,
  ): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
    let begun: BeginTurnResult
    try {
      begun = await this.beginTurn(params)
    } catch (error) {
      // #516 — DB-hiba a tartós fogadás előtt: se `turn`, se `meta` — a kliens
      // nem tarthatja elfogadottnak a küldést.
      console.error('[agent-chat] a forduló tartós fogadása sikertelen', error)
      begun = {
        kind: 'error',
        error: error instanceof Error ? error : new Error('Turn reservation failed'),
      }
    }
    // Az ütközés az ELSŐ esemény, még a `turn` előtt — a kérés-út ebből dönti el,
    // hogy SSE helyett `409`-et ad (D7/E5).
    if (begun.kind === 'conflict') {
      yield {
        type: 'conflict',
        conversationId: begun.conversationId,
        activeTurnId: begun.activeTurnId,
      }
      return
    }
    if (begun.kind === 'error') {
      // Persist-ACK: ha a felhasználói üzenet már a DB-ben van, a kliens ne dobja el.
      if (begun.meta) {
        yield { type: 'meta', ...begun.meta }
      }
      yield { type: 'error', message: begun.error.message }
      return
    }

    // A forduló azonosítója a legelső esemény (§6.1): a Stop és a
    // visszacsatlakozás ehhez kötődik.
    yield { type: 'turn', turnId: begun.turnId }
    // Persist-ACK: a kliens csak ettől a ponttól tarthatja meg hiba esetén az
    // optimista user-buborékot. Az id-val rögtön a perzisztált rekordra vált.
    yield { type: 'meta', conversationId: begun.conversationId, userMessageId: begun.userMessageId }

    // A stream vége NEM a munka vége (#516 / #508 §7): ha a futás nem ebben a
    // processben megy, itt lezárul a stream, és a kliens a tartós snapshotból
    // (`GET turns`, reconnect) követi tovább.
    if (begun.subscribe) yield* begun.subscribe()
  }

  async createTaskTicket(params: {
    agentId: string
    content: string
    createdById: string
    tenantId?: string | null
    conversationId?: string | null
    projectKey?: string
    attachmentDocumentIds?: string[]
    executeAfter?: Date | null
    authorizeRunAs?: boolean
    briefing?: TaskBriefing | null
  }) {
    const text = params.content.trim()
    const attachmentIds = params.attachmentDocumentIds ?? []
    if (!text && attachmentIds.length === 0) throw new Error('Task description is required')

    const agentDetails = await this.agents.findByIdForRuntime(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForChat(agentDetails.agent.tenantId, params.tenantId ?? null)
    // #142 — a feladat-ticket felvétele ugyanaz az `address` ige, mint a chat; csak a
    // CSATORNA más. Enélkül a chat-kaput meg lehetne kerülni egy feladat felvételével.
    if (!this.agentAccess || !params.tenantId) throw new Error('Agent not found')
    await this.agentAccess.assertCanAccessAgent({
      subject: { kind: 'user', userId: params.createdById, tenantId: params.tenantId },
      targetAgentId: params.agentId,
      verb: 'address',
      audit: {
        channel: 'ticket',
        conversationId: params.conversationId ?? null,
        initiatingUserId: params.createdById,
      },
    })

    const attachmentDocs = await this.loadDocuments(attachmentIds, params.tenantId ?? null)
    const attachmentTransfer = buildPromotedTaskAttachmentTransfer(attachmentDocs)
    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }

    const titleSource = text || attachmentDocs[0]?.filename || 'Feladat'
    const runAsPayload = buildRunAsAuthorization({ userId: params.createdById })
    const briefing =
      params.briefing ??
      assembleTaskBriefingDraft({
        userText: text,
        attachmentNames: attachmentDocs.map((doc) => doc.filename),
        authorizeRunAs: params.authorizeRunAs,
      })

    let conversationId = params.conversationId ?? null
    if (conversationId) {
      const existing = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
      if (existing.conversation.agentId !== params.agentId) {
        throw new Error('Conversation agent mismatch')
      }
      if (
        params.projectKey &&
        params.tenantId &&
        params.projectKey !== existing.conversation.projectKey
      ) {
        await this.conversations.setProjectKey({
          conversationId,
          tenantId: params.tenantId,
          projectKey: params.projectKey,
        })
      }
    } else {
      const created = await this.conversations.createConversation({
        agentId: params.agentId,
        createdById: params.createdById,
        tenantId: params.tenantId ?? null,
        title: titleSource.slice(0, 80),
        projectKey: params.projectKey ?? '__general__',
      })
      conversationId = created.id
    }

    const ticket = await this.tickets.create(
      {
        tenantId: params.tenantId ?? null,
        type: 'interaction',
        title: `Feladat: ${titleSource.slice(0, 80)}`,
        state: 'ready',
        assigneeType: 'agent',
        assigneeId: params.agentId,
        agentId: params.agentId,
        playbookRef: null,
        conversationId,
        projectKey: params.projectKey ?? '__general__',
        payload: {
          question: text,
          source: 'agent_chat',
          attachmentDocumentIds: attachmentTransfer.attachments.map((attachment) => attachment.documentId),
          agentVersion: agentDetails.agent.currentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
          scheduledRun: params.executeAfter ? true : undefined,
          briefing: briefingToPayloadValue(briefing),
          ...runAsPayload,
        },
        sourceDocumentId: attachmentTransfer.sourceDocumentId,
        executeAfter: params.executeAfter ?? null,
        dueBy: null,
        createdById: params.createdById,
      },
      { attachments: attachmentTransfer.attachments },
    )

    try {
      await this.conversations.postTaskCard({
        conversationId,
        tenantId: params.tenantId ?? null,
        createdById: params.createdById,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        model: modelConfig.model,
        userText: encodeStoredMessage(text || '(csatolmányok)', attachmentIds),
        ticketId: ticket.id,
      })
    } catch (error) {
      console.error('[agent-chat] feladat-kártya üzenet írása sikertelen', error)
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: agentDetails.agent.currentVersion,
      action: 'task.briefing_confirmed',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: conversationId,
      outputRef: ticket.id,
      policyDecision: 'allowed',
      tenantId: params.tenantId ?? null,
      conversationId,
      ticketId: ticket.id,
      metadata: { briefing, source: 'agent_chat' },
    })

    await this.triggerImmediateDispatch(ticket)

    return ticket
  }

  /** Best-effort azonnali indítás — bukása nem hiúsíthatja meg a ticket felvételét. */
  private async triggerImmediateDispatch(ticket: {
    id: string
    executeAfter?: Date | null
  }): Promise<void> {
    if (!this.dispatchTicket) return
    if (ticket.executeAfter && ticket.executeAfter.getTime() > Date.now()) return
    try {
      await this.dispatchTicket(ticket.id)
    } catch (error) {
      console.error('[agent-chat] azonnali feldolgozás indítása sikertelen', error)
    }
  }

  private async tryStartChatTriggeredProcess(params: {
    tenantId: string | null
    processDefinitionId?: string
    message: string
    explicitPayload?: Record<string, unknown>
    conversationId: string
    startedByUserId: string
    agentId: string
    agentVersion: number
    modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
    attachmentDocs: PreparedTurn['attachmentDocs']
    taskBriefing?: TaskBriefing | null
  }): Promise<ChatProcessReply | null> {
    if (!params.processDefinitionId) return null
    if (!this.processDefinitions || !this.playbooksV2 || !this.processService) {
      return { text: 'A chat-trigger indítás nincs bekötve ezen a környezeten.' }
    }

    // Folyamat/playbook scope: tenantOf(user) = user.tenantId ?? user.id (process actions).
    // A beszélgetés tenantId-ja ettől függetlenül maradhat null — ne keverjük össze.
    const processTenantId = params.tenantId ?? params.startedByUserId

    const def = await this.processDefinitions.findById(processTenantId, params.processDefinitionId)
    if (!def) return { text: 'A kiválasztott Folyamat nem található vagy nincs jogosultság.' }

    const chatTrigger = def.triggers.find((trigger) => trigger.type === 'chat' && trigger.enabled)
    if (!chatTrigger) {
      return { text: 'Ehhez a Folyamathoz nincs aktív chat trigger csatolva.' }
    }

    const version = await this.playbooksV2.findVersion(processTenantId, def.playbookVersionId)
    const compiled = version?.compiledSpec as CompiledSpec | null | undefined
    if (!compiled || typeof compiled !== 'object') {
      return { text: 'A Folyamat PIN-elt Playbook-verziójának nincs futtatható compiled spec-je.' }
    }

    let inputPayload = resolveChatTriggerInputPayload(
      chatTrigger.inputMap,
      params.message,
      params.explicitPayload,
    )
    const triggerSlots = chatTriggerSlotDescriptors(compiled, compiled.entryStepId)
    inputPayload = applyChatTriggerAttachments(
      inputPayload,
      triggerSlots.map((slot) => slot.name),
      params.attachmentDocs,
    )
    let missing = missingRequiredTriggerSlots(compiled, inputPayload, compiled.entryStepId)

    // §4.4 „az LLM megkapja a kitöltendő mezőket, kinyeri őket az üzenetből":
    // a determinisztikus (JSON / kulcs:érték) feloldás fölé épülő LLM-fallback,
    // ha szabad szöveges üzenetből kellene még hiányzó réseket kinyerni.
    if (missing.length > 0) {
      const extracted = await this.extractChatTriggerSlotsWithLlm({
        message: params.message,
        compiled,
        missing,
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        conversationId: params.conversationId,
        startedByUserId: params.startedByUserId,
        modelConfig: params.modelConfig,
        attachments: params.attachmentDocs,
      })
      if (extracted) {
        inputPayload = { ...inputPayload, ...extracted }
        missing = missingRequiredTriggerSlots(compiled, inputPayload, compiled.entryStepId)
      }
    }

    if (missing.length > 0) {
      return {
        text: `A Folyamat indításához még hiányzik: ${missing.join(', ')}. Add meg ezeket név: érték formában, vagy a chat indító payloadban.`,
      }
    }

    const run = await this.processService.startProcess({
      tenantId: processTenantId,
      processDefinitionId: def.id,
      triggerType: 'chat',
      inputPayload,
      conversationId: params.conversationId,
      startedBy: { type: 'user', id: params.startedByUserId },
      attachments: buildPromotedTaskAttachmentTransfer(params.attachmentDocs).attachments,
    })

    const briefing =
      params.taskBriefing ??
      assembleTaskBriefingDraft({
        userText: params.message,
        attachmentNames: params.attachmentDocs.map((doc) => doc.filename),
        processName: def.name,
      })
    if (run.rootTicketId) {
      const root = await this.tickets.findById(run.rootTicketId)
      if (root) {
        const payload =
          root.payload && typeof root.payload === 'object' && !Array.isArray(root.payload)
            ? (root.payload as Record<string, unknown>)
            : {}
        await this.tickets.update(run.rootTicketId, {
          payload: { ...payload, briefing: briefingToPayloadValue(briefing) } as Prisma.JsonValue,
        })
        await this.audit.append({
          actorType: 'human',
          actorId: params.startedByUserId,
          agentVersion: params.agentVersion,
          action: 'task.briefing_confirmed',
          targetType: 'ticket',
          targetId: run.rootTicketId,
          modelUsed: null,
          inputRef: params.conversationId,
          outputRef: run.rootTicketId,
          policyDecision: 'allowed',
          tenantId: processTenantId,
          conversationId: params.conversationId,
          ticketId: run.rootTicketId,
          metadata: { briefing, source: 'chat_process', processId: run.id },
        })
      }
    }

    const processLink = `/control-plane/processes/${run.id}`
    return {
      text: `Futás elindítva a(z) [${def.name}](${processLink}) Folyamatból. Futás azonosító: ${run.id}. Állapot: ${run.status}.`,
      ticketRefId: run.rootTicketId,
    }
  }

  /**
   * §4.4 LLM slot-filling fallback: csak a hiányzó, kötelező résekre kérdez rá
   * egy szűk, szigorúan-JSON kimenetet kérő promptban. Best-effort — hiba vagy
   * érvénytelen JSON esetén `null`-t ad vissza, és a hívó a szokásos hiányzó-rés
   * üzenettel kér vissza a felhasználótól.
   */
  private async extractChatTriggerSlotsWithLlm(params: {
    message: string
    compiled: CompiledSpec
    missing: string[]
    agentId: string
    agentVersion: number
    conversationId: string
    startedByUserId: string
    modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
    attachments: PreparedTurn['attachmentDocs']
  }): Promise<Record<string, unknown> | null> {
    const descriptors = chatTriggerSlotDescriptors(params.compiled).filter((slot) =>
      params.missing.includes(slot.name),
    )
    if (descriptors.length === 0) return null

    const slotList = descriptors
      .map((slot) => `- ${slot.name} (${slot.type}${slot.required ? ', kötelező' : ''})${slot.description ? `: ${slot.description}` : ''}`)
      .join('\n')

    const system =
      'Egy folyamatindító mezőkitöltő vagy. A felhasználó üzenetéből és a csatolt fájlokból told ki a felsorolt mezőket. ' +
      'KIZÁRÓLAG egy JSON objektumot adj vissza (semmi mást, se magyarázatot, se kódblokkot), ' +
      'aminek a kulcsai a felsorolt mezőnevek. Fájl-szerű mezőhöz (pdf_path, path, file) a workspace-tükrözött fájlnév kell (PDF/Office esetén „fájl.pdf.txt”); documentId-hez a UUID. ' +
      'Ha egy mezőt nem tudsz kinyerni, hagyd ki a kulcsot.'
    const attachmentLines =
      params.attachments.length > 0
        ? `\n\nCsatolt fájlok:\n${params.attachments
            .map((doc) => `- ${doc.filename} (documentId=${doc.id})`)
            .join('\n')}`
        : ''
    const user = `Mezők:\n${slotList}\n\nFelhasználói üzenet:\n${params.message || '(üres)'}${attachmentLines}`

    try {
      const result = await this.gateway.call({
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        conversationId: params.conversationId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        modelConfig: params.modelConfig,
      })
      const jsonMatch = result.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  async getConversationMessages(
    conversationId: string,
    tenantId?: string | null,
    agentId?: string,
    requesterUserId?: string | null,
  ): Promise<{
    conversation: Awaited<ReturnType<ConversationService['getConversation']>>['conversation']
    messages: ChatMessageView[]
  }> {
    const { conversation, messages } = await this.conversations.getConversation(
      conversationId,
      tenantId,
    )
    if (agentId && conversation.agentId !== agentId) {
      throw new Error('Conversation agent mismatch')
    }
    const privacyContext = this.resolvePrivacyObservability
      ? await this.resolvePrivacyObservability(tenantId ?? null, conversation.agentId)
      : null
    const knownValues =
      privacyContext && this.surrogateEngine && tenantId
        ? await this.surrogateEngine.loadKnownValueReplacements(
            tenantId,
            { type: 'conversation', id: conversationId },
            { includeObservePreviews: true },
          )
        : []

    const parsedById = new Map<string, { text: string; attachmentIds: string[] }>()
    const attachmentIds: string[] = []
    for (const message of messages) {
      const parsed =
        message.content && !message.contentDeletedAt
          ? parseStoredMessage(message.content)
          : { text: '', attachmentIds: [] }
      parsedById.set(message.id, parsed)
      attachmentIds.push(...parsed.attachmentIds)
    }
    const uniqueAttachmentIds = [...new Set(attachmentIds)]
    const docs =
      uniqueAttachmentIds.length > 0 ? await this.documents.findByIds(uniqueAttachmentIds) : []
    const docsById = new Map(docs.map((doc) => [doc.id, doc]))
    const matrix =
      this.surrogateEngine && tenantId ? await this.loadEgressMatrix(tenantId) : undefined

    const texts = await Promise.all(
      messages.map((message) => {
        const parsed = parsedById.get(message.id) ?? { text: '', attachmentIds: [] }
        if (!message.content || message.contentDeletedAt) return Promise.resolve('')
        return this.resolveWebUiText(
          parsed.text,
          conversationId,
          tenantId,
          requesterUserId,
          matrix,
        )
      }),
    )

    const views: ChatMessageView[] = messages.map((message, index) => {
      const parsed = parsedById.get(message.id) ?? { text: '', attachmentIds: [] }
      const attachments: ChatAttachmentView[] = []
      for (const documentId of parsed.attachmentIds) {
        const doc = docsById.get(documentId)
        if (!doc) continue
        attachments.push(chatAttachmentViewFromDocument(doc))
      }
      const text = texts[index] ?? ''
      const privacyMarkers =
        privacyContext && text
          ? buildEntityMarkers({
              text,
              mode: privacyContext.mode,
              policy: privacyContext.policy,
              knownValues,
            })
          : []
      return {
        id: message.id,
        role: message.role as ChatMessageView['role'],
        text,
        attachments,
        createdAt: message.createdAt,
        privacyMarkers,
        contentDeletedAt: message.contentDeletedAt,
        ticketRefId: message.ticketRefId,
      }
    })

    return { conversation, messages: views }
  }

  /** APG-22 — élő chat UI: policy + beszélgetés-scoped known-value szótár. */
  async getPrivacyMarkerContext(input: {
    conversationId?: string | null
    tenantId?: string | null
    agentId: string
  }): Promise<ChatPrivacyMarkerContext | null> {
    const privacyContext = this.resolvePrivacyObservability
      ? await this.resolvePrivacyObservability(input.tenantId ?? null, input.agentId)
      : null
    if (!privacyContext) return null

    const knownValues =
      this.surrogateEngine && input.tenantId && input.conversationId
        ? await this.surrogateEngine.loadKnownValueReplacements(
            input.tenantId,
            {
              type: 'conversation',
              id: input.conversationId,
            },
            { includeObservePreviews: true },
          )
        : []

    return {
      mode: privacyContext.mode,
      policy: privacyContext.policy,
      knownValues,
    }
  }

  private async loadEgressMatrix(tenantId: string | null): Promise<ResolvedPrivacyEgressMatrix> {
    if (this.resolvePrivacyEgressMatrix) {
      return this.resolvePrivacyEgressMatrix(tenantId)
    }
    return resolvePrivacyEgressMatrix()
  }

  private async resolveWebUiText(
    text: string,
    conversationId: string,
    tenantId?: string | null,
    requesterUserId?: string | null,
    matrix?: ResolvedPrivacyEgressMatrix,
  ): Promise<string> {
    if (!this.surrogateEngine || !tenantId || !text) return text
    const resolvedMatrix = matrix ?? (await this.loadEgressMatrix(tenantId))
    return resolveEgressTextForSurface({
      text,
      surface: 'web_ui',
      engine: this.surrogateEngine,
      tenantId,
      scope: { type: 'conversation', id: conversationId },
      requesterUserId,
      matrix: resolvedMatrix,
    })
  }

  async listSessions(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
  }): Promise<ChatSessionView[]> {
    const rows = await this.conversations.listForAgentUser({
      agentId: params.agentId,
      createdById: params.createdById,
      tenantId: params.tenantId ?? null,
    })

    return rows.map((row) => ({
      id: row.id,
      title: row.title?.trim() || row.previewText?.slice(0, 60) || 'Beszélgetés',
      preview: row.previewText?.slice(0, 120) ?? null,
      lastMessageAt: row.lastMessageAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }))
  }

  private async loadDocuments(ids: string[], tenantId: string | null) {
    if (ids.length === 0) return []
    const docs = await this.documents.findByIds(ids)
    // Tenant-határ: idegen dokumentum UUID-ját ne lehessen chat/task csatolmányként
    // bekötni (workspace-tükrözés + későbbi document_read / ticket-promóció).
    await assertDocumentsReachableFromTenant(docs, ids, tenantId)
    return docs
  }

  /**
   * Dokumentumokat (chat-csatolmány vagy az agent tudásbázisa) a beszélgetés
   * munkaterületére ír, hogy az agent fájl-eszközei (file_read, xlsx_read_sheet,
   * ...) elérjék őket. A `documents.extractedText` tárolja a tartalmat: kép →
   * base64 dekódolva az eredeti bájtok; bináris office/pdf → a kinyert szöveg
   * `<név>.txt`-ként (az eredeti bináris nincs eltárolva); szöveges formátum
   * (json/csv/txt/md) → a tartalom az eredeti néven.
   *
   * A `skipExisting` halmazban szereplő (vagy oda ezalatt felvett) célútakat
   * kihagyja, így a korábbi körök fájljait és a chat-csatolmányokat nem írja
   * felül a tudásbázisból, és körönként nem másol feleslegesen újra.
   */
  private async materializeDocumentsToWorkspace(
    tenantId: string,
    conversationId: string,
    docs: Array<{ filename: string; extractedText: string | null }>,
    skipExisting: Set<string>,
    audience: 'user' | 'internal',
  ): Promise<void> {
    const MAX_BYTES = 5 * 1024 * 1024
    for (const doc of docs) {
      const text = doc.extractedText
      if (!text) continue

      let targetPath = doc.filename
      let bytes: Buffer

      const imageMatch = text.match(IMAGE_MARKER)
      if (imageMatch?.[2] && imageMatch[3]) {
        bytes = Buffer.from(imageMatch[3], 'base64')
      } else {
        if (/\.(xlsx|xlsm|docx|pdf)$/i.test(doc.filename)) {
          // Az eltárolt szöveg a kinyert tartalom, nem az eredeti bináris —
          // .txt-ként tesszük elérhetővé, hogy az olvasás ne sérült fájlt kapjon.
          targetPath = chatAttachmentWorkspacePath(doc.filename)
        }
        bytes = Buffer.from(text, 'utf8')
      }

      if (skipExisting.has(targetPath) || bytes.length > MAX_BYTES) continue

      try {
        await this.workspaceStorage.write(tenantId, conversationId, targetPath, bytes)
        await this.workspaceStorage.setFileAudience(tenantId, conversationId, targetPath, audience)
        skipExisting.add(targetPath)
      } catch {
        // Egy fájl kiírási hibája ne akassza meg a beszélgetést.
      }
    }
  }

  /** Az agenthez kötött tudásbázis-connectorok feldolgozott dokumentumai. */
  private async loadAgentKnowledgeDocuments(
    agentId: string,
  ): Promise<Array<{ id: string; filename: string; extractedText: string | null }>> {
    try {
      const links = await this.toolCaps.findConnectorsForAgent(agentId)
      const kbConnectorIds = links
        .filter((link) => link.connector.type === 'knowledge_base')
        .map((link) => link.connector.id)
      const lists = await Promise.all(
        kbConnectorIds.map((id) => this.toolCaps.findDocumentsForConnector(id)),
      )
      return lists.flat()
    } catch {
      return []
    }
  }

  private async listWorkspaceFiles(tenantId: string, conversationId: string): Promise<string[]> {
    try {
      return await this.workspaceStorage.list(tenantId, conversationId)
    } catch {
      return []
    }
  }

  private async listUserFacingWorkspaceFiles(
    tenantId: string,
    conversationId: string,
  ): Promise<string[]> {
    try {
      return await this.workspaceStorage.listUserFacing(tenantId, conversationId)
    } catch {
      return []
    }
  }

  private async publishReferencedWorkspaceFiles(
    tenantId: string,
    conversationId: string,
    answer: string,
  ): Promise<void> {
    try {
      const workspaceFiles = await this.listWorkspaceFiles(tenantId, conversationId)
      await Promise.all(
        referencedWorkspaceFiles(answer, workspaceFiles)
          .filter((path) => !isInternalWorkspaceFile(path))
          .map((path) => this.workspaceStorage.setFileAudience(tenantId, conversationId, path, 'user')),
      )
    } catch {
      // A fájl publikálási metaadata nem szakíthatja meg a már kész választ.
    }
  }

  private contextDocumentAliases(
    attachmentDocs: Array<{ id: string; filename: string }>,
    workspaceFiles: string[],
    hits: KbHit[],
  ): string[] {
    return [
      ...attachmentDocs.map((doc) => doc.filename || doc.id),
      ...workspaceFiles,
      ...hits.map((hit) => hit.sourceRef || hit.docId),
    ]
  }

  private async fetchKbSearchContext(params: {
    agentId: string
    agentVersion: number
    conversationId: string
    actingUserId: string
    query: string
  }): Promise<{ enabled: boolean; hits: KbHit[] }> {
    const capability = await this.toolCaps.findCapability(params.agentId, 'kb_search')
    if (!capability?.allowed || !params.query.trim()) {
      return { enabled: false, hits: [] }
    }

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      conversationId: params.conversationId,
      actingUserId: params.actingUserId,
      tool: 'kb_search',
      args: { query: params.query.trim(), k: 6 },
    })

    if (search.denied || !('hits' in search.result) || !Array.isArray(search.result.hits)) {
      return { enabled: true, hits: [] }
    }

    return { enabled: true, hits: search.result.hits as KbHit[] }
  }

  /** agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only memória-blokk chatben. */
  private async retrieveProjectMemoryContext(params: {
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdForRuntime']>>>
    projectKey: string
    query: string
    tenantId: string | null
    conversationId: string
  }) {
    const brief = await resolveWorkProjectBrief(this.workProjects, params.tenantId, params.projectKey)
    return loadProjectMemoryContext({
      memoryRetrieval: this.memoryRetrieval,
      audit: this.audit,
      actorId: params.agentDetails.agent.id,
      agentVersion: params.agentDetails.agent.currentVersion,
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      brief,
      request: buildMemoryRetrievalRequest({
        agentId: params.agentDetails.agent.id,
        memoryId: params.agentDetails.agent.memoryId,
        tenantId: params.tenantId,
        projectKey: params.projectKey,
        query: params.query,
        queryKind: 'chat',
        runRef: { threadId: params.conversationId },
      }),
    })
  }

  private async buildContinuationPrompt(
    conversationId: string,
    workspaceFiles: string[],
  ): Promise<string | null> {
    if (!this.agentTurns) return null
    try {
      const previous = await this.agentTurns.findLatestTerminalByConversation(conversationId)
      if (!previous) return null
      const activities = Array.isArray(previous.activities)
        ? (previous.activities as ContinuationActivity[])
        : []
      const snapshot = {
        status: previous.status,
        reason: previous.reason,
        activities,
      }
      if (!shouldInjectTurnContinuation(snapshot)) return null
      const prompt = buildTurnContinuationPrompt(snapshot, workspaceFiles)
      return prompt.trim() ? prompt : null
    } catch (error) {
      console.error('[agent-chat] continuation prompt összeállítás sikertelen', error)
      return null
    }
  }

  /**
   * Ticket → Megbeszélés (#219): a forrás ticket szálát prior/system kontextusként
   * adjuk a modellnek — NEM másoljuk Message buborékként a chatbe, és a ticket
   * állapota / TicketComment szála nem változik ebből a flow-ból.
   */
  private async buildTicketDiscussionPrompt(
    continuedFromTicketId: string | null | undefined,
  ): Promise<string | null> {
    if (!continuedFromTicketId) return null
    try {
      const ticket = await this.tickets.findById(continuedFromTicketId)
      if (!ticket) return null
      const payload = isRecord(ticket.payload) ? ticket.payload : {}
      const originalTask = readTicketPromptText(payload) || ticket.title
      const comments = await this.tickets.listComments(ticket.id)
      const prompt = buildThreadContextPrompt({
        comments,
        originalTask,
        mode: 'discussion',
      })
      return prompt.trim() ? prompt : null
    } catch (error) {
      console.error('[agent-chat] ticket-megbeszélés kontextus összeállítás sikertelen', error)
      return null
    }
  }

  /**
   * Időközben megérkezett delegált válaszok beemelése a következő fordulóba (C1).
   *
   * Enélkül a felhasználó kérdésére csend a válasz: a delegált agent válasza egy
   * lezárt ticketben landol, és semmi nem viszi vissza a beszélgetésbe. Ez akkor
   * fordul elő, ha a szinkron várás határidőre futott (`deadline_exceeded`),
   * vagy ha a ticketet a diszpécser futtatta le.
   *
   * A megjelenített válaszokat MEGJELÖLJÜK, hogy a következő fordulóban ne
   * jelenjenek meg újra. Fail-soft: hiba esetén a forduló normálisan fut tovább.
   */
  private async buildReturnedDelegationPrompt(conversationId: string): Promise<string | null> {
    try {
      const tickets = await this.tickets.listReturnedDelegationsForConversation(conversationId)
      if (tickets.length === 0) return null

      const entries: ReturnedDelegation[] = []
      const surfacedTicketIds: string[] = []
      for (const ticket of tickets) {
        const payload =
          typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
            ? (ticket.payload as Record<string, unknown>)
            : {}
        const answer = typeof payload.answer === 'string' ? payload.answer : ''
        if (!answer.trim()) continue
        const answeredById =
          typeof payload.answeredByAgentId === 'string' ? payload.answeredByAgentId : null
        const answeredByName = answeredById
          ? (await this.agents.findById(answeredById).catch(() => null))?.name ?? null
          : null
        entries.push({
          answeredBy: answeredByName ?? answeredById ?? 'másik agent',
          question: typeof payload.question === 'string' ? payload.question : ticket.title,
          answer,
          confidence: typeof payload.confidence === 'string' ? payload.confidence : null,
        })
        surfacedTicketIds.push(ticket.id)
      }

      const prompt = buildReturnedDelegationPrompt(entries)
      if (!prompt.trim()) return null

      // Csak a ténylegesen megjelenített válaszokat jelöljük — ami kimaradt
      // (üres válasz), az maradjon nyitva egy későbbi fordulóra.
      for (const ticketId of surfacedTicketIds) {
        await this.tickets.markDelegationSurfaced(ticketId).catch(() => {})
      }
      return prompt
    } catch (error) {
      console.error('[agent-chat] megérkezett delegációk beemelése sikertelen', error)
      return null
    }
  }

  private async buildGatewayMessages(
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdForRuntime']>>>,
    historyMessages: ContextAssemblyMessage[],
    latestAttachmentBlock: string,
    kbSearch: { enabled: boolean; hits: KbHit[] },
    workspaceFiles: string[],
    toolCalls: ToolCall[] = [],
    latestUserTextOverride?: string,
    memoryContextBlock?: string | null,
    continuationPrompt?: string | null,
    returnedDelegationPrompt?: string | null,
    ticketDiscussionPrompt?: string | null,
  ) {
    // #142: a roster a hívó agent SAJÁT `address` jogán szűrt lista. A korábbi
    // szűretlen `findMany()` más tenant agentjeinek nevét, persona-traitjét és ID-ját
    // is beírta a system promptba — ez tenantközi adatszivárgás volt.
    const orgRoster = formatOrgRoster(
      await resolveAddressableColleagues(this.agentAccess, agentDetails.agent),
    )

    // A Tanítás felületen betanított, jóváhagyott szabályok (`MemoryVersion.content`)
    // közvetlenül a szerep- és viselkedés-prompt után, a STABIL preamble-ben: ez
    // operátor által jóváhagyott utasítás, nem visszakeresett adat.
    const trainedRules = trainedRulesSystemMessages({
      content: agentDetails.memoryContent,
      version: agentDetails.memoryVersion,
    })

    const stablePreamble: PromptSegments['stablePreamble'] = [
      { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
      ...trainedRules.messages,
      { role: 'system', content: orgRoster },
      {
        role: 'system',
        content:
          'Ez egy közvetlen beszélgetés a felhasználóval. Válaszolj természetes, segítőkész hangnemben magyarul. Ha csatolmány érkezett, hivatkozz rá a válaszodban. Email, fájl, ticket vagy más agent feladat kérésénél használd a platform eszközöket — ne állítsd, hogy megcsináltad vagy nincs adat, ha nem hívtál eszközt.',
      },
    ]
    const stablePostamble: PromptSegments['stablePostamble'] = []
    const variableContext: PromptSegments['variableContext'] = []

    // agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only:
    // a legacy `agentDetails.memoryContent` teljes-inject blokk helyett a
    // `MemoryRetrievalService`-ből épített, elhatárolt `Project memory context`
    // blokk (§16 S4: adat, nem utasítás), a capture-policy prompt-tal együtt.
    if (memoryContextBlock) {
      const [capturePolicy, memoryData] = memoryContextSystemMessages(memoryContextBlock)
      if (capturePolicy) stablePostamble.push(capturePolicy)
      stablePostamble.push({ role: 'system', content: MEMORY_RETRIEVAL_USAGE_PROMPT })
      if (memoryData) variableContext.push(memoryData)
    }

    if (kbSearch.enabled) {
      const answerInstruction = kbSearchAnswerInstruction({
        hitCount: kbSearch.hits.length,
        hasMemoryContext: Boolean(memoryContextBlock),
        mode: 'chat',
      })
      stablePostamble.push({ role: 'system', content: answerInstruction })
      variableContext.push({
        role: 'system',
        content: `Tudásbázis találatok (kb_search):\n${formatHitsForPrompt(kbSearch.hits)}`,
      })
    }

    // A munkaterületen ténylegesen elérhető fájlok pontos listája. Ez a forrás
    // igazsága — a fájlnevekre ezekkel a pontos utakkal hivatkozz, NE találgass
    // tudásbázisból vett elérési utat.
    if (workspaceFiles.length > 0) {
      variableContext.push({
        role: 'system',
        content:
          `A beszélgetés munkaterületén jelenleg elérhető fájlok (pontos elérési utak):\n` +
          workspaceFiles.map((p) => `- ${p}`).join('\n') +
          `\n\nEzeket a file_read / xlsx_read_sheet / file_search stb. eszközökkel éred el a fenti pontos néven. ` +
          `Csatolmány PDF/DOCX tartalmához (documentId a csatolmány-blokkban) a document_read eszközt használd oldalra vagy keresésre — ne a teljes .txt-t file_read-del. ` +
          `Ha a kért adat egy itt felsorolt fájlban van, onnan dolgozz. Új fájlt (pl. Excel → xlsx_create, prezentáció → pptx_create, Word → docx_create, egyéb → file_write) az eszközökkel hozz létre. A kész, felhasználónak szánt fájlra a válaszodban mindig csak a pontos, backtickbe tett fájlnévvel hivatkozz (pl. \`riport.html\`) — ebből kattintható link lesz; a HTML megnyitható, a többi letölthető. Új fájlnál az eszköz által visszaadott \`path\` mezőt szó szerint másold vissza, sose rekonstruáld fejből (a skill-minta helyőrzőjét nem szabad cégnévvel kitölteni).`,
      })
    } else {
      variableContext.push({
        role: 'system',
        content:
          'A beszélgetés munkaterülete jelenleg üres (nincs feltöltött fájl). Ha a felhasználó létező fájlra hivatkozik, kérd meg, hogy csatolja (📎). Csatolt PDF/DOCX esetén a document_read eszközt használd (pages/query). Új fájlt (pl. Excel → xlsx_create, prezentáció → pptx_create, Word → docx_create, egyéb → file_write) az eszközökkel hozhatsz létre. A kész, felhasználónak szánt fájlt a válaszodban pontos, backtickbe tett fájlnévvel említsd, hogy kattintható legyen. Új fájlnál az eszköz által visszaadott `path` mezőt szó szerint másold vissza, sose rekonstruáld fejből.',
      })
    }

    if (continuationPrompt && continuationPrompt.trim()) {
      variableContext.push({ role: 'system', content: continuationPrompt })
    }

    // A megérkezett delegált válasz a folytatás UTÁN áll: az előbbi azt mondja
    // meg, hol tartunk, ez pedig azt, hogy egy hiányzó darab közben megjött.
    if (returnedDelegationPrompt && returnedDelegationPrompt.trim()) {
      variableContext.push({ role: 'system', content: returnedDelegationPrompt })
    }

    // Ticket → Megbeszélés (#219): a ticket-szál prior kontextus — a chat
    // buboréklistában nem jelenik meg, csak a modell látja.
    if (ticketDiscussionPrompt && ticketDiscussionPrompt.trim()) {
      variableContext.push({
        role: 'system',
        content: `Feladat-megbeszélés előzménye (ticket-szál, tájékoztató):\n${ticketDiscussionPrompt}`,
      })
    }

    return {
      stablePreamble,
      stablePostamble,
      variableContext,
      history: buildHistoryGatewayMessages(historyMessages, toolCalls, latestAttachmentBlock, latestUserTextOverride),
    } satisfies PromptSegments
  }
}

export function imageDataUrlFromExtractedText(extractedText: string | null): string | null {
  if (!extractedText) return null
  const match = extractedText.match(IMAGE_MARKER)
  if (!match?.[2] || !match[3]) return null
  return `data:${match[2]};base64,${match[3]}`
}

export function imageMimeFromFilename(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return null
}
