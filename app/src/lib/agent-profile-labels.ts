import type { AgentRole } from '@prisma/client'
import type { SelfEvolutionProfile } from '@/lib/self-evolution-profile'
import { modelLabel, modelTypeLabel, providerOption, providerUsesThinkingProfile } from '@/lib/model-providers'

const SCOPE_LABELS: Record<SelfEvolutionProfile['scope'][number], string> = {
  memory: 'emlékek',
  behavior: 'munkastílus',
  role: 'munkakör',
}

const APPROVAL_LABELS: Record<SelfEvolutionProfile['approval_mode'], string> = {
  human: 'minden változást ember hagy jóvá',
  higher_role: 'magasabb rangú kolléga hagyja jóvá',
  eval_only: 'csak sikeres ellenőrzés után léphet életbe',
  auto_after_eval: 'ellenőrzés után automatikusan életbe lép',
}

const AGENT_ROLE_LABELS: Record<AgentRole, { title: string; description: string }> = {
  worker: {
    title: 'Végrehajtó',
    description: 'Saját eszközökkel dolgozik a feladatokon.',
  },
  orchestrator: {
    title: 'Koordinátor',
    description: 'Feladatokat oszt ki más munkatársaknak, maga nem használ eszközöket.',
  },
}

const RECIPE_STATUS_LABELS: Record<string, string> = {
  active: 'aktív',
  proposed: 'tervezett',
  retired: 'archivált',
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  secret: 'titok',
  policy: 'szabály',
  file: 'fájl',
  dataset: 'adatkészlet',
  connector: 'kapcsolat',
  tool: 'eszköz',
}

export function agentRoleLabel(role: AgentRole) {
  return AGENT_ROLE_LABELS[role]
}

export function modelConfigSummary(modelConfig: Record<string, unknown>) {
  const provider = String(modelConfig.provider ?? 'chatgpt-oauth')
  const model = String(modelConfig.model ?? '')
  const option = providerOption(provider)
  const parts = [option.label]
  if (model) parts.push(modelLabel(provider, model))
  const typeLabel = providerUsesThinkingProfile(provider)
    ? modelTypeLabel(
        typeof modelConfig.modelType === 'string' ? modelConfig.modelType : undefined,
      )
    : null
  if (typeLabel) parts.push(typeLabel)
  if (typeof modelConfig.temperature === 'number') {
    parts.push(`kreativitás: ${modelConfig.temperature}`)
  }
  return parts.join(' · ')
}

export function selfEvolutionSummary(profile: SelfEvolutionProfile) {
  const scopes = profile.scope.map((s) => SCOPE_LABELS[s]).join(', ')
  const approval = APPROVAL_LABELS[profile.approval_mode]
  const limit =
    profile.diff_limit != null ? ` · max. ${profile.diff_limit} sor változás` : ''
  const durable = profile.durable_memory_approval_policy
  const durableLabel = durable
    ? durable.activation_mode === 'operator_can_activate'
      ? 'az operátor is életbe léptetheti a tanítást'
      : 'a tanítást jóváhagyó lépteti életbe'
    : 'a tanítást jóváhagyó lépteti életbe'
  return `Önállóan fejlesztheti: ${scopes}. ${approval}${limit}. Tartós tudás: ${durableLabel}.`
}

export function recipeStatusLabel(status: string) {
  return RECIPE_STATUS_LABELS[status] ?? status
}

export function resourceTypeLabel(type: string) {
  return RESOURCE_TYPE_LABELS[type] ?? type
}

export function connectorAccessLabel(mode: string) {
  if (mode === 'write') return 'írás és olvasás'
  if (mode === 'read') return 'csak olvasás'
  return mode
}
