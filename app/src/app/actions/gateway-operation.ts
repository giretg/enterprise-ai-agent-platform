'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { canApproveGatewayOperation } from '@/domain/gateway-operation'
import { fail, ok, type ActionResult } from '@/lib/result'
import type {
  GatewayOperationView,
  GatewayPendingOperationRow,
} from '@/domain/gateway-operation'

const operationIdSchema = z.object({
  operationId: z.string().uuid(),
})

const rejectSchema = operationIdSchema.extend({
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

function mapActionError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError && error.code === 'INSUFFICIENT_ROLE') {
    return fail('approver_not_authorized')
  }
  if (error instanceof TenantAuthError) return fail(error.code)
  return fail('schema_mismatch')
}

export async function listPendingGatewayOperationsAction(): Promise<
  ActionResult<{ operations: GatewayPendingOperationRow[] }>
> {
  try {
    const ctx = await requireTenantRole('viewer')
    const actor = actorFrom(ctx)
    // #618 D4: approver/admin sees every pending write, anyone else only their own.
    const operations = await services.gatewayOperations.listPending({
      tenantId: ctx.activeTenantId,
      ...(canApproveGatewayOperation(actor) ? {} : { principalUserId: actor.userId }),
    })
    return ok({ operations })
  } catch (error) {
    return mapActionError(error)
  }
}

export async function approveGatewayOperationAction(
  input: z.infer<typeof operationIdSchema>,
): Promise<ActionResult<GatewayOperationView>> {
  try {
    const parsed = operationIdSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.gatewayOperations.approve({
      tenantId: ctx.activeTenantId,
      operationId: parsed.operationId,
      actor: actorFrom(ctx),
    })
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/operations')
    return ok(result.view)
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapActionError(error)
  }
}

export async function rejectGatewayOperationAction(
  input: z.infer<typeof rejectSchema>,
): Promise<ActionResult<GatewayOperationView>> {
  try {
    const parsed = rejectSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
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
    return mapActionError(error)
  }
}
