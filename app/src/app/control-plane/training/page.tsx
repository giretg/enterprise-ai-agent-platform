import { redirect } from 'next/navigation'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'
import {
  agentWorkspacePath,
  parseAgentWorkspacePath,
} from '@/lib/agent-workspace-routes'

/** Régi mély-link: a tanítás az adott agent munkaterületén él. */
export default async function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string }>
}) {
  const { agentId: queryAgentId } = await searchParams
  if (queryAgentId) {
    redirect(agentWorkspacePath(queryAgentId, 'training'))
  }

  const fallback = await resolveDefaultAgentWorkspacePath()
  const parsed = parseAgentWorkspacePath(fallback)
  redirect(parsed ? agentWorkspacePath(parsed.agentId, 'training') : fallback)
}
