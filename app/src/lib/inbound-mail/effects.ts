/**
 * #1032 mellékhatások: platform-chat futás indítása a felelős user nevében (szerveroldali chat-token,
 * `origin: inbound_mail`), a futás állapotának lekérdezése, és átadás (Handoff) létrehozása.
 */
import type { UserRole } from '@prisma/client'
import { issueChatSession, type ChatSessionDeps } from '@/domain/platform-chat/session'
import type { InboundMailEffects, RunState } from '@/domain/inbound-mail/service'
import { inboundHandoffContent, inboundRunMessage, inboundRunTitle, instructionsHash, INBOUND_MAIL_ORIGIN } from '@/domain/inbound-mail/run-request'
import { normalizeHandoffProjectKey, type HandoffStore } from '@/domain/handoff/handoff-service'

export type WorkerEffectsDeps = {
  session: ChatSessionDeps
  /** A felelős user aktív tagsága (szerep) a tenantban; null = már nem tag. */
  loadRole: (input: { tenantId: string; userId: string }) => Promise<UserRole | null>
  handoffs: Pick<HandoffStore, 'insert'>
  fetchImpl?: typeof fetch
}

type IssuedSession = { token: string; workerUrl: string }

async function session(
  deps: WorkerEffectsDeps,
  input: { tenantId: string; userId: string; agentId: string; instructions?: string },
): Promise<{ ok: true; value: IssuedSession } | { ok: false; code: string }> {
  const role = await deps.loadRole({ tenantId: input.tenantId, userId: input.userId })
  if (!role) return { ok: false, code: 'responsible_user_not_member' }
  const issued = await issueChatSession(deps.session, {
    userId: input.userId,
    tenantId: input.tenantId,
    role,
    agentId: input.agentId,
    ...(input.instructions !== undefined
      ? { system: { origin: INBOUND_MAIL_ORIGIN, instructionsHash: instructionsHash(input.instructions) } }
      : {}),
  })
  return issued.ok ? { ok: true, value: { token: issued.token, workerUrl: issued.workerUrl } } : { ok: false, code: issued.code }
}

async function workerCall(deps: WorkerEffectsDeps, s: IssuedSession, method: string, path: string, body?: unknown) {
  const res = await (deps.fetchImpl ?? fetch)(`${s.workerUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, data }
}

export function createInboundMailEffects(deps: WorkerEffectsDeps): InboundMailEffects {
  return {
    async startRun(input) {
      const s = await session(deps, { ...input, instructions: input.instructions })
      if (!s.ok) return s
      const created = await workerCall(deps, s.value, 'POST', '/conversations', {
        agentId: input.agentId,
        origin: INBOUND_MAIL_ORIGIN,
        instructions: input.instructions,
        title: inboundRunTitle(input.mail),
      })
      const conversation = created.data?.conversation as { id?: unknown } | undefined
      if (created.status !== 201 || typeof conversation?.id !== 'string') {
        return { ok: false, code: String(created.data?.error ?? `worker_${created.status}`) }
      }
      const turn = await workerCall(deps, s.value, 'POST', `/conversations/${conversation.id}/turns`, {
        content: inboundRunMessage({ mailboxAddress: input.mailboxAddress, mail: input.mail }),
      })
      if (turn.status !== 202) return { ok: false, code: String(turn.data?.error ?? `worker_${turn.status}`) }
      return { ok: true, conversationId: conversation.id }
    },

    async runState(input): Promise<RunState> {
      const s = await session(deps, input)
      // A user már nem érheti el a munkatársat: a futás nem követhető tovább.
      if (!s.ok) return 'failed'
      const view = await workerCall(deps, s.value, 'GET', `/conversations/${encodeURIComponent(input.conversationId)}`)
      if (view.status === 404) return 'missing'
      if (view.status !== 200 || !view.data) throw new Error(`worker_${view.status}`)
      if (view.data.activeTurn) return 'running'
      if (view.data.lastError) return 'failed'
      const messages = Array.isArray(view.data.messages) ? (view.data.messages as Array<{ role?: unknown }>) : []
      if (messages.at(-1)?.role === 'assistant') return 'processed'
      // Nincs válasz és nincs futó forduló: leállították.
      return messages.length > 0 ? 'failed' : 'running'
    },

    async createHandoff(input) {
      const content = inboundHandoffContent({
        agentName: input.fromAgentName,
        mailboxAddress: input.mailboxAddress,
        mail: input.mail,
        eventId: input.eventId,
      })
      const { handoff } = await deps.handoffs.insert({
        tenantId: input.tenantId,
        fromAgentId: input.fromAgentId,
        fromDefinitionId: input.fromDefinitionId,
        toAgentId: input.toAgentId,
        toUserId: input.toUserId,
        projectKey: normalizeHandoffProjectKey(undefined),
        title: content.title,
        summary: content.summary,
        links: null,
        createdById: input.createdById,
        idempotencyKey: content.idempotencyKey,
      })
      return { handoffId: handoff.id }
    },
  }
}
