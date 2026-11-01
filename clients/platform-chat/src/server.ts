/**
 * A worker HTTP-API-ja. A böngésző (platform UI) a chat-tokennel hívja, CORS csak a platform originjére.
 * A `/internal/step`-et csak a Cloud Tasks hívhatja (Google OIDC).
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bearer, verifyChatToken, verifyGoogleOidc, type ChatClaims } from './auth.ts'
import {
  attachmentMime,
  extractText,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type BlobStorage,
} from './attachments.ts'
import type { Config } from './config.ts'
import { cancelTurn, closeExpiredApproval, decideApproval, runStep, startTurn, type EngineDeps } from './engine.ts'
import { ACTIVE_TURN_STATUSES, type Conversation } from './store.ts'

const SSE_POLL_MS = 300
const SSE_IDLE_CLOSE_MS = 120_000
const MAX_JSON_BYTES = 256 * 1024
const MAX_MESSAGE_CHARS = 32_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServerDeps = EngineDeps & { config: Config; storage: BlobStorage; verifyTaskToken?: (token: string) => Promise<boolean> }

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'too_large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_JSON_BYTES)
  if (raw.length === 0) return {}
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // lent
  }
  throw new HttpError(400, 'bad_request')
}

function corsHeaders(config: Config, origin: string | undefined): Record<string, string> {
  if (origin !== config.platformOrigin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, last-event-id, x-file-name',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

function publicConversation(c: Conversation) {
  return {
    id: c.id,
    agentId: c.agentId,
    agentName: c.agentName,
    title: c.title || 'Új beszélgetés',
    createdAt: c.createdAt.toISOString(),
    lastActivityAt: c.lastActivityAt.toISOString(),
  }
}

export function createHandler(deps: ServerDeps) {
  const { config, store } = deps

  function auth(req: IncomingMessage): ChatClaims & { token: string } {
    const token = bearer(req.headers.authorization)
    const claims = token ? verifyChatToken(token, config.chatTokenSecret) : null
    if (!token || !claims) throw new HttpError(401, 'unauthenticated')
    return { ...claims, token }
  }

  /** A user saját beszélgetése (admin-betekintés külön végponton). */
  async function ownConversation(claims: ChatClaims, id: string): Promise<Conversation> {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found')
    const c = await store.getConversation(id)
    if (!c || c.tenantId !== claims.tid || c.userId !== claims.sub) throw new HttpError(404, 'not_found')
    return c
  }

  async function chatAgents(claims: ChatClaims & { token: string }) {
    const agents = await deps.platform.listAgents({ token: claims.token, tenantSlug: claims.tenant })
    return agents
      .filter((a) => a.platformChat === true)
      .map((a) => ({
        agentId: String(a.agentId),
        name: String(a.name ?? ''),
        description: (a.description as string | null) ?? (a.roleInstructionPreview as string | null) ?? null,
      }))
  }

  async function conversationView(c: Conversation) {
    const [messages, active] = await Promise.all([store.listMessages(c.id), store.activeTurn(c.id)])
    let activeTurn = active
    if (active && (await closeExpiredApproval(deps, active))) activeTurn = null
    const lastFailed = activeTurn ? null : await lastTurnError(c.id, messages.at(-1)?.turnId ?? null)
    return {
      conversation: publicConversation(c),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        attachments: m.attachments,
        files: m.files,
        createdAt: m.createdAt.toISOString(),
      })),
      activeTurn: activeTurn
        ? { id: activeTurn.id, status: activeTurn.status, pendingApproval: activeTurn.pendingApproval ? { message: activeTurn.pendingApproval.message, createdAt: activeTurn.pendingApproval.createdAt } : null }
        : null,
      lastError: lastFailed,
    }
  }

  /** Ha az utolsó forduló hibával zárult, a UI megmutatja (egy mondat + Újra). */
  async function lastTurnError(conversationId: string, lastMessageTurnId: string | null) {
    if (!lastMessageTurnId) return null
    const turn = await store.getTurn(lastMessageTurnId)
    if (!turn || turn.conversationId !== conversationId || turn.status !== 'failed') return null
    return { turnId: turn.id, message: turn.error }
  }

  async function streamEvents(req: IncomingMessage, res: ServerResponse, claims: ChatClaims, turnId: string, cors: Record<string, string>) {
    const turn = UUID_RE.test(turnId) ? await store.getTurn(turnId) : null
    if (!turn || turn.userId !== claims.sub || turn.tenantId !== claims.tid) throw new HttpError(404, 'not_found')
    let after = Number(req.headers['last-event-id'] ?? new URL(req.url ?? '/', 'http://x').searchParams.get('after') ?? 0)
    if (!Number.isFinite(after) || after < 0) after = 0
    res.writeHead(200, {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    let closed = false
    req.on('close', () => {
      closed = true
    })
    let lastEventAt = Date.now()
    // §5.3: hiányzó események, utána pollozás, amíg a forduló fut; 2 perc csend után zárás
    // (a kliens újracsatlakozik) — nyitva felejtett kapcsolat így nem számlázódik.
    while (!closed) {
      const events = await store.eventsAfter(turnId, after)
      for (const e of events) {
        res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`)
        after = e.seq
        lastEventAt = Date.now()
      }
      const current = await store.getTurn(turnId)
      const finished = !current || !ACTIVE_TURN_STATUSES.includes(current.status) || current.status === 'awaiting_approval'
      if (finished && events.length === 0) break
      if (Date.now() - lastEventAt > SSE_IDLE_CLOSE_MS) break
      await new Promise((r) => setTimeout(r, SSE_POLL_MS))
    }
    res.end()
  }

  async function route(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) {
    const url = new URL(req.url ?? '/', 'http://worker')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'
    const parts = path.split('/').filter(Boolean)
    const ok = (status: number, body: unknown) => {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
      send(res, status, body)
    }

    // A Cloud Run a `/healthz`-t magának foglalja — a `/health` éri el a workert.
    if (path === '/health' || path === '/healthz') return ok(200, { ok: true })

    if (method === 'POST' && path === '/internal/step') {
      const token = bearer(req.headers.authorization)
      const verify =
        deps.verifyTaskToken ??
        (config.queue.kind === 'cloud_tasks'
          ? (t: string) => verifyGoogleOidc(t, { audience: config.selfUrl, email: (config.queue as { serviceAccountEmail: string }).serviceAccountEmail })
          : async () => false)
      if (!token || !(await verify(token))) throw new HttpError(401, 'unauthenticated')
      const body = await readJson(req)
      if (typeof body.turnId !== 'string' || !UUID_RE.test(body.turnId) || !Number.isInteger(body.seq)) {
        return ok(200, { skipped: 'bad_task' }) // rossz feladatot ne próbáljon újra a sor
      }
      const outcome = await runStep(deps, { turnId: body.turnId, seq: body.seq as number })
      return ok(outcome === 'retry' ? 503 : 200, { outcome })
    }

    const claims = auth(req)

    if (method === 'GET' && path === '/agents') {
      const agents = await chatAgents(claims)
      return ok(200, { agents, adminInsight: claims.adminInsight })
    }

    if (parts[0] === 'conversations') {
      if (method === 'GET' && parts.length === 1) {
        const agentId = url.searchParams.get('agentId') ?? undefined
        if (agentId && !UUID_RE.test(agentId)) throw new HttpError(400, 'bad_request')
        const list = await store.listConversations({
          tenantId: claims.tid,
          userId: claims.sub,
          agentId,
          query: url.searchParams.get('q') ?? undefined,
          limit: 50,
        })
        return ok(200, { conversations: list.map(publicConversation) })
      }
      if (method === 'POST' && parts.length === 1) {
        const body = await readJson(req)
        const agentId = typeof body.agentId === 'string' ? body.agentId : ''
        const agent = (await chatAgents(claims)).find((a) => a.agentId === agentId)
        if (!agent) throw new HttpError(403, 'agent_unavailable')
        const c = await store.createConversation({
          tenantId: claims.tid,
          tenantSlug: claims.tenant,
          userId: claims.sub,
          agentId,
          agentName: agent.name,
        })
        return ok(201, { conversation: publicConversation(c) })
      }
      const c = await ownConversation(claims, parts[1] ?? '')
      if (parts.length === 2 && method === 'GET') return ok(200, await conversationView(c))
      if (parts.length === 2 && method === 'PATCH') {
        const body = await readJson(req)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title || title.length > 200) throw new HttpError(400, 'bad_request')
        await store.renameConversation(c.id, title, true)
        return ok(200, { ok: true })
      }
      if (parts.length === 2 && method === 'DELETE') {
        const active = await store.activeTurn(c.id)
        if (active) await cancelTurn(deps, active.id, claims.sub)
        const paths = await store.listAttachmentPaths(c.id)
        await deps.storage.remove(paths).catch((error) => console.error('attachment cleanup failed', String(error)))
        await store.deleteConversation(c.id)
        return ok(200, { ok: true })
      }
      if (parts[2] === 'turns' && parts.length === 3 && method === 'POST') {
        const body = await readJson(req)
        const content = typeof body.content === 'string' ? body.content.trim() : ''
        const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)) : []
        if ((!content && ids.length === 0) || content.length > MAX_MESSAGE_CHARS || ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new HttpError(400, 'bad_request')
        }
        const attachments = ids.length ? await store.getAttachments(c.id, ids) : []
        const result = await startTurn(deps, { conversation: c, chatToken: claims.token, content, attachments })
        if (!result.ok) {
          throw result.code === 'busy'
            ? new HttpError(409, 'turn_in_progress', 'Még dolgozik az előző kérésen. Várj, vagy állítsd le.')
            : new HttpError(403, 'agent_unavailable')
        }
        return ok(202, { turnId: result.turn.id })
      }
      if (parts[2] === 'attachments' && parts.length === 3 && method === 'POST') {
        const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 200)
        const mime = name ? attachmentMime(name) : null
        if (!mime) throw new HttpError(415, 'unsupported_type', 'Ezt a fájltípust nem lehet csatolni.')
        const data = await readBody(req, MAX_ATTACHMENT_BYTES)
        if (data.length === 0) throw new HttpError(400, 'empty_file')
        const id = randomUUID()
        const storagePath = `${c.tenantId}/${c.id}/${id}`
        await deps.storage.put(storagePath, data, mime)
        const extractedText = await extractText(data, mime).catch(() => null)
        const att = await store.addAttachment({ conversationId: c.id, storagePath, name, mime, size: data.length, extractedText })
        return ok(201, { attachment: { id: att.id, name: att.name, mime: att.mime, size: att.size } })
      }
    }

    if (parts[0] === 'turns' && parts.length === 3) {
      const turnId = parts[1]
      if (method === 'GET' && parts[2] === 'events') return streamEvents(req, res, claims, turnId, cors)
      if (method === 'POST' && parts[2] === 'cancel') {
        if (!UUID_RE.test(turnId) || !(await cancelTurn(deps, turnId, claims.sub))) throw new HttpError(404, 'not_found')
        return ok(200, { ok: true })
      }
      if (method === 'POST' && parts[2] === 'approval') {
        const body = await readJson(req)
        const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null
        if (!decision || !UUID_RE.test(turnId)) throw new HttpError(400, 'bad_request')
        const outcome = await decideApproval(deps, { turnId, userId: claims.sub, decision })
        if (outcome === 'not_found') throw new HttpError(404, 'not_found')
        if (outcome === 'not_waiting') throw new HttpError(409, 'not_waiting')
        return ok(200, { outcome })
      }
    }

    // D15: admin-betekintés — csak tenant admin, és csak ha a superadmin a tenantnál engedélyezte.
    if (parts[0] === 'admin' && parts[1] === 'conversations') {
      if (claims.role !== 'admin' || !claims.adminInsight) throw new HttpError(404, 'not_found')
      if (method === 'GET' && parts.length === 2) {
        const userId = url.searchParams.get('userId') ?? undefined
        const agentId = url.searchParams.get('agentId') ?? undefined
        if ((userId && !UUID_RE.test(userId)) || (agentId && !UUID_RE.test(agentId))) throw new HttpError(400, 'bad_request')
        const list = await store.listConversations({ tenantId: claims.tid, userId, agentId, query: url.searchParams.get('q') ?? undefined, limit: 100 })
        return ok(200, { conversations: list.map((c) => ({ ...publicConversation(c), userId: c.userId })) })
      }
      if (method === 'GET' && parts.length === 3 && UUID_RE.test(parts[2])) {
        const c = await store.getConversation(parts[2])
        if (!c || c.tenantId !== claims.tid) throw new HttpError(404, 'not_found')
        await store.logAdminView({ tenantId: claims.tid, adminUserId: claims.sub, conversationId: c.id })
        const view = await conversationView(c)
        return ok(200, { ...view, conversation: { ...view.conversation, userId: c.userId }, activeTurn: null })
      }
    }

    throw new HttpError(404, 'not_found')
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const cors = corsHeaders(config, req.headers.origin)
    if (req.method === 'OPTIONS') {
      res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, cors)
      res.end()
      return
    }
    try {
      await route(req, res, cors)
    } catch (error) {
      for (const [k, v] of Object.entries(cors)) if (!res.headersSent) res.setHeader(k, v)
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message })
      console.error('platform-chat request failed', { url: req.url, error: error instanceof Error ? error.stack : String(error) })
      if (!res.headersSent) send(res, 500, { error: 'internal' })
      else res.end()
    }
  }
}
