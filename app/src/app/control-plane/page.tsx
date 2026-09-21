import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/auth'
import {
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
} from '@/lib/control-plane-entry'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'
import { firstRunGetStartedPath, MCP_SETUP_SEEN_COOKIE } from '@/lib/mcp-client-setup'

/** Gyökér: új user → MCP landing; különben tenant-home / első munkatárs / pending. */
export default async function ControlPlaneRootPage() {
  const me = await getCurrentUser()
  if (me && (me.status !== 'active' || !me.role)) {
    redirect(CONTROL_PLANE_PENDING_PATH)
  }
  const path = await resolveDefaultAgentWorkspacePath()
  if (path === CONTROL_PLANE_PENDING_PATH || path === CONTROL_PLANE_PLATFORM_HOME || path === '/sign-in') {
    redirect(path)
  }
  const firstRun = firstRunGetStartedPath((await cookies()).get(MCP_SETUP_SEEN_COOKIE)?.value)
  if (firstRun) redirect(firstRun)
  redirect(path)
}
