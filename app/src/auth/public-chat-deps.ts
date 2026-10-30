/**
 * #1016: a nyilvános chat éles függőségei — modell, nyilvános KB, továbbítás, Turnstile, rate-limit.
 */
import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import { sendMicrosoftMail } from '@/domain/connector-grant/microsoft-mail-client'
import { tenantMailboxOf } from '@/domain/connector-grant/tenant-mailbox'
import { services } from '@/domain/gateway-services'
import { envProviderRegistry } from '@/domain/model-gateway/proxy'
import { createPublicModelCaller } from '@/domain/public-chat/model-client'
import type { PublicChatDeps } from '@/domain/public-chat/service'
import { readPublicAssistantConfig, type PublicAssistantConfig } from '@/domain/public-chat/config'
import type { PublicChatMaintenanceDeps } from '@/domain/public-chat/maintenance'
import type { TranscriptEntry } from '@/domain/public-chat/runtime'
import { writeAudit } from '@/lib/audit/types'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/observability'
import { repositories } from '@/repositories/postgres'
import { publicChatStore } from '@/repositories/postgres/public-chat-store'

const DEV_SECRET = 'local-dev-public-chat-secret-0000000000'

export function publicChatSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.PUBLIC_CHAT_SECRET || env.WRITE_GATE_SECRET
  if (secret) return secret
  if (env.NODE_ENV === 'production') throw new Error('PUBLIC_CHAT_SECRET (vagy WRITE_GATE_SECRET) nincs beállítva')
  return DEV_SECRET
}

/** D13: Cloudflare Turnstile szerveroldali ellenőrzés; titok nélkül nincs bot-védelem (a konfigurátor jelzi). */
export function turnstileConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
}

async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  if (!token) return false
  const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY ?? '', response: token })
  if (ip) form.set('remoteip', ip)
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok && ((await res.json()) as { success?: boolean }).success === true
  } catch (error) {
    logger.warn({ event: 'public_chat.turnstile_failed', error: String(error) }, 'Turnstile verify failed')
    return false
  }
}

// ponytail: példányonkénti memória-limit (Cloud Run több példánnyal lazább); a DB-oldali
// IP/óra és munkamenet-korlát, valamint a napi keret a valódi plafon.
const buckets = new Map<string, { count: number; resetAt: number }>()
function rateLimit(key: string): boolean {
  const now = Date.now()
  const limit = key.endsWith('|send') ? 20 : 60
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  bucket.count += 1
  return bucket.count <= limit
}

/** D4: csak a tenant aktív, `publicKb` jelölésű tudásbázisai — a publikált lista futáskor is szűrve. */
export async function publicKbConnectorIds(tenantId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await prisma.connector.findMany({
    where: { id: { in: ids }, tenantId, type: 'knowledge_base', publicKb: true, lifecycleState: 'active' },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

function transcriptText(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${e.role === 'user' ? 'Látogató' : 'Asszisztens'}: ${e.content}`).join('\n\n')
}

/**
 * D12: rögzített címzettnek, a tenant Gmail-connectorán át; ha nem megy, „Visszahívást kér” jegy.
 * #1028: tenant-postafiókból (Gmail vagy Microsoft 365) küldő user nélkül is megy.
 */
async function forwardToSupport(input: {
  tenantId: string
  agentId: string
  config: PublicAssistantConfig
  contact: string
  summary: string
  transcript: TranscriptEntry[]
  isTest: boolean
}): Promise<'emailed' | 'callback_requested'> {
  const { config } = input
  if (!config.supportEmail || !config.forwardConnectorId) return 'callback_requested'
  try {
    const connector = await repositories.connectors.findById(config.forwardConnectorId, input.tenantId)
    if (!connector || connector.lifecycleState !== 'active') return 'callback_requested'
    const mailbox = tenantMailboxOf(connector)
    if (mailbox?.readOnly) return 'callback_requested'
    if (!mailbox && (connector.type !== 'gmail' || !config.forwardSenderUserId)) return 'callback_requested'
    const grant = mailbox
      ? await repositories.connectorGrants.findActiveTenantGrant({ tenantId: input.tenantId, connectorId: connector.id })
      : await prisma.connectorGrant.findFirst({
          where: { tenantId: input.tenantId, connectorId: connector.id, userId: config.forwardSenderUserId, status: 'active' },
          orderBy: { grantedAt: 'desc' },
        })
    if (!grant) return 'callback_requested'
    const token = await services.connectorGrants.resolveAccessToken({
      connector,
      grantId: grant.id,
      tokenRef: grant.tokenRef,
      actingUserId: grant.userId ?? '',
      tenantId: input.tenantId,
    })
    const subject = `${input.isTest ? '[TESZT] ' : ''}[${config.displayName}] Továbbított kérdés a weboldalról`
    const body = [
      'A nyilvános asszisztens egy látogató kérését továbbította.',
      '',
      `Elérhetőség (a látogató adta meg, nem ellenőrzött): ${input.contact}`,
      `Összefoglaló: ${input.summary}`,
      '',
      '--- Beszélgetés ---',
      transcriptText(input.transcript),
    ].join('\n')
    let messageId: string | null = null
    if (mailbox?.source === 'microsoft') {
      await sendMicrosoftMail(token, { to: config.supportEmail, subject, body })
    } else {
      messageId = (await new GmailApiClient(token).send({ to: config.supportEmail, subject, body })).messageId
    }
    await writeAudit(repositories.audit, {
      actorType: 'agent',
      actorId: input.agentId,
      action: 'public_chat.forwarded',
      targetType: 'connector',
      targetId: connector.id,
      policyDecision: 'allowed',
      metadata: { messageId, to: config.supportEmail, ...(mailbox ? { mailbox: grant.accountLabel } : {}) },
      tenantId: input.tenantId,
    })
    return 'emailed'
  } catch (error) {
    logger.warn({ event: 'public_chat.forward_failed', error: String(error) }, 'Public chat forward failed')
    return 'callback_requested'
  }
}

export function publicChatDeps(): PublicChatDeps {
  const fallback = Number(process.env.PLATFORM_CHAT_FALLBACK_USD_PER_MTOK)
  const modelDeps = {
    getTenantPolicy: (tenantId: string) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    providers: envProviderRegistry(),
    ...(Number.isFinite(fallback) && fallback > 0 ? { fallbackUsdPerMTok: fallback } : {}),
  }
  return {
    store: publicChatStore,
    verifyTurnstile: turnstileConfigured() ? verifyTurnstile : null,
    secret: publicChatSecret(),
    rateLimit,
    audit: repositories.audit,
    onError: (error) => logger.error({ event: 'public_chat.turn_failed', error: String(error) }, 'Public chat turn failed'),
    turnDeps: ({ tenantId, agentId, sessionId, isTest, config, transcript }) => {
      const signal = async (source: string, question: string) => {
        if (!isTest) await publicChatStore.addSignal({ tenantId, agentId, sessionId, source, question })
      }
      return {
        callModel: createPublicModelCaller(modelDeps, { tenantId, config }),
        async searchKb({ connectorIds, query }) {
          const allowed = await publicKbConnectorIds(tenantId, connectorIds)
          const results = await Promise.all(allowed.map((connectorId) => services.knowledgeBase.search({ connectorId, query, k: 5 })))
          return results
            .flat()
            .slice(0, 5)
            .map((hit) => ({ title: String(hit.title ?? ''), snippet: String(hit.snippet ?? '') }))
        },
        async forward({ contact, summary }) {
          await signal('forward', summary)
          return forwardToSupport({ tenantId, agentId, config, contact, summary, transcript: transcript(), isTest })
        },
        flag: ({ source, question }) => signal(source, question),
      }
    },
  }
}

/** #1016 napi karbantartás éles függőségei (retenciós sweep). */
export function publicChatMaintenanceDeps(): PublicChatMaintenanceDeps {
  const modelDeps = {
    getTenantPolicy: (tenantId: string) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    providers: envProviderRegistry(),
  }
  return {
    async deleteSessionsInactiveSince(cutoff) {
      return (await prisma.publicChatSession.deleteMany({ where: { lastActivityAt: { lt: cutoff } } })).count
    },
    async listUngrouped(limit) {
      const signals = await prisma.publicChatSignal.findMany({
        where: { groupLabel: null, answeredAt: null, dismissedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { id: true, tenantId: true, agentId: true, question: true },
      })
      const byAgent = new Map<string, { tenantId: string; agentId: string; signals: Array<{ id: string; question: string }> }>()
      for (const s of signals) {
        const entry = byAgent.get(s.agentId) ?? { tenantId: s.tenantId, agentId: s.agentId, signals: [] }
        if (entry.signals.length < limit) entry.signals.push({ id: s.id, question: s.question })
        byAgent.set(s.agentId, entry)
      }
      const assistants = await prisma.publicAssistant.findMany({
        where: { agentId: { in: [...byAgent.keys()] } },
        select: { agentId: true, published: true, draft: true },
      })
      return assistants.map((a) => ({ ...byAgent.get(a.agentId)!, config: a.published ?? a.draft }))
    },
    async setGroupLabel({ tenantId, agentId, ids, label }) {
      await prisma.publicChatSignal.updateMany({ where: { id: { in: ids }, tenantId, agentId }, data: { groupLabel: label } })
    },
    callModelFor: ({ tenantId, config }) => createPublicModelCaller(modelDeps, { tenantId, config: readPublicAssistantConfig(config) }),
  }
}
