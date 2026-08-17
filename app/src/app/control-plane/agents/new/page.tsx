import Link from 'next/link'
import { getAgentGovernance, getModelPolicy, listBehaviorProfiles } from '@/app/actions/platform'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { getAgentSkillsAction, listAssignableSkillsAction } from '@/app/actions/skills'
import { requireTenantRole } from '@/auth/tenant-context'
import {
  CreateAgentWizard,
  type CreateAgentWizardContinuation,
} from '@/components/agents/create-agent-wizard'
import {
  assignableConnectorsFromCatalog,
  parseCreateAgentWizardStep,
} from '@/lib/create-agent-wizard'
import { enabledModelProviders } from '@/lib/model-policy'
import { repositories } from '@/repositories/postgres'

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ continue?: string; step?: string }>
}) {
  const query = await searchParams
  const policyRes = await getModelPolicy()
  const providers = policyRes.success ? enabledModelProviders(policyRes.data) : []
  const profilesRes = await listBehaviorProfiles()
  const profiles = profilesRes.success
    ? profilesRes.data.map((profile) => ({
        id: profile.id,
        name: profile.name,
        currentVersion: profile.currentVersion,
      }))
    : []

  const continuation = await loadContinuation(query.continue)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/control-plane/agents" className="text-sm text-ink-faint hover:text-ink">
          ← Agent Registry
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold">Új agent</h1>
        <p className="mt-1 text-ink-soft">
          Lépésről lépésre: munkakör, stílus, modell, eszközök, skillek, kapcsolatok. Ha közben
          új skillt vagy kapcsolatot kell létrehoznod, az új böngészőablakban nyílik.
        </p>
      </div>

      <div className="max-w-5xl">
        {policyRes.success && providers.length > 0 ? (
          <CreateAgentWizard
            providers={providers}
            profiles={profiles}
            initialStep={
              continuation
                ? parseCreateAgentWizardStep(query.step)
                : 'identity'
            }
            continuation={continuation}
          />
        ) : (
          <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {policyRes.success
              ? 'Nincs agenthez engedélyezett modell. A Rendszer oldalon engedélyezz legalább egyet.'
              : policyRes.error}
          </div>
        )}
      </div>
    </div>
  )
}

async function loadContinuation(
  agentId: string | undefined,
): Promise<CreateAgentWizardContinuation | null> {
  if (!agentId) return null
  try {
    const user = await requireTenantRole('admin')
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return null

    const [govRes, skillsRes, assignableRes, catalogRes] = await Promise.all([
      getAgentGovernance({ agentId: agent.id }),
      getAgentSkillsAction(agent.id),
      listAssignableSkillsAction(agent.id),
      listConnectorCatalog(),
    ])

    const connectors = govRes.success ? govRes.data.connectors : []
    const catalog = catalogRes.success ? catalogRes.data : []

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role === 'orchestrator' ? 'orchestrator' : 'worker',
      roleInstruction: agent.roleInstruction,
      behaviorProfile: agent.behaviorProfileOverlay || agent.behaviorProfile,
      status: agent.status,
      taskOnly: agent.taskOnly,
      allowSensitiveExternalModel: agent.allowSensitiveExternalModel,
      hiddenFromOperators: agent.hiddenFromOperators,
      selfEvolutionProfile: agent.selfEvolutionProfile,
      capabilities: govRes.success ? govRes.data.capabilities : [],
      assignedSkills: skillsRes.success ? skillsRes.data : [],
      assignableSkills: assignableRes.success ? assignableRes.data : [],
      connectors,
      assignableConnectors: assignableConnectorsFromCatalog(
        catalog,
        connectors.map((item) => item.connector.id),
      ),
    }
  } catch {
    return null
  }
}
