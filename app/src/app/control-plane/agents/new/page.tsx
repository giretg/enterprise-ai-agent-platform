import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { getAgent, getAgentGovernance, listAgents } from '@/app/actions/platform'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { CreateAgentWizard } from '@/components/agents/create-agent-wizard'
import {
  assignableConnectorsFromCatalog,
  parseCreateAgentWizardStep,
} from '@/lib/create-agent-wizard'

export const dynamic = 'force-dynamic'

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ continue?: string; step?: string }>
}) {
  await requireTenantRole('admin')
  const params = await searchParams
  const continueId = params.continue?.trim() || null
  const [agentsRes, catalogRes] = await Promise.all([listAgents({ limit: 100 }), listConnectorCatalog()])
  const cloneableAgents = (agentsRes.success ? agentsRes.data : [])
    .filter((agent) => agent.id !== continueId)
    .map((agent) => ({ id: agent.id, name: agent.name }))
  const catalog = catalogRes.success ? catalogRes.data : []

  let continuation = null
  if (continueId) {
    const [agentRes, govRes, skillsRes, assignableRes] = await Promise.all([
      getAgent({ id: continueId }),
      getAgentGovernance({ agentId: continueId }),
      getAgentSkillsAction(continueId),
      listAssignableSkillsAction(continueId),
    ])
    if (agentRes.success && agentRes.data) {
      const connectors = govRes.success ? govRes.data.connectors : []
      continuation = {
        agentId: agentRes.data.id,
        name: agentRes.data.name,
        roleInstruction: agentRes.data.roleInstruction,
        status: agentRes.data.status,
        currentDefinitionVersionId: agentRes.data.currentDefinitionVersionId,
        capabilities: govRes.success ? govRes.data.capabilities : [],
        assignedSkills: skillsRes.success ? skillsRes.data : [],
        assignableSkills: assignableRes.success ? assignableRes.data.assignable : [],
        connectors,
        assignableConnectors: assignableConnectorsFromCatalog(
          catalog,
          connectors.map((row) => row.connector.id),
        ),
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
      <CreateAgentWizard
        cloneableAgents={cloneableAgents}
        initialStep={parseCreateAgentWizardStep(params.step)}
        continuation={continuation}
        catalog={
          continuation
            ? continuation.assignableConnectors
            : catalog
        }
        catalogDetails={catalog}
      />
    </div>
  )
}
