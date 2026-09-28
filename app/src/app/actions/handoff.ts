'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { fail, ok, type ActionResult } from '@/lib/result'
import { isPrismaMissingTable } from '@/lib/prisma-table-missing'

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
  if (isPrismaMissingTable(error, 'handoffs')) return fail('handoffs_unavailable')
  return fail('schema_mismatch')
}

async function fromAgentNames(tenantId: string, fromAgentIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(fromAgentIds)]
  const agents = await Promise.all(
    unique.map((agentId) => repositories.agents.findById(agentId, tenantId)),
  )
  return new Map(unique.map((agentId, index) => [agentId, agents[index]?.name ?? agentId]))
}

export async function listHandoffInboxAction(): Promise<ActionResult<{ handoffs: HandoffInboxRow[] }>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const rows = await services.projectWork.handoffs.listOpenForUser(ctx.activeTenantId, ctx.user.id)
    const names = await fromAgentNames(
      ctx.activeTenantId,
      rows.map((row) => row.fromAgentId),
    )
    const handoffs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      links: row.links,
      projectKey: row.projectKey,
      status: row.status,
      fromAgentName: names.get(row.fromAgentId) ?? row.fromAgentId,
      createdAt: row.createdAt.toISOString(),
    }))
    return ok({ handoffs })
  } catch (error) {
    if (isPrismaMissingTable(error, 'handoffs')) {
      return ok({ handoffs: [] })
    }
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
    if (row.status !== 'open' && row.status !== 'accepted') return fail('approval_already_decided')
    const updated = await services.projectWork.handoffs.decide({
      id: parsed.handoffId,
      expectedStatus: row.status,
      status: parsed.decision,
      decidedById: ctx.user.id,
    })
    if (!updated) return fail('approval_already_decided')
    revalidatePath('/control-plane/operations')
    return ok({ status: updated.status })
  } catch (error) {
    if (error instanceof z.ZodError) return fail('invalid_args')
    return mapError(error)
  }
}
