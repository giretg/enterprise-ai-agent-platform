import { redirect } from 'next/navigation'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'

/** Régi mély-link — a dashboard oldal megszűnt. */
export default async function DashboardLegacyRedirect() {
  redirect(await resolveDefaultAgentWorkspacePath())
}
