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
import {
  AGENT_DETAIL_SECTION_LABELS,
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

const SECTION_DESCRIPTIONS: Partial<Record<AgentDetailSectionId, string>> = {
  elesites: 'Melyik definíció fut élesben, és van-e még nem publikált változás.',
  kapcsolatok: 'API-k, levelezés, Drive és egyéb külső rendszerek — olvasási vagy írási módban.',
  tudasbazis: 'Dokumentumok és katalógus, amiből a munkatárs dolgozik.',
  eszkozok: 'Milyen platform-eszközöket használhat a publikált definíció.',
  skillek: 'Előre összeállított utasítás-csomagok ehhez az agenthez.',
  memoriairas: 'A projektmemóriát jóváhagyással vagy közvetlenül írja. A betanított szabályt ez nem nyitja ki.',
  hozzaferes: 'Ki indíthat chatet vagy ticketet ezzel a munkatárssal.',
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
  const connectorCatalog = catalogRes.success ? catalogRes.data : []
  const catalog = assignableConnectorsFromCatalog(
    connectorCatalog,
    connectors.map((row) => row.connector.id),
  )
  const canManage = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canDelete = isSuperadmin(ctx.platformRoles)

  const sections: Array<{
    id: AgentDetailSectionId
    label: string
    description?: string
    content: React.ReactNode
  }> = [
    {
      id: 'elesites',
      label: AGENT_DETAIL_SECTION_LABELS.elesites,
      description: SECTION_DESCRIPTIONS.elesites,
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
            label: AGENT_DETAIL_SECTION_LABELS.profil,
            content: (
              <Card title={AGENT_DETAIL_SECTION_LABELS.profil}>
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
      label: AGENT_DETAIL_SECTION_LABELS.munkakor,
      content: (
        <Card title={AGENT_DETAIL_SECTION_LABELS.munkakor}>
          <UpdateInstructionForm agentId={agent.id} roleInstruction={agent.roleInstruction} bare />
        </Card>
      ),
    },
    {
      id: 'kapcsolatok',
      label: AGENT_DETAIL_SECTION_LABELS.kapcsolatok,
      description: SECTION_DESCRIPTIONS.kapcsolatok,
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
      label: AGENT_DETAIL_SECTION_LABELS.tudasbazis,
      description: SECTION_DESCRIPTIONS.tudasbazis,
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
      label: AGENT_DETAIL_SECTION_LABELS.eszkozok,
      description: SECTION_DESCRIPTIONS.eszkozok,
      content: <AgentCapabilitiesPanel agentId={agent.id} currentCapabilities={capabilities} />,
    },
    {
      id: 'skillek',
      label: AGENT_DETAIL_SECTION_LABELS.skillek,
      description: SECTION_DESCRIPTIONS.skillek,
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
      label: AGENT_DETAIL_SECTION_LABELS.memoriairas,
      description: SECTION_DESCRIPTIONS.memoriairas,
      content: (
        <Card title={AGENT_DETAIL_SECTION_LABELS.memoriairas}>
          <UpdateMemoryWriteModeForm
            agentId={agent.id}
            memoryWriteMode={agent.memoryWriteMode}
            canEdit={canManage}
          />
        </Card>
      ),
    },
    ...(canManage && accessUsers
      ? [
          {
            id: 'hozzaferes' as const,
            label: AGENT_DETAIL_SECTION_LABELS.hozzaferes,
            description: SECTION_DESCRIPTIONS.hozzaferes,
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

      <p className="max-w-2xl text-sm text-ink-soft">
        Válassz témát a bal oldalon — egyszerre egy terület jelenik meg, így nem kell végiggörgetni
        az egész adatlapot.
      </p>

      <SettingsSectionShell
        ariaLabel="Agent beállítások"
        navHeading="Beállítások"
        initialId={initialSection}
        sections={sections}
      />
    </div>
  )
}
