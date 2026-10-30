'use server'

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import { assignConnectorToAgent } from '@/app/actions/provisioning'
import { services } from '@/domain/gateway-services'
import { mailboxConnectorInfo, suggestMailboxUsername } from '@/domain/agent-mailbox/agent-mailbox'
import { listTenantMailboxes, syncAgentMailDisplayName, type TenantMailboxRow } from '@/lib/agent-mailbox'
import {
  AgentMailApiError,
  agentMailApiBase,
  createAgentMailInbox,
  loadAgentMailOrgKey,
  loadAgentMailRegion,
} from '@/lib/agentmail'
import { auditAgentMail, connectAgentMailInbox } from '@/lib/agentmail-connect'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'

export type AgentMailboxSettings = {
  agentId: string
  agentName: string
  /** Az érvényes saját cím (aktív, `write` módban kötött postafiók). */
  primaryConnectorId: string | null
  primaryAddress: string | null
  /** A korábbi saját cím megszűnt — figyelmeztetés. */
  lostPrimaryAddress: string | null
  signature: string
  displayName: string
  mailboxes: TenantMailboxRow[]
  agentMailConfigured: boolean
  suggestedUsername: string
}

const agentIdInput = z.object({ agentId: z.string().uuid() })

const ALREADY_PRIMARY = (agentName: string) =>
  `Ez a postafiók már ${agentName} saját címe. Egy postafiók csak egy munkatárs saját címe lehet — válassz másikat, vagy előbb ${agentName} beállításainál vedd el tőle.`

async function audit(
  user: Awaited<ReturnType<typeof requireTenantRole>>,
  action: string,
  agentId: string,
  metadata: Record<string, unknown>,
) {
  await services.audit.append({
    actorType: 'human',
    actorId: user.user.id,
    agentVersion: null,
    action,
    targetType: 'agent',
    targetId: agentId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: 'updated',
    metadata,
    tenantId: user.activeTenantId,
  })
}

function toFail(e: unknown, fallback: string) {
  if (e instanceof AgentMailApiError) {
    if (e.status === 401 || e.status === 403) return fail('Az AgentMail elutasította a kérést — az adminnak ellenőriznie kell a postafiók-beállításokat.')
    if (e.status === 409) return fail('Ez a cím már foglalt. Adj meg másik felhasználónevet.')
    return fail(`AgentMail: ${e.message}`)
  }
  return fail(e instanceof Error ? e.message : fallback)
}

export async function getAgentMailboxSettings(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { agentId } = agentIdInput.parse(input)
    const tenantId = user.activeTenantId
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true, name: true, mailSignature: true, mailDisplayName: true, primaryMailboxConnectorId: true, primaryMailboxAddress: true },
    })
    if (!agent) return fail('A munkatárs nem található.')
    const [mailboxes, orgKey] = await Promise.all([listTenantMailboxes(tenantId, agentId), loadAgentMailOrgKey(tenantId)])
    const primary = mailboxes.find(
      (row) => row.connectorId === agent.primaryMailboxConnectorId && row.accessMode === 'write',
    )
    return ok<AgentMailboxSettings>({
      agentId,
      agentName: agent.name,
      primaryConnectorId: primary?.connectorId ?? null,
      primaryAddress: primary ? primary.address ?? agent.primaryMailboxAddress : null,
      lostPrimaryAddress: primary ? null : agent.primaryMailboxAddress,
      signature: agent.mailSignature ?? '',
      displayName: agent.mailDisplayName ?? '',
      mailboxes,
      agentMailConfigured: Boolean(orgKey),
      suggestedUsername: suggestMailboxUsername(agent.name),
    })
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az e-mail beállításokat.')
  }
}

/** Saját cím kiválasztása (null = „Nem kell saját cím”). Nem kötött / olvasási postafiókot `write` módban köt. */
export async function setAgentPrimaryMailboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = agentIdInput.extend({ connectorId: z.string().uuid().nullable() }).parse(input)
    const tenantId = user.activeTenantId
    const agent = await prisma.agent.findFirst({ where: { id: parsed.agentId, tenantId }, select: { id: true } })
    if (!agent) return fail('A munkatárs nem található.')

    if (parsed.connectorId === null) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { primaryMailboxConnectorId: null, primaryMailboxAddress: null },
      })
      await audit(user, 'agent.mailbox.primary', agent.id, { connectorId: null })
      return ok({ primaryConnectorId: null, displayNameSynced: true })
    }

    const connector = await prisma.connector.findFirst({
      where: { id: parsed.connectorId, tenantId, lifecycleState: 'active' },
      select: {
        id: true,
        name: true,
        type: true,
        authMode: true,
        config: true,
        agentConnectors: { where: { agentId: agent.id }, select: { accessMode: true } },
        primaryForAgents: { select: { id: true, name: true } },
      },
    })
    const info = connector ? mailboxConnectorInfo(connector) : null
    if (!connector || !info) return fail('Csak a cég egyik aktív postafiókja lehet a munkatárs saját címe.')
    if ((connector.config as { mailbox?: { readOnly?: unknown } } | null)?.mailbox?.readOnly === true) {
      return fail('Ez a postafiók csak olvasásra van bekötve, ezért nem küldhet róla levelet — nem lehet saját cím.')
    }
    const owner = connector.primaryForAgents.find((row) => row.id !== agent.id)
    if (owner) return fail(ALREADY_PRIMARY(owner.name))

    if (connector.agentConnectors[0]?.accessMode !== 'write') {
      const assigned = await assignConnectorToAgent({ connectorId: connector.id, agentId: agent.id, accessMode: 'write' })
      if (!assigned.success) return assigned
    }
    try {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { primaryMailboxConnectorId: connector.id, primaryMailboxAddress: info.address ?? connector.name },
      })
    } catch (e) {
      // Versenyhelyzet: közben egy másik agent lett a tulajdonos (részleges egyedi index).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const other = await prisma.agent.findFirst({
          where: { primaryMailboxConnectorId: connector.id },
          select: { name: true },
        })
        return fail(ALREADY_PRIMARY(other?.name ?? 'egy másik munkatárs'))
      }
      throw e
    }
    await audit(user, 'agent.mailbox.primary', agent.id, { connectorId: connector.id, address: info.address, provider: info.kind })
    const displayNameSynced = await syncAgentMailDisplayName(tenantId, agent.id)
    return ok({ primaryConnectorId: connector.id, displayNameSynced })
  } catch (e) {
    return toFail(e, 'Nem sikerült beállítani a saját címet.')
  }
}

export async function updateAgentMailIdentityAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = agentIdInput
      .extend({
        signature: z.string().max(2000),
        displayName: z.string().trim().max(120),
      })
      .parse(input)
    const result = await prisma.agent.updateMany({
      where: { id: parsed.agentId, tenantId: user.activeTenantId },
      data: {
        mailSignature: parsed.signature.trim() || null,
        mailDisplayName: parsed.displayName || null,
      },
    })
    if (result.count === 0) return fail('A munkatárs nem található.')
    await audit(user, 'agent.mailbox.identity', parsed.agentId, {
      hasSignature: Boolean(parsed.signature.trim()),
      displayNameSet: Boolean(parsed.displayName),
    })
    const displayNameSynced = await syncAgentMailDisplayName(user.activeTenantId, parsed.agentId)
    return ok({ saved: true, displayNameSynced })
  } catch (e) {
    return toFail(e, 'Nem sikerült menteni az aláírást.')
  }
}

/** „Új cím létrehozása”: AgentMail-postafiók → bekötés → `write` hozzárendelés → saját cím. */
export async function createAgentPrimaryMailboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = agentIdInput
      .extend({
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'A felhasználónév csak kisbetűt, számot, pontot és kötőjelet tartalmazhat.'),
        domain: z.string().trim().toLowerCase().max(253).optional().or(z.literal('')),
      })
      .parse(input)
    const tenantId = user.activeTenantId
    const agent = await prisma.agent.findFirst({
      where: { id: parsed.agentId, tenantId },
      select: { id: true, name: true, mailDisplayName: true },
    })
    if (!agent) return fail('A munkatárs nem található.')
    const [orgKey, region] = await Promise.all([loadAgentMailOrgKey(tenantId), loadAgentMailRegion(tenantId)])
    if (!orgKey) return fail('Az adminnak előbb be kell állítania a postafiókokat (Postafiókok oldal).')

    const inbox = await createAgentMailInbox(
      orgKey,
      {
        username: parsed.username,
        domain: parsed.domain || undefined,
        displayName: agent.mailDisplayName?.trim() || agent.name,
      },
      agentMailApiBase(region),
    )
    await auditAgentMail(user, 'connector.agentmail.inbox.create', null, { region, inboxEmail: inbox.email, agentId: agent.id })
    const connectorId = await connectAgentMailInbox(user, inbox, orgKey, region)
    const selected = await setAgentPrimaryMailboxAction({ agentId: agent.id, connectorId })
    if (!selected.success) return selected
    return ok({ connectorId, email: inbox.email })
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a postafiókot.')
  }
}
