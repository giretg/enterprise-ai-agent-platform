'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { isSuperadmin } from '@/lib/tenant-policy'

function actorOf(user: Awaited<ReturnType<typeof requireTenantRole>>): ProvisioningActor {
  return {
    type: 'user',
    userId: user.user.id,
    role: user.activeTenantRole,
    tenantId: user.activeTenantId,
    canManagePlatformConnectors: isSuperadmin(user.platformRoles),
  }
}

function toFail(e: unknown, fallback: string) {
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

export async function listConnectorCatalog() {
  try {
    const user = await requireTenantRole('viewer')
    const catalog = await services.provisioning.listCatalog(actorOf(user))
    return ok(catalog)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a connector-katalógust')
  }
}

export async function listProvisioningAssignableAgents() {
  try {
    const user = await requireTenantRole('viewer')
    const agents = await repositories.agents.findMany({ tenantId: user.activeTenantId })
    return ok(
      agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name })),
    )
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az agenteket')
  }
}

export async function assignConnectorToAgent(input: {
  connectorId: string
  agentId: string
  accessMode?: 'read' | 'write'
  apiKey?: string
  reason?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        connectorId: z.string().uuid(),
        agentId: z.string().uuid(),
        accessMode: z.enum(['read', 'write']).default('read'),
        apiKey: z.string().optional(),
      })
      .parse(input)
    await services.provisioning.assignConnectorToAgent(parsed, actorOf(user))
    return ok({ assigned: true })
  } catch (e) {
    return toFail(e, 'A konnektor hozzárendelése nem sikerült')
  }
}

export async function unassignConnectorFromAgent(input: {
  connectorId: string
  agentId: string
  reason?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({ connectorId: z.string().uuid(), agentId: z.string().uuid() })
      .parse(input)
    await services.provisioning.unassignConnectorFromAgent(parsed, actorOf(user))
    return ok({ unassigned: true })
  } catch (e) {
    return toFail(e, 'A konnektor leválasztása nem sikerült')
  }
}
