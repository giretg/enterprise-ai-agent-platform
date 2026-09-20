import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/auth/types'
import {
  getAgent,
  getAgentGovernance,
  getAgentPublishStatus,
  listAgentAccess,
  listKbDocuments,
  listKnowledgeCatalog,
} from '@/app/actions/platform'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { assignableConnectorsFromCatalog } from '@/lib/create-agent-wizard'
import { isSuperadmin } from '@/lib/tenant-policy'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentIdCopyButton } from '@/components/agents/agent-id-copy-button'
import { UpdateInstructionForm } from '@/components/agents/update-instruction-form'
import { UpdateAgentProfileForm } from '@/components/agents/update-agent-profile-form'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import { PublishAgentDefinitionForm } from '@/components/agents/publish-agent-definition-form'
import { AgentConnectorBindingForm } from '@/components/agents/agent-connector-binding-form'
import { AgentKnowledgeBasePanel } from '@/components/agents/agent-knowledge-base-panel'
import { AgentAccessPanel } from '@/components/agents/agent-access-panel'
import { DeleteAgentButton } from '@/components/agents/delete-agent-button'
import { Card } from '@/components/ui/shell'

export const dynamic = 'force-dynamic'

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  let ctx
  try {
    ctx = await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) notFound()
    throw error
  }

  const [agentRes, govRes, skillsRes, assignableRes, kbRes, catalogRes, kbCatalogRes, accessRes, publishRes] =
    await Promise.all([
      getAgent({ id: agentId }),
      getAgentGovernance({ agentId }),
      getAgentSkillsAction(agentId),
      listAssignableSkillsAction(agentId),
      listKbDocuments({ agentId }),
      listConnectorCatalog(),
      listKnowledgeCatalog(),
      listAgentAccess({ agentId }),
      getAgentPublishStatus({ agentId }),
    ])
  if (!agentRes.success || !agentRes.data) notFound()
  const agent = agentRes.data
  const capabilities = govRes.success ? govRes.data.capabilities : []
  const connectors = govRes.success ? govRes.data.connectors : []
  const skills = skillsRes.success ? skillsRes.data : []
  const assignable = assignableRes.success ? assignableRes.data.assignable : []
  const pendingSkills = assignableRes.success ? assignableRes.data.pending : []
  const assignableError = assignableRes.success ? null : assignableRes.error
  const kbDocs = kbRes.success ? kbRes.data : []
  const kbCatalog = kbCatalogRes.success ? kbCatalogRes.data : []
  const accessUsers = accessRes.success ? accessRes.data.users : null
  const catalog = assignableConnectorsFromCatalog(
    catalogRes.success ? catalogRes.data : [],
    connectors.map((row) => row.connector.id),
  )
  const canManage = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canDelete = isSuperadmin(ctx.platformRoles)

  return (
    <div className="space-y-6">
      <Link
        href="/control-plane/agents"
        className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
      >
        ← Vissza a munkatársakhoz
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Agent</p>
          <h1 className="mt-1 font-display text-3xl font-semibold">{agent.name}</h1>
          {agent.description ? (
            <p className="mt-1 text-ink-soft">{agent.description}</p>
          ) : null}
          <p className="mt-1 text-ink-soft">{agent.status}</p>
          <AgentIdCopyButton agentId={agent.id} />
        </div>
        {canDelete ? <DeleteAgentButton agentId={agent.id} agentName={agent.name} /> : null}
      </div>

      {canManage ? (
        <Card title="Név és bemutatkozás">
          <UpdateAgentProfileForm
            agentId={agent.id}
            name={agent.name}
            description={agent.description}
            bare
          />
        </Card>
      ) : null}

      <PublishAgentDefinitionForm
        agentId={agent.id}
        currentDefinitionId={agent.currentDefinitionVersionId}
        status={agent.status}
        goLive
        canEdit={canManage}
        hasUnpublishedChanges={publishRes.success ? publishRes.data.stale : false}
        publishedVersion={publishRes.success ? publishRes.data.version : null}
      />
      <Card title="Munkakör">
        <UpdateInstructionForm agentId={agent.id} roleInstruction={agent.roleInstruction} bare />
      </Card>
      <AgentConnectorBindingForm agentId={agent.id} bindings={connectors} catalog={catalog} />
      <AgentKnowledgeBasePanel
        agentId={agent.id}
        documents={kbDocs}
        catalog={kbCatalog}
        canManage={canManage}
      />
      <AgentCapabilitiesPanel agentId={agent.id} currentCapabilities={capabilities} />
      <AgentSkillsPanel
        agentId={agent.id}
        assigned={skills}
        assignable={assignable}
        pendingSkills={pendingSkills}
        loadError={assignableError}
        canEdit={canManage}
        isAdmin={canManage}
      />
      {canManage && accessUsers ? (
        <AgentAccessPanel agentId={agent.id} users={accessUsers} />
      ) : null}
    </div>
  )
}
