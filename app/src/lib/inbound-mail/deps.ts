/**
 * #1032 összekötés: Prisma-tároló + platform-chat worker + titoktár + OAuth-tokenek.
 */
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { chatSessionDeps } from '@/auth/platform-chat-deps'
import { InboundMailService } from '@/domain/inbound-mail/service'
import { MailboxWatcher, type WatchState } from '@/domain/inbound-mail/watcher'
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { agentMailApiBase, inboxIdFromConnectorBaseUrl, loadAgentMailOrgKey, loadAgentMailRegion } from '@/lib/agentmail'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { readInboundMailSettings } from '@/lib/inbound-mail-settings'
import { createInboundMailEffects } from './effects'
import { listClaimedForTenant, listWatchedMailboxes, loadWatchedMailbox, prismaInboundMailStore, watchStore, type WatchRow } from './store'

const secretKey = (connectorId: string) => `inbound-mail-${connectorId}`

function toState(row: WatchRow): WatchState {
  return {
    connectorId: row.connectorId,
    provider: row.provider,
    externalId: row.externalId,
    cursor: row.cursor,
    expiresAt: row.expiresAt,
    lastPolledAt: row.lastPolledAt,
    createdAt: row.createdAt,
  }
}

function publicOrigin(): string | null {
  try {
    return resolvePublicAppOrigin()
  } catch {
    return null
  }
}

let cached: { service: InboundMailService; watcher: MailboxWatcher } | null = null

export function inboundMail(): { service: InboundMailService; watcher: MailboxWatcher } {
  if (cached) return cached
  const service = new InboundMailService({
    store: prismaInboundMailStore,
    audit: repositories.audit,
    effects: createInboundMailEffects({
      session: chatSessionDeps(),
      loadRole: async ({ tenantId, userId }) => {
        const membership = await prisma.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId, userId } },
          select: { role: true, status: true },
        })
        return membership?.status === 'active' ? membership.role : null
      },
      handoffs: services.projectWork.handoffs,
    }),
  })
  const watcher = new MailboxWatcher({
    service,
    store: prismaInboundMailStore,
    watches: {
      find: async (connectorId) => {
        const row = await watchStore.find(connectorId)
        return row ? toState(row) : null
      },
      findByExternalId: async (provider, externalId) => {
        const row = await watchStore.findByExternalId(provider, externalId)
        return row ? toState(row) : null
      },
      listByProvider: async (provider) => (await watchStore.listByProvider(provider)).map(toState),
      upsert: async (input) => toState(await watchStore.upsert(input)),
      update: (connectorId, patch) => watchStore.update(connectorId, patch),
    },
    loadMailbox: (connectorId) => loadWatchedMailbox(connectorId),
    listMailboxes: (tenantId) => listWatchedMailboxes(tenantId),
    credentials: {
      async agentMailInbox(connectorId) {
        const connector = await prisma.connector.findUnique({ where: { id: connectorId }, select: { config: true, secretAlias: true } })
        const baseUrl = (connector?.config as { baseUrl?: unknown } | null)?.baseUrl
        const inboxId = inboxIdFromConnectorBaseUrl(baseUrl)
        if (!connector || !inboxId || typeof baseUrl !== 'string') return null
        return { baseUrl: baseUrl.replace(/\/+$/, ''), inboxId, inboxKey: await resolveConnectorApiKey(connector.secretAlias) }
      },
      async agentMailOrg(tenantId) {
        const [orgKey, region] = await Promise.all([loadAgentMailOrgKey(tenantId), loadAgentMailRegion(tenantId)])
        return orgKey ? { orgKey, apiBase: agentMailApiBase(region) } : null
      },
      async oauthToken(mailbox) {
        const [connector, grant] = await Promise.all([
          prisma.connector.findUnique({ where: { id: mailbox.connectorId } }),
          repositories.connectorGrants.findActiveTenantGrant({ tenantId: mailbox.tenantId, connectorId: mailbox.connectorId }),
        ])
        if (!connector || !grant?.tokenRef) throw new Error('tenant_mailbox_disconnected')
        return services.connectorGrants.resolveAccessToken({
          connector,
          grantId: grant.id,
          tokenRef: grant.tokenRef,
          actingUserId: '',
          tenantId: mailbox.tenantId,
        })
      },
    },
    secrets: {
      save: (connectorId, secret) => saveConnectorApiKey(secretKey(connectorId), secret),
      async load(connectorId) {
        try {
          return await loadConnectorApiKeyByRef(buildConnectorSecretRef(secretKey(connectorId)))
        } catch (error) {
          if (error instanceof ConnectorApiKeyMissingError) return null
          throw error
        }
      },
    },
    config: {
      publicOrigin: publicOrigin(),
      gmailTopic: process.env.GMAIL_PUSH_TOPIC?.trim() || null,
    },
  })
  cached = { service, watcher }
  return cached
}

/** A saját cím beállítása / szabály mentése után: feliratkozás azonnal (fail-soft). */
export async function ensureInboundWatch(connectorId: string, tenantId: string): Promise<void> {
  try {
    const mailbox = await loadWatchedMailbox(connectorId, tenantId)
    if (mailbox?.agent) await inboundMail().watcher.ensureWatch(mailbox)
  } catch (error) {
    console.warn('inbound_mail.ensure_watch_failed', { connectorId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** A cég beállított lekérdezési gyakorisága (ms). */
export async function inboundPollIntervalMs(tenantId: string): Promise<number> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  return readInboundMailSettings(tenant?.settings).pollMinutes * 60_000
}

/** Ugyanabban a konténerben cégenként legfeljebb percenként egy ellenőrzés (oldalbetöltésenként ne kérdezzük a DB-t). */
const TRIGGER_THROTTLE_MS = 60_000
const lastTrigger = new Map<string, number>()

/**
 * A platform használata közben (oldalbetöltés után, a háttérben): a push nélküli postafiókok esedékes
 * lekérdezése. Tétlen platformon nem fut — így nem ébreszti fölöslegesen az adatbázist. Fail-soft.
 */
export async function triggerInboundPoll(tenantId: string, now = Date.now()): Promise<void> {
  if (now - (lastTrigger.get(tenantId) ?? 0) < TRIGGER_THROTTLE_MS) return
  lastTrigger.set(tenantId, now)
  try {
    const { watcher, service } = inboundMail()
    await watcher.pollDue({ tenantId, deadline: new Date(now + 10_000), intervalMs: inboundPollIntervalMs })
    // A futó feldolgozások állapota (jóváhagyás után „Kész”) — szintén csak használat közben.
    const claimed = await listClaimedForTenant(tenantId, 10)
    if (claimed.length) await service.reconcileClaimed(claimed.length, claimed)
  } catch (error) {
    console.warn('inbound_mail.poll_trigger_failed', { tenantId, error: error instanceof Error ? error.message : String(error) })
  }
}
