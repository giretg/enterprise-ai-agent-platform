/** Új-agent varázsló: lépések, kapuk és a „közben eszembe jutott” új-ablakos útvonalak. */

import {
  DEFAULT_MODEL_TYPE,
  isModelType,
  normalizeModelForProvider,
  type ModelProviderOption,
  type ModelType,
} from '@/lib/model-providers'

export const CREATE_AGENT_WIZARD_STEPS = [
  {
    id: 'identity',
    label: 'Alapok',
    hint: 'Név, szerep, munkakör',
    phase: 'pre',
  },
  {
    id: 'style',
    label: 'Munkastílus',
    hint: 'Hogyan dolgozik',
    phase: 'pre',
  },
  {
    id: 'model',
    label: 'Modell',
    hint: 'Gondolkodási motor',
    phase: 'pre',
  },
  {
    id: 'tools',
    label: 'Eszközök',
    hint: 'Mit hívhat meg',
    phase: 'post',
  },
  {
    id: 'skills',
    label: 'Képességek',
    hint: 'Katalógusból hozzárendelve',
    phase: 'post',
  },
  {
    id: 'connections',
    label: 'Kapcsolatok',
    hint: 'Külső rendszerek',
    phase: 'post',
  },
  {
    id: 'knowledge',
    label: 'Tudásbázis',
    hint: 'Dokumentumok',
    phase: 'post',
  },
  {
    id: 'operation',
    label: 'Működés',
    hint: 'Hozzáférés és szabályok',
    phase: 'post',
  },
  {
    id: 'done',
    label: 'Kész',
    hint: 'Összegzés',
    phase: 'post',
  },
] as const

export type CreateAgentWizardStepId = (typeof CREATE_AGENT_WIZARD_STEPS)[number]['id']

export const CREATE_AGENT_WIZARD_EXTERNAL_HREFS = {
  skills: '/control-plane/skills',
  connections: '/control-plane/provisioning',
  connectors: '/control-plane/account',
  behaviorProfiles: '/control-plane/behavior-profiles',
} as const

export type CreateAgentWizardGate = {
  name: string
  roleInstruction: string
  behaviorProfile: string
  createdAgentId: string | null
}

export function isCreateAgentWizardStepId(value: unknown): value is CreateAgentWizardStepId {
  return CREATE_AGENT_WIZARD_STEPS.some((step) => step.id === value)
}

export function parseCreateAgentWizardStep(
  value: string | null | undefined,
): CreateAgentWizardStepId {
  return isCreateAgentWizardStepId(value) ? value : 'identity'
}

export function createAgentWizardStepIndex(id: CreateAgentWizardStepId): number {
  return CREATE_AGENT_WIZARD_STEPS.findIndex((step) => step.id === id)
}

export function isIdentityStepComplete(gate: Pick<CreateAgentWizardGate, 'name' | 'roleInstruction'>) {
  return gate.name.trim().length > 0 && gate.roleInstruction.trim().length > 0
}

export function isStyleStepComplete(gate: Pick<CreateAgentWizardGate, 'behaviorProfile'>) {
  return gate.behaviorProfile.trim().length > 0
}

export function isPreCreateComplete(gate: CreateAgentWizardGate) {
  return isIdentityStepComplete(gate) && isStyleStepComplete(gate)
}

export function canEnterCreateAgentWizardStep(
  stepId: CreateAgentWizardStepId,
  gate: CreateAgentWizardGate,
): boolean {
  const step = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === stepId)
  if (!step) return false
  if (step.phase === 'post') return Boolean(gate.createdAgentId)
  if (stepId === 'identity') return true
  if (stepId === 'style') return isIdentityStepComplete(gate)
  if (stepId === 'model') return isPreCreateComplete(gate)
  return false
}

export function nextCreateAgentWizardStep(
  stepId: CreateAgentWizardStepId,
): CreateAgentWizardStepId | null {
  const index = createAgentWizardStepIndex(stepId)
  return CREATE_AGENT_WIZARD_STEPS[index + 1]?.id ?? null
}

export function prevCreateAgentWizardStep(
  stepId: CreateAgentWizardStepId,
): CreateAgentWizardStepId | null {
  const index = createAgentWizardStepIndex(stepId)
  return index > 0 ? CREATE_AGENT_WIZARD_STEPS[index - 1].id : null
}

export function createAgentWizardContinueHref(
  agentId: string,
  stepId: CreateAgentWizardStepId,
): string {
  const params = new URLSearchParams({ continue: agentId, step: stepId })
  return `/control-plane/agents/new?${params.toString()}`
}

/** Provisioning agent által javasolt vázlat — a varázsló űrlapjába tölthető. */
export type CreateAgentWizardProposal = {
  name: string
  role: 'worker' | 'orchestrator'
  roleInstruction: string
  behaviorProfile: string
  modelConfig: {
    provider: string
    model: string
    modelType?: 'luna' | 'terra' | 'sol'
    temperature?: number
  }
  suggestedCapabilities: string[]
  suggestedSkills: string[]
  suggestedConnectors?: string[]
  summary?: string
}

export function matchAssignableSkillsByName<T extends { name: string }>(
  assignable: T[],
  suggestedNames: Iterable<string>,
): T[] {
  const wanted = new Set(
    [...suggestedNames].map((n) => n.trim().toLowerCase()).filter(Boolean),
  )
  if (wanted.size === 0) return []
  return assignable.filter((skill) => wanted.has(skill.name.trim().toLowerCase()))
}

export function matchAssignableConnectorsByName<T extends { name: string }>(
  assignable: T[],
  suggestedNames: Iterable<string>,
): T[] {
  const wanted = new Set(
    [...suggestedNames].map((n) => n.trim().toLowerCase()).filter(Boolean),
  )
  if (wanted.size === 0) return []
  return assignable.filter((connector) => wanted.has(connector.name.trim().toLowerCase()))
}

export function grantedToolNames(
  currentCapabilities: Array<{ toolName: string; allowed: boolean }>,
): string[] {
  return currentCapabilities.filter((c) => c.allowed).map((c) => c.toolName)
}

/** Granted ∪ javasolt — a checkboxok kiindulása; mentés nélkül még nincs grant. */
export function initialEnabledToolNames(
  currentCapabilities: Array<{ toolName: string; allowed: boolean }>,
  suggestedTools: Iterable<string> = [],
): string[] {
  const suggested = [...suggestedTools].map((t) => t.trim()).filter(Boolean)
  return [...new Set([...grantedToolNames(currentCapabilities), ...suggested])]
}

export function toolSelectionHasChanges(
  enabled: Iterable<string>,
  granted: Iterable<string>,
): boolean {
  const enabledSet = new Set([...enabled])
  const grantedSet = new Set([...granted])
  if (enabledSet.size !== grantedSet.size) return true
  for (const name of enabledSet) {
    if (!grantedSet.has(name)) return true
  }
  return false
}

export function assignableConnectorsFromCatalog<T extends { id: string; type: string }>(
  catalog: T[],
  assignedIds: Iterable<string>,
): T[] {
  const assigned = new Set(assignedIds)
  return catalog.filter(
    (connector) =>
      (connector.type === 'http_api' || connector.type as string === 'gmail' || connector.type === 'code_sandbox') && !assigned.has(connector.id),
  )
}

/** Meglévő agent másolásához — pre-create + post-create beállítások sablonja. */
export type CreateAgentWizardCloneTemplate = {
  sourceAgentId: string
  sourceAgentName: string
  role: 'worker' | 'orchestrator'
  roleInstruction: string
  behaviorProfile: string
  behaviorProfileId: string
  modelConfig: {
    provider: string
    model: string
    modelType: ModelType
    temperature: number
  }
  enabledTools: string[]
  skillVersionIds: string[]
  connectors: Array<{ connectorId: string; accessMode: 'read' | 'write'; name: string }>
  taskOnly: boolean
  hiddenFromOperators: boolean
  allowSensitiveExternalModel: boolean
  selfEvolutionProfile: unknown
}

export function parseAgentModelConfigForWizard(
  raw: unknown,
  providers: ModelProviderOption[],
): CreateAgentWizardCloneTemplate['modelConfig'] {
  const fallbackProvider = providers[0]?.value ?? 'chatgpt-oauth'
  const fallbackModel =
    providers.find((p) => p.value === fallbackProvider)?.defaultModel ?? 'chatgpt-oauth-default'
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const provider =
    typeof record.provider === 'string' && providers.some((p) => p.value === record.provider)
      ? record.provider
      : fallbackProvider
  const model = normalizeModelForProvider(
    provider,
    typeof record.model === 'string' ? record.model : fallbackModel,
    providers,
  )
  const modelType = isModelType(record.modelType) ? record.modelType : DEFAULT_MODEL_TYPE
  const temperature =
    typeof record.temperature === 'number' && Number.isFinite(record.temperature)
      ? record.temperature
      : 0.2
  return { provider, model, modelType, temperature }
}
