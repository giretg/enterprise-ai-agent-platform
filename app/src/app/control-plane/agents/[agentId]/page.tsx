import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
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
import { listWorkProjectsAction } from '@/app/actions/project-work'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { AgentProjectMemoryBrowser } from '@/app/control-plane/projects/project-memory-panel'
import { assignableConnectorsFromCatalog } from '@/lib/create-agent-wizard'
import {
  isAgentDetailSectionId,
  type AgentDetailSectionId,
} from '@/lib/agent-detail-sections'
import { isSuperadmin } from '@/lib/tenant-policy'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentIdCopyButton } from '@/components/agents/agent-id-copy-button'
import { PublishStaleDraftButton } from '@/components/agents/publish-stale-draft-button'
import { UpdateInstructionForm } from '@/components/agents/update-instruction-form'
import { UpdateMemoryWriteModeForm } from '@/components/agents/update-memory-write-mode-form'
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

const SECTION_DESC_KEYS: Partial<Record<AgentDetailSectionId, string>> = {
  elesites: 'elesitesDesc',
  kapcsolatok: 'kapcsolatokDesc',
  tudasbazis: 'tudasbazisDesc',
  eszkozok: 'eszkozokDesc',
  skillek: 'skillekDesc',
  memoriairas: 'memoriairasDesc',
  hozzaferes: 'hozzaferesDesc',
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>
  searchParams: Promise<{ section?: string }>
}) {
  const { agentId } = await params
  const query = await searchParams
  const initialSection = isAgentDetailSectionId(query.section) ? query.section : undefined

  let ctx
  try {
    ctx = await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) notFound()
    throw error
  }

  const [
    agentRes,
    govRes,
    skillsRes,
    assignableRes,
    kbRes,
    catalogRes,
    kbCatalogRes,
    accessRes,
    publishRes,
    projectsRes,
  ] = await Promise.all([
    getAgent({ id: agentId }),
    getAgentGovernance({ agentId }),
    getAgentSkillsAction(agentId),
    listAssignableSkillsAction(agentId),
    listKbDocuments({ agentId }),
    listConnectorCatalog(),
    listKnowledgeCatalog(),
    listAgentAccess({ agentId }),
    getAgentPublishStatus({ agentId }),
    listWorkProjectsAction(),
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
  const connectorCatalog = catalogRes.success ? catalogRes.data : []
  const catalog = assignableConnectorsFromCatalog(
    connectorCatalog,
    connectors.map((row) => row.connector.id),
  )
  const canManage = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canEditMemory = hasMinimumRole(ctx.activeTenantRole, 'approver')
  const canDelete = isSuperadmin(ctx.platformRoles)
  const projects = projectsRes.success ? projectsRes.data.projects : []
  const projectsError = projectsRes.success ? null : projectsRes.error
  const t = await getTranslations('ControlPlane.agentDetail')
  const sectionLabel = (id: AgentDetailSectionId) => t(`sections.${id}` as 'sections.elesites')
  const sectionDesc = (id: AgentDetailSectionId) => {
    const key = SECTION_DESC_KEYS[id]
    return key ? t(`sections.${key}` as 'sections.elesitesDesc') : undefined
  }

  const sections: Array<{
    id: AgentDetailSectionId
    label: string
    description?: string
    content: React.ReactNode
  }> = [
    {
      id: 'elesites',
      label: sectionLabel('elesites'),
      description: sectionDesc('elesites'),
      content: (
        <PublishAgentDefinitionForm
          agentId={agent.id}
          currentDefinitionId={agent.currentDefinitionVersionId}
          status={agent.status}
          goLive
          canEdit={canManage}
          hasUnpublishedChanges={publishRes.success ? publishRes.data.stale : false}
          publishedVersion={publishRes.success ? publishRes.data.version : null}
        />
      ),
    },
    ...(canManage
      ? [
          {
            id: 'profil' as const,
            label: sectionLabel('profil'),
            content: (
              <Card title={sectionLabel('profil')}>
                <UpdateAgentProfileForm
                  agentId={agent.id}
                  name={agent.name}
                  description={agent.description}
                  bare
                />
              </Card>
            ),
          },
        ]
      : []),
    {
      id: 'munkakor',
      label: sectionLabel('munkakor'),
      content: (
        <Card title={sectionLabel('munkakor')}>
          <UpdateInstructionForm agentId={agent.id} roleInstruction={agent.roleInstruction} bare />
        </Card>
      ),
    },
    {
      id: 'kapcsolatok',
      label: sectionLabel('kapcsolatok'),
      description: sectionDesc('kapcsolatok'),
      content: (
        <AgentConnectorBindingForm
          agentId={agent.id}
          bindings={connectors}
          catalog={catalog}
          catalogDetails={connectorCatalog}
        />
      ),
    },
    {
      id: 'tudasbazis',
      label: sectionLabel('tudasbazis'),
      description: sectionDesc('tudasbazis'),
      content: (
        <AgentKnowledgeBasePanel
          agentId={agent.id}
          documents={kbDocs}
          catalog={kbCatalog}
          canManage={canManage}
        />
      ),
    },
    {
      id: 'eszkozok',
      label: sectionLabel('eszkozok'),
      description: sectionDesc('eszkozok'),
      content: <AgentCapabilitiesPanel agentId={agent.id} currentCapabilities={capabilities} />,
    },
    {
      id: 'skillek',
      label: sectionLabel('skillek'),
      description: sectionDesc('skillek'),
      content: (
        <AgentSkillsPanel
          agentId={agent.id}
          assigned={skills}
          assignable={assignable}
          pendingSkills={pendingSkills}
          loadError={assignableError}
          canEdit={canManage}
          isAdmin={canManage}
        />
      ),
    },
    {
      id: 'memoriairas',
      label: sectionLabel('memoriairas'),
      description: sectionDesc('memoriairas'),
      content: (
        <div className="space-y-4">
          <Card title={sectionLabel('memoriairas')}>
            <UpdateMemoryWriteModeForm
              agentId={agent.id}
              memoryWriteMode={agent.memoryWriteMode}
              canEdit={canManage}
            />
          </Card>
          <Card title={t('projectMemory')}>
            <AgentProjectMemoryBrowser
              agentId={agent.id}
              agentName={agent.name}
              projects={projects}
              canEdit={canEditMemory}
              initialError={projectsError}
            />
          </Card>
        </div>
      ),
    },
    ...(canManage && accessUsers
      ? [
          {
            id: 'hozzaferes' as const,
            label: sectionLabel('hozzaferes'),
            description: sectionDesc('hozzaferes'),
            content: <AgentAccessPanel agentId={agent.id} users={accessUsers} />,
          },
        ]
      : []),
  ]

  return (
    <div className="space-y-6">
      <Link
        href="/control-plane/agents"
        className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
      >
        {t('back')}
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
          <h1 className="mt-1 font-display text-3xl font-semibold">{agent.name}</h1>
          {agent.description ? (
            <p className="mt-1 text-ink-soft">{agent.description}</p>
          ) : null}
          <p className="mt-1 text-ink-soft">{agent.status}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <AgentIdCopyButton agentId={agent.id} />
            {canManage && publishRes.success && publishRes.data.stale ? (
              <PublishStaleDraftButton
                agentId={agent.id}
                publishedVersion={publishRes.data.version}
              />
            ) : null}
          </div>
        </div>
        {canDelete ? <DeleteAgentButton agentId={agent.id} agentName={agent.name} /> : null}
      </div>

      <p className="max-w-2xl text-sm text-ink-soft">{t('pickTopic')}</p>

      <SettingsSectionShell
        ariaLabel={t('aria')}
        navHeading={t('navHeading')}
        initialId={initialSection}
        sections={sections}
      />
    </div>
  )
}
