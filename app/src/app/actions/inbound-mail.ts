'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/lib/iam-policy'
import { prisma } from '@/lib/db'
import { services } from '@/domain/gateway-services'
import { fail, ok } from '@/lib/result'
import { isPrismaMissingTable } from '@/lib/prisma-table-missing'
import { readPlatformChatSettings } from '@/lib/platform-chat-settings'
import {
  DEFAULT_INBOUND_MAIL_RULE,
  inboundReasonLabel,
  validateInboundMailRule,
  type InboundMailMode,
} from '@/domain/inbound-mail/inbound-mail'
import type { InboundMailStatus } from '@/domain/inbound-mail/service'
import { ensureInboundWatch, inboundMail } from '@/lib/inbound-mail/deps'
import {
  countNewForUser,
  listAgentEvents,
  listClaimedForAgent,
  listNewForUser,
  loadWatchedMailbox,
  toRule,
  watchStore,
} from '@/lib/inbound-mail/store'

export type InboundMailEventRow = {
  id: string
  agentName: string | null
  fromAddress: string
  subject: string
  receivedAt: string
  status: InboundMailStatus
  action: string
  reasonLabel: string | null
  conversationId: string | null
  handoffId: string | null
  error: string | null
}

export type InboundMailSettings = {
  agentId: string
  agentName: string
  mailboxAddress: string | null
  rule: {
    mode: InboundMailMode
    instructions: string
    responsibleUserId: string | null
    handoffToUserId: string | null
    handoffToAgentId: string | null
    senderAllowlist: string
    dailyRunLimit: number
  }
  /** Ki kap értesítést, ha a szabály nem nevez meg senkit (az agent jóváhagyója). */
  fallbackResponsibleName: string | null
  members: Array<{ id: string; label: string }>
  agents: Array<{ id: string; name: string }>
  /** Push (azonnali) vagy csak időszakos ellenőrzés; és az utolsó hiba. */
  delivery: { mode: 'push' | 'poll' | 'none'; lastError: string | null }
  platformChatReady: boolean
  events: InboundMailEventRow[]
}

const agentIdInput = z.object({ agentId: z.string().uuid() })

function toRow(event: Awaited<ReturnType<typeof listAgentEvents>>[number], agentName: string | null = null): InboundMailEventRow {
  return {
    id: event.id,
    agentName,
    fromAddress: event.fromAddress,
    subject: event.subject,
    receivedAt: event.receivedAt.toISOString(),
    status: event.status,
    action: event.action,
    reasonLabel: inboundReasonLabel(event.reason),
    conversationId: event.conversationId,
    handoffId: event.handoffId,
    error: event.error,
  }
}

function toFail(error: unknown, fallback: string) {
  if (error instanceof TenantAuthError) return fail(error.code)
  if (isPrismaMissingTable(error, 'inbound_mail_events') || isPrismaMissingTable(error, 'agent_inbound_mail_rules')) {
    return fail('A bejövő levelek funkció még nincs telepítve (adatbázis-frissítés szükséges).')
  }
  return fail(error instanceof Error && error.message ? error.message : fallback)
}

export async function getInboundMailSettings(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { agentId } = agentIdInput.parse(input)
    const tenantId = user.activeTenantId
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true, name: true, platformChatEnabled: true, approverUserId: true, primaryMailboxConnectorId: true, primaryMailboxAddress: true },
    })
    if (!agent) return fail('A munkatárs nem található.')
    // A futó feldolgozások állapota: a nézet megnyitásakor is frissül (nem csak 5 percenként).
    const claimed = await listClaimedForAgent(tenantId, agentId)
    if (claimed.length) await inboundMail().service.reconcileClaimed(claimed.length, claimed).catch(() => {})
    const [ruleRow, memberships, agents, events, watch, tenant] = await Promise.all([
      prisma.agentInboundMailRule.findUnique({ where: { agentId } }),
      prisma.tenantMembership.findMany({
        where: { tenantId, status: 'active' },
        include: { user: { select: { id: true, name: true, email: true } } },
        take: 500,
      }),
      prisma.agent.findMany({ where: { tenantId, retiredAt: null, id: { not: agentId } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      listAgentEvents(tenantId, agentId, 50),
      agent.primaryMailboxConnectorId ? watchStore.find(agent.primaryMailboxConnectorId) : Promise.resolve(null),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
    ])
    const rule = ruleRow ? toRule(ruleRow) : DEFAULT_INBOUND_MAIL_RULE
    const members = memberships
      .map((m) => ({ id: m.user.id, label: m.user.name?.trim() ? `${m.user.name} (${m.user.email})` : m.user.email }))
      .sort((a, b) => a.label.localeCompare(b.label, 'hu'))
    return ok<InboundMailSettings>({
      agentId,
      agentName: agent.name,
      mailboxAddress: agent.primaryMailboxConnectorId ? agent.primaryMailboxAddress : null,
      rule: { ...rule, senderAllowlist: rule.senderAllowlist.join('\n') },
      fallbackResponsibleName: agent.approverUserId ? members.find((m) => m.id === agent.approverUserId)?.label ?? null : null,
      members,
      agents,
      delivery: {
        mode: !agent.primaryMailboxConnectorId ? 'none' : watch?.externalId ? 'push' : 'poll',
        lastError: watch?.lastError ?? null,
      },
      platformChatReady: Boolean(process.env.PLATFORM_CHAT_WORKER_URL) && agent.platformChatEnabled && readPlatformChatSettings(tenant?.settings).enabled,
      events: events.map((event) => toRow(event)),
    })
  } catch (error) {
    return toFail(error, 'Nem sikerült betölteni a bejövő levelek beállításait.')
  }
}

export async function saveInboundMailRuleAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const raw = agentIdInput.passthrough().parse(input) as { agentId: string } & Record<string, unknown>
    const tenantId = user.activeTenantId
    const agent = await prisma.agent.findFirst({ where: { id: raw.agentId, tenantId }, select: { id: true, primaryMailboxConnectorId: true } })
    if (!agent) return fail('A munkatárs nem található.')
    const validated = validateInboundMailRule({ ...raw, mode: raw.mode })
    if (!validated.ok) return fail(validated.error)
    const rule = validated.rule
    const userIds = [rule.responsibleUserId, rule.handoffToUserId].filter((id): id is string => Boolean(id))
    if (userIds.length) {
      const active = await prisma.tenantMembership.count({ where: { tenantId, status: 'active', userId: { in: userIds } } })
      if (active !== new Set(userIds).size) return fail('A kiválasztott kolléga nem aktív tagja a cégnek.')
    }
    if (rule.handoffToAgentId) {
      if (rule.handoffToAgentId === agent.id) return fail('A munkatárs nem adhatja át saját magának a levelet.')
      const target = await prisma.agent.findFirst({ where: { id: rule.handoffToAgentId, tenantId, retiredAt: null }, select: { id: true } })
      if (!target) return fail('A kiválasztott munkatárs nem található.')
    }
    const data = { ...rule, updatedById: user.user.id }
    await prisma.agentInboundMailRule.upsert({
      where: { agentId: agent.id },
      create: { agentId: agent.id, tenantId, ...data },
      update: data,
    })
    await services.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.inbound_mail.rule',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: {
        mode: rule.mode,
        responsibleUserId: rule.responsibleUserId,
        handoffToUserId: rule.handoffToUserId,
        handoffToAgentId: rule.handoffToAgentId,
        senderAllowlist: rule.senderAllowlist.length,
        dailyRunLimit: rule.dailyRunLimit,
        hasInstructions: Boolean(rule.instructions),
      },
      tenantId,
    })
    if (agent.primaryMailboxConnectorId) await ensureInboundWatch(agent.primaryMailboxConnectorId, tenantId)
    revalidatePath(`/control-plane/agents/${agent.id}`)
    return ok({ saved: true })
  } catch (error) {
    return toFail(error, 'Nem sikerült menteni a beállítást.')
  }
}

const eventInput = z.object({ eventId: z.string().uuid(), operation: z.enum(['process', 'ignore', 'done']) })

/** Postaláda / értesítés gombjai: admin bármelyiket, a felelős kolléga a sajátját kezelheti. */
export async function inboundMailEventAction(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = eventInput.parse(input)
    const tenantId = user.activeTenantId
    const event = await prisma.inboundMailEvent.findFirst({ where: { id: parsed.eventId, tenantId } })
    if (!event) return fail('A levél nem található.')
    const isAdmin = hasMinimumRole(user.activeTenantRole, 'admin')
    if (!isAdmin && event.responsibleUserId !== user.user.id) return fail('Ehhez a levélhez nincs jogosultságod.')
    const { service } = inboundMail()
    if (parsed.operation === 'process') {
      const mailbox = await loadWatchedMailbox(event.connectorId, tenantId)
      if (!mailbox) return fail('A postafiók már nincs bekötve.')
      const result = await service.processNow({ mailbox, eventId: event.id, actorUserId: user.user.id })
      if (!result.ok) return fail(result.error)
    } else {
      const done = await service.resolveManually({
        tenantId,
        eventId: event.id,
        actorUserId: user.user.id,
        status: parsed.operation === 'ignore' ? 'ignored' : 'processed',
      })
      if (!done) return fail('Ez a levél már nem vár döntésre.')
    }
    if (event.agentId) revalidatePath(`/control-plane/agents/${event.agentId}`)
    revalidatePath('/control-plane/operations')
    return ok({ done: true })
  } catch (error) {
    return toFail(error, 'A művelet nem sikerült.')
  }
}

/** Értesítés a felületen: a felelős kollégának szóló új levelek. */
export async function listMyInboundMailAction() {
  try {
    const user = await requireTenantRole('viewer')
    const rows = await listNewForUser(user.activeTenantId, user.user.id, 20)
    return ok({ events: rows.map((row) => toRow(row, row.agentName)) })
  } catch (error) {
    if (isPrismaMissingTable(error, 'inbound_mail_events')) return ok({ events: [] as InboundMailEventRow[] })
    return toFail(error, 'Nem sikerült betölteni az új leveleket.')
  }
}

export async function countMyInboundMailAction(): Promise<number> {
  try {
    const user = await requireTenantRole('viewer')
    return await countNewForUser(user.activeTenantId, user.user.id)
  } catch {
    return 0
  }
}
