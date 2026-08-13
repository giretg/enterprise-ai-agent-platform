'use server'

import { agentIdSchema } from '@/lib/validators/actions'
import { fail, ok } from '@/lib/result'
import { getAuthContext } from '@/auth/context'
import { requireTenantRoleFromContext, TenantAuthError } from '@/auth/tenant-context'
import { isAgentDetailLoadError } from '@/lib/agent-detail-access'
import { loadAgentDetailPageData } from '@/lib/agent-detail-page-data'

export async function getAgentDetailPageData(input: { id: string }) {
  try {
    const ctx = await getAuthContext()
    const tenantCtx = await requireTenantRoleFromContext(ctx, 'viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.id })
    const data = await loadAgentDetailPageData(agentId, tenantCtx)
    return ok(data)
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return fail(e.code)
    }
    if (isAgentDetailLoadError(e)) {
      return fail(e.code)
    }
    return fail(e instanceof Error ? e.message : 'Failed to load agent detail page')
  }
}
