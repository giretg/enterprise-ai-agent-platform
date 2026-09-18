'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { fail, ok, type ActionResult } from '@/lib/result'
import type { GatewayOperationView } from '@/domain/gateway-operation'
import type { PendingOperationRow } from '@/app/control-plane/operations/types'

const operationIdSchema = z.object({
  operationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
})

function actorFrom(ctx: { user: { id: string }; activeTenantId: string; activeTenantRole: string; assumed: boolean }) {
  return {
    userId: ctx.user.id,
    tenantId: ctx.activeTenantId,
    role: ctx.activeTenantRole,
    assumed: ctx.assumed,
  }
}

function mapAuthError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError && error.code === 'INSUFFICIENT_ROLE') {
    return fail('approver_not_authorized')
  }
  if (error instanceof TenantAuthError) return fail(error.code)
  throw error
}

export async function listPendingGatewayOperationsAction(): Promise<
  ActionResult<{ operations: PendingOperationRow[] }>
> {
  try {
    const ctx = await requireTenantRole('approver')
    const pending = await services.gatewayOperations.listPending({ tenantId: ctx.activeTenantId })
    const operations = await Promise.all(
      pending.map(async (row) => {
        const [user, agent] = await Promise.all([
          repositories.users.findById(row.principalUserId),
          repositories.agents.findById(row.agentId, ctx.activeTenantId),
        ])
        return {
          ...row,
          requesterName: user?.name || user?.email || row.principalUserId,
          agentName: agent?.name || row.agentId,
        }
      }),
    )
    return ok({ operations })
  } catch (error) {
    return mapAuthError(error)
  }
}

export async function approveGatewayOperationAction(
  input: z.infer<typeof operationIdSchema>,
): Promise<ActionResult<GatewayOperationView>> {
  try {
    const parsed = operationIdSchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const result = await services.gatewayOperations.approve({
      tenantId: ctx.activeTenantId,
      operationId: parsed.operationId,
      actor: actorFrom(ctx),
      reason: parsed.reason,
    })
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/operations')
    return ok(result.view)
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapAuthError(error)
  }
}

export async function rejectGatewayOperationAction(
  input: z.infer<typeof operationIdSchema>,
): Promise<ActionResult<GatewayOperationView>> {
  try {
    const parsed = operationIdSchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const result = await services.gatewayOperations.reject({
      tenantId: ctx.activeTenantId,
      operationId: parsed.operationId,
      actor: actorFrom(ctx),
      reason: parsed.reason,
    })
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/operations')
    return ok(result.view)
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapAuthError(error)
  }
}
