'use server'

import type { Prisma } from '@prisma/client'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import {
  createMonitorSchema,
  updateMonitorSchema,
  monitorIdSchema,
  monitorDryRunSchema,
  setMonitorControlsSchema,
} from '@/lib/validators/actions'

export async function listMonitors() {
  try {
    const user = await requireTenantRole('viewer')
    const monitors = await services.monitors.list(user.activeTenantId)
    return ok(monitors)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a monitorokat')
  }
}

export async function getMonitor(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = monitorIdSchema.parse(input)
    const monitor = await services.monitors.getById(parsed.id, user.activeTenantId)
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a monitort')
  }
}

export async function createMonitor(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createMonitorSchema.parse(input)
    await assertEscalationAgentReachable(parsed.escalateAgentId, user.activeTenantId)
    const monitor = await repositories.monitors.create({
      tenantId: user.activeTenantId,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description ?? null,
      intervalSeconds: parsed.intervalSeconds,
      nextSweepAt: new Date(),
      collectorConfig: (parsed.collectorConfig ?? {}) as Prisma.InputJsonValue,
      filterConfig: (parsed.filterConfig ?? {}) as Prisma.InputJsonValue,
      cooldownSeconds: parsed.cooldownSeconds,
      dedupKeyTemplate: parsed.dedupKeyTemplate ?? null,
      escalateAgentId: parsed.escalateAgentId ?? null,
      perRunBudgetUsd: parsed.perRunBudgetUsd ?? null,
      notifyChannel: parsed.notifyChannel ?? null,
      createdById: user.user.id,
    })
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a monitort')
  }
}

export async function updateMonitor(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateMonitorSchema.parse(input)
    const { id, collectorConfig, filterConfig, ...rest } = parsed
    await assertEscalationAgentReachable(rest.escalateAgentId, user.activeTenantId)
    const monitor = await services.monitors.update(id, user.activeTenantId, {
      ...rest,
      ...(collectorConfig !== undefined ? { collectorConfig: collectorConfig as Prisma.InputJsonValue } : {}),
      ...(filterConfig !== undefined ? { filterConfig: filterConfig as Prisma.InputJsonValue } : {}),
    })
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a monitort')
  }
}

export async function pauseMonitor(input: { id: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = monitorIdSchema.parse(input)
    const monitor = await services.monitors.update(parsed.id, user.activeTenantId, { status: 'paused' })
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült szüneteltetni a monitort')
  }
}

export async function resumeMonitor(input: { id: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = monitorIdSchema.parse(input)
    const monitor = await services.monitors.update(parsed.id, user.activeTenantId, { status: 'active' })
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült folytatni a monitort')
  }
}

export async function revokeMonitor(input: { id: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = monitorIdSchema.parse(input)
    const monitor = await services.monitors.revoke(parsed.id, user.activeTenantId)
    return ok(monitor)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült visszavonni a monitort')
  }
}

export async function getMonitorRuns(input: { id: string; limit?: number }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = monitorIdSchema.parse(input)
    const runs = await services.monitors.listRuns(parsed.id, user.activeTenantId, input.limit ?? 20)
    return ok(runs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a futásnaplót')
  }
}

export async function getMonitorSignals(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = monitorIdSchema.parse(input)
    const signals = await services.monitors.listSignals(parsed.id, user.activeTenantId)
    return ok(signals)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a jeleket')
  }
}

export async function dryRunMonitor(input: { id: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = monitorDryRunSchema.parse(input)
    const result = await services.monitors.dryRun(parsed.id, user.activeTenantId)
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült elvégezni a próba-futást')
  }
}

export async function getMonitorControls() {
  try {
    await requireTenantRole('viewer')
    const controls = await services.platformSettings.getMonitorControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a monitor vezérlőit')
  }
}

export async function setMonitorControls(input: unknown) {
  try {
    const user = (await requirePlatformRole('superadmin')).user
    const parsed = setMonitorControlsSchema.parse(input)
    const controls = await services.platformSettings.setMonitorControls(parsed, user.id)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a monitor vezérlőit')
  }
}

/** A shared agent elérhető, más tenant saját agentje sosem használható eszkalációra. */
async function assertEscalationAgentReachable(agentId: string | null | undefined, tenantId: string) {
  if (!agentId) return
  const agent = await repositories.agents.findById(agentId)
  if (!agent || !isAgentReachableFromTenant(agent.tenantId, tenantId)) {
    throw new Error('Agent not found')
  }
}
