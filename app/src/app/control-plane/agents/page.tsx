import { redirect } from 'next/navigation'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'

/** A lista-oldal beolvadt a bal sávba — mély-link kompatibilitás. */
export default async function AgentsIndexRedirect() {
  redirect(await resolveDefaultAgentWorkspacePath())
}
