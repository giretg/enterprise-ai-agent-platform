import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
  ONBOARDING_PATH,
} from '@/lib/control-plane-entry'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'
import { firstRunGetStartedPath, MCP_SETUP_SEEN_COOKIE } from '@/lib/mcp-client-setup'

const NON_WORKSPACE_PATHS = new Set([
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
  ONBOARDING_PATH,
  '/sign-in',
])

/** Gyökér: tenant nélkül → onboarding; új user → MCP landing; különben kezdőlap / pending / platform. */
export default async function ControlPlaneRootPage() {
  const path = await resolveDefaultAgentWorkspacePath()
  if (NON_WORKSPACE_PATHS.has(path)) redirect(path)
  const firstRun = firstRunGetStartedPath((await cookies()).get(MCP_SETUP_SEEN_COOKIE)?.value)
  if (firstRun) redirect(firstRun)
  redirect(path)
}
