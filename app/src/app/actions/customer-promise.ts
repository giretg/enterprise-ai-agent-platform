'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { hasMinimumRole } from '@/lib/iam-policy'
import { fail, ok, type ActionResult } from '@/lib/result'

type Status = 'open' | 'claimed' | 'fulfilled' | 'cancelled' | 'missed'
export type CustomerPromiseRow = {
  id: string
  agentId: string
  title: string
  commitment: string
  customerName: string | null
  customerEmail: string | null
  agentName: string
  ownerName: string
  dueAt: string
  timezone: string
  status: Status
  displayStatus: Status | 'overdue'
  resolvedNote: string | null
  canResolve: boolean
}

function mapError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError) return fail(error.code)
  return fail('unavailable')
}

export async function listCustomerPromisesAction(agentId?: string, history = false, page = 0): Promise<ActionResult<{ promises: CustomerPromiseRow[]; hasMore: boolean }>> {
  try {
    if (agentId !== undefined && !z.string().uuid().safeParse(agentId).success) return fail('invalid_args')
    if (!Number.isSafeInteger(page) || page < 0 || page > Math.floor(Number.MAX_SAFE_INTEGER / 50)) return fail('invalid_args')
    const ctx = await requireTenantRole('viewer')
    const allowTenantScope = hasMinimumRole(ctx.activeTenantRole, 'approver')
    const fetched = await services.customerPromises.list({
      tenantId: ctx.activeTenantId,
      ownerUserId: allowTenantScope ? undefined : ctx.user.id,
      agentId,
      status: history ? undefined : 'active',
      limit: 51,
      offset: page * 50,
    })
    const rows = fetched.slice(0, 50)
    const agentIds = [...new Set(rows.map((row) => row.agentId))]
    const [agents, owners] = await Promise.all([
      Promise.all(agentIds.map((id) => repositories.agents.findById(id, ctx.activeTenantId))),
      repositories.users.findManyByIds([...new Set(rows.map((row) => row.ownerUserId))]),
    ])
    const agentNames = new Map(agentIds.map((id, index) => [id, agents[index]?.name ?? id]))
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]))
    return ok({ hasMore: fetched.length > 50, promises: rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      title: row.title,
      commitment: row.commitment,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      agentName: agentNames.get(row.agentId) ?? row.agentId,
      ownerName: ownerNames.get(row.ownerUserId) ?? row.ownerUserId,
      dueAt: row.dueAt.toISOString(),
      timezone: row.timezone,
      status: row.status,
      displayStatus: row.overdue ? 'overdue' : row.status,
      resolvedNote: row.resolvedNote,
      canResolve: (row.status === 'open' || row.status === 'claimed') && (allowTenantScope || row.ownerUserId === ctx.user.id),
    })) })
  } catch (error) {
    return mapError(error)
  }
}

export async function countUrgentCustomerPromisesAction(): Promise<number> {
  try {
    const ctx = await requireTenantRole('viewer')
    return await services.customerPromises.countUrgentForUser(ctx.activeTenantId, ctx.user.id)
  } catch {
    return 0
  }
}

const resolveSchema = z.object({ promiseId: z.string().uuid(), status: z.enum(['fulfilled', 'cancelled']), note: z.string().trim().max(500).optional() }).strict()

export async function resolveCustomerPromiseAction(input: z.infer<typeof resolveSchema>): Promise<ActionResult<{ status: string }>> {
  try {
    const parsed = resolveSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.customerPromises.resolve({
      ...parsed,
      tenantId: ctx.activeTenantId,
      actorUserId: ctx.user.id,
      allowTenantScope: hasMinimumRole(ctx.activeTenantRole, 'approver'),
    })
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane', 'layout')
    return ok({ status: result.row.status })
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapError(error)
  }
}
