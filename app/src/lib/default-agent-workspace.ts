import { notFound, redirect } from 'next/navigation'
import { listAgents } from '@/app/actions/platform'
import { getAuthContext } from '@/auth/context'
import { TenantAuthError, requireTenantRole } from '@/auth/tenant-context'
import { agentWorkspacePath } from '@/lib/agent-workspace-routes'
import {
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  homePathForAuthContext,
} from '@/lib/control-plane-entry'

export {
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  homePathForAuthContext,
} from '@/lib/control-plane-entry'

/**
 * Alapértelmezett munkaterület belépéskor: van-e tenant, van-e munkatárs.
 * Chat/conversation a Phase 0 cut után nem része a target graphnak.
 */
export async function resolveDefaultAgentWorkspacePath(): Promise<string> {
  const ctx = await getAuthContext()
  const fixed = homePathForAuthContext(ctx)
  if (fixed) return fixed

  const agentsRes = await listAgents({ limit: 50 })
  if (agentsRes.success && agentsRes.data.length > 0) {
    const agent = agentsRes.data.find((row) => row.status !== 'retired') ?? agentsRes.data[0]
    if (agent) return agentWorkspacePath(agent.id)
  }

  return DEFAULT_AGENT_WORKSPACE_FALLBACK
}

/** Tenant-viewer kapu oldalakon: hiányzó kontextus → pending/platform, ne nyers hiba. */
export async function requireControlPlaneTenantViewer() {
  try {
    return await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === 'NO_USER' || error.code === 'NO_TENANT') {
        redirect(await resolveDefaultAgentWorkspacePath())
      }
      notFound()
    }
    throw error
  }
}
