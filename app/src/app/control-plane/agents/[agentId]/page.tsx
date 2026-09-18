import { notFound } from 'next/navigation'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { getAgent, getAgentGovernance } from '@/app/actions/platform'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentIdCopyButton } from '@/components/agents/agent-id-copy-button'
import { UpdateInstructionForm } from '@/components/agents/update-instruction-form'
import { OperatorVisibilityForm } from '@/components/agents/operator-visibility-form'
import { OperatorSkillManagementForm } from '@/components/agents/operator-skill-management-form'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import { AgentLifecycleControls } from '@/components/agents/agent-lifecycle-controls'
import { Card } from '@/components/ui/shell'
import { personaFor, humanStatus } from '@/lib/agent-persona'

export const dynamic = 'force-dynamic'

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  try {
    await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) notFound()
    throw error
  }

  const [agentRes, govRes, skillsRes, assignableRes] = await Promise.all([
    getAgent({ id: agentId }),
    getAgentGovernance({ agentId }),
    getAgentSkillsAction(agentId),
    listAssignableSkillsAction(agentId),
  ])
  if (!agentRes.success || !agentRes.data) notFound()
  const agent = agentRes.data
  const persona = personaFor(agent.name, agent)
  const capabilities = govRes.success ? govRes.data.capabilities : []
  const skills = skillsRes.success ? skillsRes.data : []
  const assignable = assignableRes.success ? assignableRes.data : []
  const status = humanStatus(agent.status)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Agent</p>
          <h1 className="mt-1 font-display text-3xl font-semibold">{persona.nickname || agent.name}</h1>
          <p className="mt-1 text-ink-soft">{status.label}</p>
          <AgentIdCopyButton agentId={agent.id} />
        </div>
        <AgentLifecycleControls agentId={agent.id} status={agent.status} />
      </div>

      <Card title="Munkakör">
        <UpdateInstructionForm
          agentId={agent.id}
          roleInstruction={agent.roleInstruction}
          roleVersion={agent.currentRoleInstructionVersion}
          bare
        />
      </Card>
      <OperatorVisibilityForm agentId={agent.id} hiddenFromOperators={agent.hiddenFromOperators} />
      <OperatorSkillManagementForm
        agentId={agent.id}
        operatorCanManageSkills={agent.operatorCanManageSkills}
      />
      <AgentCapabilitiesPanel
        agentId={agent.id}
        currentCapabilities={capabilities}
        isOrchestrator={agent.role === 'orchestrator'}
      />
      <AgentSkillsPanel agentId={agent.id} assigned={skills} assignable={assignable} />
    </div>
  )
}
