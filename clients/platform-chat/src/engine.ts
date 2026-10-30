/**
 * Forduló-motor (§5.2). Minden lépés egy külön kérés (Cloud Tasks); az állapot a `turn_steps`-ben.
 * - A kész lépés nem fut újra (`(turnId, seq)` egyedi, a motor a kész lépéseket átugorja).
 * - A félbemaradt LLM-hívás újrafut (olvasó művelet); az író tool idempotencia-kulcsot kap
 *   (`hash(turnId, seq, toolName)`), így a platform nem hajtja végre kétszer.
 * - Jóváhagyásnál (MRTR) a forduló `awaiting_approval`-ra áll és leáll: nincs futó feladat.
 */
import { createHash } from 'node:crypto'
import { BUDGET_BLOCK_REASON, PlatformError, type ChatMessage, type PlatformClient } from './platform.ts'
import {
  ACTIVE_TURN_STATUSES,
  type Attachment,
  type Conversation,
  type LlmStepOutput,
  type Step,
  type Store,
  type ToolStepOutput,
  type Turn,
  type TurnContext,
} from './store.ts'
import type { Config } from './config.ts'
import {
  byName,
  DEFAULT_CORE_TOOLS,
  describeTools,
  findTool,
  hasDeferred,
  initialLoading,
  isLoaded,
  toFunctionName,
  TOOL_DESCRIBE,
  TOOL_DESCRIBE_DEFINITION,
  toolIndex,
} from './tool-loading.ts'

export { toFunctionName }

export const APPROVAL_TTL_MS = 15 * 60_000
const FLUSH_MS = 250
const LEASE_SECONDS = 180
const DEFINITION_MAX_CHARS = 60_000
const EXTRACT_MAX_CHARS = 20_000
/** Agent-szerkesztő eszközök: a beszélgetésben nincs rájuk szükség, csak a modell-kontextust hizlalnák. */
const EXCLUDED_TOOLS = new Set([
  'platform.agent.create_draft',
  'platform.agent.publish',
  'platform.agent.checkout',
  'platform.agent.get_working_set',
])

export type TaskQueue = { enqueue(task: { turnId: string; seq: number }): Promise<void> }

export type EngineDeps = {
  store: Store
  platform: PlatformClient
  queue: TaskQueue
  limits: Config['limits']
  platformOrigin: string
  /** Kép-csatolmány → data URL a modellnek (null = nem küldhető). */
  loadImage?: (attachment: Attachment) => Promise<string | null>
  /** #1022: alapból teljes sémával betöltött eszközök (alapértelmezés: `DEFAULT_CORE_TOOLS`). */
  coreTools?: readonly string[]
  now?: () => Date
}

export const MESSAGES = {
  failed: 'Most nem sikerült válaszolni, mert a céges modell nem érhető el. Próbáld újra.',
  noAccess: 'Ehhez a munkatárshoz most nincs hozzáférésed, vagy kikapcsolták a platform-chatben.',
  tooManySteps: 'A munkatárs túl sok lépésben dolgozott ezen a kérésen, ezért leállt. Fogalmazd meg pontosabban, mit szeretnél.',
  tooLong: 'A válasz túl sokáig tartott, ezért leállt. Próbáld újra kisebb részekre bontva.',
  loop: 'A munkatárs ugyanazt a lépést ismételte, ezért leállt. Próbáld másképp megfogalmazni a kérést.',
  approvalExpired: (link: string) =>
    `Ez a kérés a jóváhagyási listára került, mert 15 percen belül nem született döntés. A jóváhagyási listán bármikor dönthetsz róla: ${link}`,
} as const

const sha = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

const nowOf = (deps: EngineDeps) => (deps.now ?? (() => new Date()))()

function ownsTurn(turn: Turn, userId: string) {
  return turn.userId === userId
}

export function approvalExpired(turn: Turn, now: Date): boolean {
  const created = turn.pendingApproval ? Date.parse(turn.pendingApproval.createdAt) : NaN
  return Number.isFinite(created) && now.getTime() - created > APPROVAL_TTL_MS
}

function approvalsLink(platformOrigin: string) {
  return `${platformOrigin}/control-plane/operations`
}

/** A forduló összes LLM-szövege (ugyanaz, amit a user élőben látott). */
function assistantText(steps: Step[]): string {
  return steps
    .filter((s) => s.kind === 'llm' && s.status === 'done')
    .map((s) => (s.output as LlmStepOutput).content.trim())
    .filter(Boolean)
    .join('\n\n')
}

async function finalize(deps: EngineDeps, turn: Turn, extra?: string) {
  const steps = await deps.store.listSteps(turn.id)
  const content = [assistantText(steps), extra].filter(Boolean).join('\n\n') || '…'
  const message = await deps.store.addMessage({
    conversationId: turn.conversationId,
    turnId: turn.id,
    role: 'assistant',
    content,
    attachments: [],
  })
  const ok = await deps.store.transitionTurn(turn.id, ACTIVE_TURN_STATUSES, 'succeeded', {
    finishedAt: nowOf(deps),
    continuationToken: null,
    pendingApproval: null,
  })
  if (ok) await deps.store.appendEvent(turn.id, 'done', { messageId: message.id, content })
  await deps.store.touchConversation(turn.conversationId)
  await deps.store.pruneOldEvents(7).catch(() => {})
}

async function fail(deps: EngineDeps, turn: Turn, message: string, code: string) {
  const ok = await deps.store.transitionTurn(turn.id, ACTIVE_TURN_STATUSES, 'failed', {
    error: message,
    finishedAt: nowOf(deps),
    continuationToken: null,
  })
  if (ok) await deps.store.appendEvent(turn.id, 'error', { message, code })
  await deps.store.touchConversation(turn.conversationId)
}

/** Lejárt jóváhagyás (§6.3): a művelet a platform jóváhagyási listáján marad, a forduló lezárul. */
export async function closeExpiredApproval(deps: EngineDeps, turn: Turn): Promise<boolean> {
  if (turn.status !== 'awaiting_approval' || !approvalExpired(turn, nowOf(deps))) return false
  await deps.store.appendEvent(turn.id, 'approval', { phase: 'expired', link: approvalsLink(deps.platformOrigin) })
  await finalize(deps, turn, MESSAGES.approvalExpired(approvalsLink(deps.platformOrigin)))
  return true
}

export async function startTurn(
  deps: EngineDeps,
  input: { conversation: Conversation; chatToken: string; content: string; attachments: Attachment[] },
): Promise<{ ok: true; turn: Turn } | { ok: false; code: 'busy' | 'no_access' }> {
  const { conversation } = input
  const active = await deps.store.activeTurn(conversation.id)
  if (active) {
    const closed = await closeExpiredApproval(deps, active)
    if (!closed) return { ok: false, code: 'busy' }
  }
  const turn = await deps.store.createTurn({
    conversationId: conversation.id,
    tenantId: conversation.tenantId,
    userId: conversation.userId,
    agentId: conversation.agentId,
  })
  if (!turn) return { ok: false, code: 'busy' }
  let continuation: string
  try {
    continuation = await deps.platform.continuationToken({
      chatToken: input.chatToken,
      turnId: turn.id,
      agentId: conversation.agentId,
    })
  } catch {
    await fail(deps, turn, MESSAGES.noAccess, 'no_access')
    return { ok: false, code: 'no_access' }
  }
  await deps.store.addMessage({
    conversationId: conversation.id,
    turnId: turn.id,
    role: 'user',
    content: input.content,
    attachments: input.attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
  })
  if (!conversation.titleSetByUser && !conversation.title) {
    const title = input.content.replace(/\s+/g, ' ').trim().slice(0, 60) || input.attachments[0]?.name || 'Új beszélgetés'
    await deps.store.renameConversation(conversation.id, title, false)
  }
  await deps.store.updateTurn(turn.id, { continuationToken: continuation })
  await deps.store.appendEvent(turn.id, 'status', { phase: 'queued' })
  await deps.store.touchConversation(conversation.id)
  await deps.queue.enqueue({ turnId: turn.id, seq: 0 })
  return { ok: true, turn: { ...turn, continuationToken: continuation } }
}

export async function cancelTurn(deps: EngineDeps, turnId: string, userId: string): Promise<boolean> {
  const turn = await deps.store.getTurn(turnId)
  if (!turn || !ownsTurn(turn, userId)) return false
  const ok = await deps.store.transitionTurn(turnId, ACTIVE_TURN_STATUSES, 'cancelled', {
    finishedAt: nowOf(deps),
    continuationToken: null,
    pendingApproval: null,
  })
  if (ok) await deps.store.appendEvent(turnId, 'done', { cancelled: true })
  return ok
}

export async function decideApproval(
  deps: EngineDeps,
  input: { turnId: string; userId: string; decision: 'approve' | 'reject' },
): Promise<'ok' | 'expired' | 'not_found' | 'not_waiting'> {
  const turn = await deps.store.getTurn(input.turnId)
  if (!turn || !ownsTurn(turn, input.userId)) return 'not_found'
  if (turn.status !== 'awaiting_approval' || !turn.pendingApproval) return 'not_waiting'
  if (await closeExpiredApproval(deps, turn)) return 'expired'
  const pending = { ...turn.pendingApproval, decision: input.decision }
  const ok = await deps.store.transitionTurn(turn.id, ['awaiting_approval'], 'running', { pendingApproval: pending })
  if (!ok) return 'not_waiting'
  await deps.store.appendEvent(turn.id, 'approval', { phase: 'decided', decision: input.decision })
  await deps.queue.enqueue({ turnId: turn.id, seq: pending.seq })
  return 'ok'
}

type Plan = { kind: 'llm' } | { kind: 'tool'; call: LlmStepOutput['toolCalls'][number] }

/** A kész lépésekből: mi a következő? (Az utolsó LLM-lépés tool-hívásai sorban, utána újra LLM.) */
export function planNext(done: Step[]): Plan {
  let lastLlm = -1
  for (let i = done.length - 1; i >= 0; i--) {
    if (done[i].kind === 'llm') {
      lastLlm = i
      break
    }
  }
  if (lastLlm < 0) return { kind: 'llm' }
  const calls = (done[lastLlm].output as LlmStepOutput).toolCalls
  const executed = done.length - 1 - lastLlm
  if (executed < calls.length) return { kind: 'tool', call: calls[executed] }
  return { kind: 'llm' }
}

function systemPrompt(conversation: Conversation, context: TurnContext): string {
  const index = toolIndex(context)
  return [
    `Ez egy beszélgetés a(z) ${conversation.tenantSlug} cég Excellence AI platformján, a beépített chatben. ` +
      'Te a lent leírt AI munkatárs vagy; a felhasználó közvetlenül veled beszél.',
    '- Válaszolj a felhasználó nyelvén, közérthetően, zsargon nélkül. Markdown (táblázat, lista, kód) használható.',
    '- A céges eszközök hívásakor add meg a definíció definitionId-ját.',
    '- Írás előtt nem kell külön engedélyt kérned szövegben: a rendszer jóváhagyó kártyát mutat a felhasználónak. ' +
      'Ha a felhasználó elveti, vedd tudomásul, és ne próbáld újra ugyanazt.',
    // Az index a definíció (memória) előtt: az index agent-szinten stabil, a memória változhat (prompt-cache).
    ...(index ? ['', index] : []),
    '',
    '--- A MUNKATÁRS DEFINÍCIÓJA ÉS MEMÓRIÁJA (platform.agent.get_definition) ---',
    context.definition.slice(0, DEFINITION_MAX_CHARS),
  ].join('\n')
}

async function userContent(deps: EngineDeps, message: { content: string; attachments: Array<{ id: string }> }, attachments: Map<string, Attachment>) {
  if (message.attachments.length === 0) return message.content
  const parts: Array<Record<string, unknown>> = []
  let text = message.content
  for (const ref of message.attachments) {
    const att = attachments.get(ref.id)
    if (!att) continue
    if (att.mime.startsWith('image/')) {
      const url = deps.loadImage ? await deps.loadImage(att) : null
      if (url) parts.push({ type: 'image_url', image_url: { url } })
      else text += `\n\n[Csatolt kép: ${att.name} — a munkatárs modellje ezt nem tudja megnézni.]`
      continue
    }
    text += `\n\n[Csatolt fájl: ${att.name} (${att.mime}, ${att.size} bájt)]\n${(att.extractedText ?? '(a tartalom nem olvasható ki)').slice(0, EXTRACT_MAX_CHARS)}`
  }
  return parts.length ? [{ type: 'text', text }, ...parts] : text
}

export async function buildMessages(deps: EngineDeps, conversation: Conversation, context: TurnContext, steps: Step[]): Promise<ChatMessage[]> {
  const history = await deps.store.listMessages(conversation.id, deps.limits.historyMessages)
  const ids = history.flatMap((m) => m.attachments.map((a) => a.id))
  const attachments = new Map((ids.length ? await deps.store.getAttachments(conversation.id, ids) : []).map((a) => [a.id, a]))
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(conversation, context) }]
  for (const m of history) {
    if (m.role === 'user') messages.push({ role: 'user', content: await userContent(deps, m, attachments) })
    else messages.push({ role: 'assistant', content: m.content })
  }
  for (const s of steps) {
    if (s.kind === 'llm') {
      const out = s.output as LlmStepOutput
      messages.push({
        role: 'assistant',
        content: out.content || null,
        ...(out.toolCalls.length
          ? { tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: toFunctionName(c.name), arguments: c.arguments } })) }
          : {}),
      })
    } else {
      const out = s.output as ToolStepOutput
      messages.push({ role: 'tool', tool_call_id: out.callId, content: out.text })
    }
  }
  return messages
}

/** Csak a betöltött eszközök teljes sémája, név szerint rendezve (bájt-azonos `tools[]`), a végén a `tool_describe`. */
export function toolDefinitions(context: TurnContext) {
  const loaded = context.tools
    .filter((t) => isLoaded(context, t.name))
    .sort(byName)
    .map((t) => ({
      type: 'function',
      function: {
        name: toFunctionName(t.name),
        description: (t.description ?? '').slice(0, 1024),
        parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      },
    }))
  return hasDeferred(context) ? [...loaded, TOOL_DESCRIBE_DEFINITION] : loaded
}

async function loadContext(deps: EngineDeps, turn: Turn, conversation: Conversation): Promise<TurnContext> {
  if (turn.context) return turn.context
  const access = { token: turn.continuationToken!, tenantSlug: conversation.tenantSlug, agentId: turn.agentId, sessionId: conversation.id }
  const [definition, tools, previous] = await Promise.all([
    deps.platform.getDefinition(access),
    deps.platform.listTools(access),
    deps.store.lastTurnContext(conversation.id, turn.id),
  ])
  const available = tools.filter((t) => !EXCLUDED_TOOLS.has(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  // Ragadós betöltés: az előző fordulóban betöltött eszközök a beszélgetésben betöltve maradnak.
  const loading = initialLoading(available, { core: deps.coreTools ?? DEFAULT_CORE_TOOLS, definition, sticky: previous?.loaded ?? [] })
  const context: TurnContext = { definition, tools: available, ...loading }
  await deps.store.updateTurn(turn.id, { context })
  return context
}

async function runLlm(deps: EngineDeps, turn: Turn, conversation: Conversation, seq: number, done: Step[]) {
  const context = await loadContext(deps, turn, conversation)
  const messages = await buildMessages(deps, conversation, context, done)
  await deps.store.beginStep({ turnId: turn.id, seq, kind: 'llm', inputHash: sha(seq, messages.length), idempotencyKey: null })
  await deps.store.appendEvent(turn.id, 'status', { phase: 'thinking' })

  const controller = new AbortController()
  let buffer = ''
  let flushes = 0
  let flushing: Promise<void> = Promise.resolve()
  const flush = () => {
    flushing = flushing.then(async () => {
      if (buffer) {
        const text = buffer
        buffer = ''
        await deps.store.appendEvent(turn.id, 'delta', { text })
      }
      // Stop gomb (§5.2/5): a futó stream a következő flushnál megszakad.
      if (++flushes % 4 === 0 && (await deps.store.getTurn(turn.id))?.status === 'cancelled') controller.abort()
    })
    return flushing
  }
  const timer = setInterval(() => void flush(), FLUSH_MS)
  let result
  try {
    result = await deps.platform.streamCompletion({
      token: turn.continuationToken!,
      tenantSlug: conversation.tenantSlug,
      agentId: turn.agentId,
      conversationId: conversation.id,
      turnId: turn.id,
      messages,
      tools: toolDefinitions(context),
      onDelta: (text) => {
        buffer += text
      },
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) return
    throw error
  } finally {
    clearInterval(timer)
    await flush()
  }
  if (controller.signal.aborted) return

  const usage = {
    promptTokens: (turn.tokenUsage.promptTokens ?? 0) + (result.usage?.promptTokens ?? 0),
    completionTokens: (turn.tokenUsage.completionTokens ?? 0) + (result.usage?.completionTokens ?? 0),
    costUsd: (turn.tokenUsage.costUsd ?? 0) + (result.usage?.costUsd ?? 0),
  }
  const byFunction = new Map(context.tools.map((t) => [toFunctionName(t.name), t.name]))
  byFunction.set(TOOL_DESCRIBE, TOOL_DESCRIBE)
  const toolCalls = result.blockReason ? [] : result.toolCalls.map((c) => ({ ...c, name: byFunction.get(c.name) ?? c.name }))
  await deps.store.finishStep(turn.id, seq, 'done', { content: result.content, toolCalls } satisfies LlmStepOutput)
  await deps.store.updateTurn(turn.id, { stepCount: seq + 1, tokenUsage: usage })

  if (result.blockReason === BUDGET_BLOCK_REASON) {
    // D14: elfogyott a napi keret — a forduló közérthető zárószöveggel lezárul, a kész lépések maradnak.
    await fail(deps, turn, result.content, 'budget')
    return
  }
  if (toolCalls.length === 0) {
    await finalize(deps, turn)
    return
  }
  await deps.queue.enqueue({ turnId: turn.id, seq: seq + 1 })
}

function hasIdempotencyParam(context: TurnContext, tool: string): boolean {
  const schema = context.tools.find((t) => t.name === tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined
  return !!schema?.properties && 'idempotencyKey' in schema.properties
}

/** Harness-lépés (#1022): helyben fut, nincs MCP-hívás, nincs idempotencia-kulcs, nincs jóváhagyás. */
async function finishLocalStep(deps: EngineDeps, turn: Turn, seq: number, inputHash: string, output: ToolStepOutput, context: TurnContext) {
  await deps.store.beginStep({ turnId: turn.id, seq, kind: 'tool', inputHash, idempotencyKey: null })
  // Előbb a kontextus: ha a lépés lezárása előtt elhal a worker, az újrafutás ugyanazt az állapotot adja.
  await deps.store.updateTurn(turn.id, { context })
  await deps.store.finishStep(turn.id, seq, 'done', output)
  await deps.store.updateTurn(turn.id, { stepCount: seq + 1 })
  await deps.queue.enqueue({ turnId: turn.id, seq: seq + 1 })
}

async function runTool(deps: EngineDeps, turn: Turn, conversation: Conversation, seq: number, done: Step[], call: LlmStepOutput['toolCalls'][number]) {
  const context = await loadContext(deps, turn, conversation)
  // Be nem töltött eszköz hívása: a séma most betöltődik, a modell egy rövid hibával újrahívja. A lépés
  // saját hash-t kap, így nem számít bele az ismétlődő-hurok őrbe.
  const target = call.name === TOOL_DESCRIBE ? undefined : findTool(context, call.name)
  if (target && !isLoaded(context, target.name)) {
    const loaded = [...(context.loaded ?? []), target.name].sort()
    await finishLocalStep(deps, turn, seq, sha('autoload', call.name, call.arguments), {
      callId: call.id,
      name: call.name,
      text: `Error: a(z) ${toFunctionName(target.name)} eszköz sémája eddig nem volt nálad; most betöltöttem. Hívd újra a pontos paraméterekkel.`,
      isError: true,
    }, { ...context, loaded })
    return
  }
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}')
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    await deps.store.beginStep({ turnId: turn.id, seq, kind: 'tool', inputHash: sha(call.name, call.arguments), idempotencyKey: null })
    await deps.store.finishStep(turn.id, seq, 'done', { callId: call.id, name: call.name, text: 'Error: the tool arguments were not valid JSON.', isError: true })
    await deps.queue.enqueue({ turnId: turn.id, seq: seq + 1 })
    return
  }
  const inputHash = sha(call.name, args)
  // Ismétlődő-hurok védelem: azonos tool + argumentum 3× egymás után.
  const lastTools = done.filter((s) => s.kind === 'tool').slice(-2)
  if (lastTools.length === 2 && lastTools.every((s) => s.inputHash === inputHash)) {
    await fail(deps, turn, MESSAGES.loop, 'loop')
    return
  }
  if (call.name === TOOL_DESCRIBE) {
    const result = describeTools(context, args)
    await finishLocalStep(deps, turn, seq, inputHash, { callId: call.id, name: call.name, text: result.text, isError: result.isError }, { ...context, loaded: result.loaded })
    return
  }
  const idempotencyKey = sha(turn.id, seq, call.name).slice(0, 48)
  if (hasIdempotencyParam(context, call.name) && args.idempotencyKey === undefined) args.idempotencyKey = idempotencyKey
  await deps.store.beginStep({ turnId: turn.id, seq, kind: 'tool', inputHash, idempotencyKey })
  await deps.store.appendEvent(turn.id, 'tool', { phase: 'start', name: call.name })

  const pending = turn.pendingApproval?.seq === seq && turn.pendingApproval.decision ? turn.pendingApproval : null
  const result = await deps.platform.callTool({
    token: turn.continuationToken!,
    tenantSlug: conversation.tenantSlug,
    agentId: turn.agentId,
    sessionId: conversation.id,
    name: call.name,
    args,
    ...(pending ? { approval: { requestState: pending.requestState, inputKey: pending.inputKey, decision: pending.decision! } } : {}),
  })

  if (result.kind === 'input_required') {
    if (pending) throw new PlatformError('approval round returned input_required again', 502)
    const approval = { seq, requestState: result.requestState, inputKey: result.inputKey, message: result.message, createdAt: nowOf(deps).toISOString() }
    await deps.store.finishStep(turn.id, seq, 'awaiting_approval', null)
    await deps.store.transitionTurn(turn.id, ['running'], 'awaiting_approval', { pendingApproval: approval })
    await deps.store.appendEvent(turn.id, 'approval', {
      phase: 'requested',
      seq,
      tool: call.name,
      message: result.message,
      expiresAt: new Date(Date.parse(approval.createdAt) + APPROVAL_TTL_MS).toISOString(),
      link: approvalsLink(deps.platformOrigin),
    })
    return
  }
  const text = result.text.length > deps.limits.toolResultChars
    ? `${result.text.slice(0, deps.limits.toolResultChars)}\n… (az eredmény csonkolva)`
    : result.text
  await deps.store.finishStep(turn.id, seq, 'done', { callId: call.id, name: call.name, text, isError: result.isError } satisfies ToolStepOutput)
  if (pending) await deps.store.updateTurn(turn.id, { pendingApproval: null })
  await deps.store.updateTurn(turn.id, { stepCount: seq + 1 })
  await deps.store.appendEvent(turn.id, 'tool', { phase: 'done', name: call.name, isError: result.isError })
  await deps.queue.enqueue({ turnId: turn.id, seq: seq + 1 })
}

/**
 * Egy lépés (Cloud Tasks kérés). Visszatérés:
 * - `done` / `skip`: 2xx, a feladat kész (vagy duplikált volt);
 * - `retry`: 5xx, a Cloud Tasks később újraküldi (pl. bérlet foglalt).
 * Dobott hiba → 5xx → újrapróbálás; a `maxAttemptsPerStep`-edik hibánál a forduló közérthetően `failed`.
 */
export async function runStep(deps: EngineDeps, task: { turnId: string; seq: number }): Promise<'done' | 'skip' | 'retry'> {
  const turn = await deps.store.getTurn(task.turnId)
  if (!turn || !ACTIVE_TURN_STATUSES.includes(turn.status)) return 'skip'
  if (turn.status === 'awaiting_approval') return 'skip'
  if (!(await deps.store.claimTurn(turn.id, LEASE_SECONDS))) return 'retry'
  let current: Step | undefined
  try {
    const conversation = await deps.store.getConversation(turn.conversationId)
    if (!conversation || !turn.continuationToken) {
      await fail(deps, turn, MESSAGES.noAccess, 'no_access')
      return 'done'
    }
    const steps = await deps.store.listSteps(turn.id)
    const done = steps.filter((s) => s.status === 'done')
    current = steps.find((s) => s.seq === task.seq)
    if (task.seq !== done.length) return 'skip' // már kész, vagy nem ez a soron következő
    if (current && current.attempts >= deps.limits.maxAttemptsPerStep && current.status === 'running') {
      await fail(deps, turn, MESSAGES.failed, 'max_attempts')
      return 'done'
    }
    if (task.seq >= deps.limits.maxSteps) {
      await fail(deps, turn, MESSAGES.tooManySteps, 'max_steps')
      return 'done'
    }
    if (nowOf(deps).getTime() - turn.createdAt.getTime() > deps.limits.maxTurnSeconds * 1000) {
      await fail(deps, turn, MESSAGES.tooLong, 'max_time')
      return 'done'
    }
    if (turn.status === 'queued') await deps.store.transitionTurn(turn.id, ['queued'], 'running')
    const live = { ...turn, status: 'running' as const }
    const plan = planNext(done)
    if (plan.kind === 'llm') await runLlm(deps, live, conversation, task.seq, done)
    else await runTool(deps, live, conversation, task.seq, done, plan.call)
    return 'done'
  } catch (error) {
    // A platform elutasította a hozzáférést (visszavont user, kikapcsolt agent): nincs értelme újrapróbálni.
    if (error instanceof PlatformError && (error.status === 401 || error.status === 403)) {
      await fail(deps, turn, MESSAGES.noAccess, 'no_access')
      return 'done'
    }
    const attempts = (await deps.store.listSteps(turn.id)).find((s) => s.seq === task.seq)?.attempts ?? 1
    if (attempts >= deps.limits.maxAttemptsPerStep) {
      await fail(deps, turn, MESSAGES.failed, 'step_failed')
      return 'done'
    }
    throw error
  } finally {
    await deps.store.releaseTurn(turn.id)
  }
}
