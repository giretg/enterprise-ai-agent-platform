'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { fail, ok, type ActionResult } from '@/lib/result'

export type HandoffInboxRow = {
  id: string
  title: string
  summary: string
  links: string | null
  projectKey: string
  status: string
  fromAgentName: string
  createdAt: string
}

const handoffIdSchema = z.object({ handoffId: z.string().uuid() })
const decideSchema = handoffIdSchema.extend({ decision: z.enum(['accepted', 'done', 'rejected']) })

function mapError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError) return fail(error.code)
  return fail('schema_mismatch')
}

export async function listHandoffInboxAction(): Promise<ActionResult<{ handoffs: HandoffInboxRow[] }>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const rows = await services.projectWork.handoffs.listOpenForUser(ctx.activeTenantId, ctx.user.id)
    const handoffs = await Promise.all(
      rows.map(async (row) => {
        const from = await services.agentDefinitions.loadAgentDefinition({
          tenantId: ctx.activeTenantId,
          agentId: row.fromAgentId,
        })
        return {
          id: row.id,
          title: row.title,
          summary: row.summary,
          links: row.links,
          projectKey: row.projectKey,
          status: row.status,
          fromAgentName: from?.snapshot.name ?? row.fromAgentId,
          createdAt: row.createdAt.toISOString(),
        }
      }),
    )
    return ok({ handoffs })
  } catch (error) {
    return mapError(error)
  }
}

export async function decideHandoffAction(
  input: z.infer<typeof decideSchema>,
): Promise<ActionResult<{ status: string }>> {
  try {
    const parsed = decideSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const row = await services.projectWork.handoffs.findById(parsed.handoffId)
    if (!row || row.tenantId !== ctx.activeTenantId || row.toUserId !== ctx.user.id) {
      return fail('approver_not_authorized')
    }
    const updated = await services.projectWork.handoffs.decide(parsed.handoffId, parsed.decision, ctx.user.id)
    if (!updated) return fail('invalid_args')
    revalidatePath('/control-plane/operations')
    return ok({ status: updated.status })
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapError(error)
  }
}
