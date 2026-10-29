import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import {
  getAgent,
  getAgentGovernance,
  getAgentPublishStatus,
  listAgentAccess,
  listAgents,
  listKbDocuments,
  listKnowledgeCatalog,
} from '@/app/actions/platform'
import { getMyGoogleDriveGrantForPicker } from '@/app/actions/connector-grants'
import { listAgentWikiLinksAction } from '@/app/actions/knowledge-wiki'
import { getAgentModelSettings } from '@/app/actions/model-config'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { getHireDraftQuota, getTenantAgentSettings } from '@/app/actions/tenant-agent-settings'
import { CreateAgentWizard } from '@/components/agents/create-agent-wizard'
import { AgentKindChooser } from '@/components/public-assistant/agent-kind-chooser'
import { CreatePublicAssistantForm } from '@/components/public-assistant/create-public-assistant-form'
import { adminPolicyView } from '@/domain/client-policy/admin-policy'
import { prisma } from '@/lib/db'
import {
  assignableConnectorsFromCatalog,
  isCreateAgentWizardStepId,
} from '@/lib/create-agent-wizard'
import { modesFromAgentRow } from '@/lib/write-approval-modes'

export const dynamic = 'force-dynamic'

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ continue?: string; step?: string; type?: string; from?: string }>
}) {
  const ctx = await requireTenantRole('admin')
  const params = await searchParams
  const continueId = params.continue?.trim() || null
  if (!continueId && params.type === 'public') {
    // #1016 D1: „Nyilvános asszisztens készítése ebből” — a forrás csak belső agent lehet.
    const source = params.from
      ? await prisma.agent.findFirst({
          where: { id: params.from, tenantId: ctx.activeTenantId, kind: 'internal' },
          select: { id: true, name: true },
        }).catch(() => null)
      : null
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">Új nyilvános asszisztens</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Ügyfélszolgálati chat a weboldaladra vagy egy megosztható linkre — a látogatóknak nem kell bejelentkezniük.
          </p>
        </div>
        {source ? null : <AgentKindChooser selected="public" />}
        <CreatePublicAssistantForm sourceAgent={source} />
      </div>
    )
  }
  const [agentsRes, catalogRes, agentSettingsRes, quotaRes] = await Promise.all([
    listAgents({ limit: 100 }),
    listConnectorCatalog(),
    getTenantAgentSettings(),
    continueId ? null : getHireDraftQuota(),
  ])
  const cloneableAgents = (agentsRes.success ? agentsRes.data : [])
    .filter((agent) => agent.id !== continueId && agent.kind !== 'public')
    .map((agent) => ({ id: agent.id, name: agent.name }))
  const catalog = catalogRes.success ? catalogRes.data : []

  let continuation = null
  if (continueId) {
    const [
      agentRes,
      govRes,
      skillsRes,
      assignableRes,
      kbRes,
      kbCatalogRes,
      wikiLinksRes,
      accessRes,
      modelRes,
      publishRes,
      drivePickerRes,
    ] = await Promise.all([
      getAgent({ id: continueId }),
      getAgentGovernance({ agentId: continueId }),
      getAgentSkillsAction(continueId),
      listAssignableSkillsAction(continueId),
      listKbDocuments({ agentId: continueId }),
      listKnowledgeCatalog(),
      listAgentWikiLinksAction({ agentId: continueId }),
      listAgentAccess({ agentId: continueId }),
      getAgentModelSettings({ agentId: continueId }),
      getAgentPublishStatus({ agentId: continueId }),
      getMyGoogleDriveGrantForPicker(),
    ])
    if (agentRes.success && agentRes.data) {
      const agent = agentRes.data
      const connectors = govRes.success ? govRes.data.connectors : []
      const hermesPolicy = await prisma.clientPolicy.findUnique({
        where: {
          tenantId_scope_scopeId: { tenantId: ctx.activeTenantId, scope: 'agent', scopeId: agent.id },
        },
      })
      const drivePicker = drivePickerRes.success ? drivePickerRes.data : null
      continuation = {
        agentId: agent.id,
        name: agent.name,
        roleInstruction: agent.roleInstruction,
        description: agent.description,
        avatarUrl: agent.avatarUrl ?? null,
        status: agent.status,
        currentDefinitionVersionId: agent.currentDefinitionVersionId,
        hasUnpublishedChanges: publishRes.success ? publishRes.data.stale : false,
        capabilities: govRes.success ? govRes.data.capabilities : [],
        assignedSkills: skillsRes.success ? skillsRes.data : [],
        assignableSkills: assignableRes.success ? assignableRes.data.assignable : [],
        connectors,
        assignableConnectors: assignableConnectorsFromCatalog(
          catalog,
          connectors.map((row) => row.connector.id),
        ),
        writeModes: modesFromAgentRow(agent),
        approverUserId: agent.approverUserId ?? null,
        outputDriveFolderId: agent.outputDriveFolderId ?? null,
        localRoots: agent.localRoots,
        knowledgeDocuments: kbRes.success ? kbRes.data : [],
        knowledgeCatalog: kbCatalogRes.success ? kbCatalogRes.data : [],
        wikiLinks: wikiLinksRes.success ? wikiLinksRes.data : null,
        accessUsers: accessRes.success ? accessRes.data.users : [],
        currentUserId: ctx.user.id,
        model: modelRes.success ? modelRes.data : null,
        hermesPolicy: adminPolicyView(hermesPolicy),
        drive: {
          grantId: drivePicker?.grantId ?? null,
          grants: drivePicker?.grants ?? [],
          pickerConfigured: drivePicker?.pickerConfigured ?? false,
        },
      }
    }
  }

  const t = await getTranslations('ControlPlane.agentNew')
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('body')}</p>
      </div>
      {continueId ? null : <AgentKindChooser selected="internal" />}
      <CreateAgentWizard
        cloneableAgents={cloneableAgents}
        initialStep={isCreateAgentWizardStepId(params.step) ? params.step : undefined}
        continuation={continuation}
        catalog={continuation ? continuation.assignableConnectors : catalog}
        catalogDetails={catalog}
        autonomyCeiling={agentSettingsRes.success ? agentSettingsRes.data.autonomyCeiling : 'trainee'}
        hireDraftQuota={quotaRes?.success ? { limit: quotaRes.data.limit, remaining: quotaRes.data.remaining } : null}
      />
    </div>
  )
}
