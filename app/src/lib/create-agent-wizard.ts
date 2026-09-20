/** Új-agent varázsló: lépések, kapuk és a „közben eszembe jutott” új-ablakos útvonalak. */

export const CREATE_AGENT_WIZARD_STEPS = [
  {
    id: 'identity',
    label: 'Alapok',
    hint: 'Név és munkakör',
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
    id: 'done',
    label: 'Kész',
    hint: 'Publikálás és aktiválás',
    phase: 'post',
  },
] as const

export type CreateAgentWizardStepId = (typeof CREATE_AGENT_WIZARD_STEPS)[number]['id']

export const CREATE_AGENT_WIZARD_EXTERNAL_HREFS = {
  skills: '/control-plane/skills',
  connections: '/control-plane/provisioning',
  connectors: '/control-plane/account',
} as const

export type CreateAgentWizardGate = {
  name: string
  roleInstruction: string
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

export function isPreCreateComplete(gate: CreateAgentWizardGate) {
  return isIdentityStepComplete(gate)
}

export function canEnterCreateAgentWizardStep(
  stepId: CreateAgentWizardStepId,
  gate: CreateAgentWizardGate,
): boolean {
  const step = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === stepId)
  if (!step) return false
  if (step.phase === 'post') return Boolean(gate.createdAgentId)
  return stepId === 'identity'
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

export function assignableConnectorsFromCatalog<T extends { id: string }>(
  catalog: T[],
  assignedIds: Iterable<string>,
): T[] {
  const assigned = new Set(assignedIds)
  return catalog.filter((connector) => !assigned.has(connector.id))
}

/** Meglévő agent másolásához — pre-create + post-create beállítások sablonja. */
export type CreateAgentWizardCloneTemplate = {
  sourceAgentId: string
  sourceAgentName: string
  roleInstruction: string
  enabledTools: string[]
  skillVersionIds: string[]
  connectors: Array<{ connectorId: string; accessMode: 'read' | 'write'; name: string }>
}

export function cloneTemplateFromAgent(source: {
  sourceAgentId: string
  sourceAgentName: string
  roleInstruction: string
  capabilities: Array<{ toolName: string; allowed: boolean }>
  skills: Array<{ skillVersionId: string }>
  connectors: Array<{
    connector: { id: string; name: string }
    accessMode: 'read' | 'write'
  }>
}): CreateAgentWizardCloneTemplate {
  return {
    sourceAgentId: source.sourceAgentId,
    sourceAgentName: source.sourceAgentName,
    roleInstruction: source.roleInstruction,
    enabledTools: grantedToolNames(source.capabilities),
    skillVersionIds: source.skills.map((skill) => skill.skillVersionId),
    connectors: source.connectors.map((row) => ({
      connectorId: row.connector.id,
      accessMode: row.accessMode,
      name: row.connector.name,
    })),
  }
}
