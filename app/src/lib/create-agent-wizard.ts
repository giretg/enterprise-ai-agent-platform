/**
 * Új munkatárs felvétele (#957): lépések, kapuk és a folytatás.
 *
 * Az `pre` lépések a munkatárs létrejötte előtt futnak (Indulás, Ki ő?, Mi a
 * dolga?); a „Mi a dolga?” után jön létre a még nem dolgozó munkatárs, a `post`
 * lépések már erre mentenek. A beállítás-jegyzék (`agent-setting-sections`)
 * minden adatlap-területet ezek egyikéhez köt.
 */

import { modesFromAgentRow, type AgentWriteApprovalModes } from '@/lib/write-approval-modes'

export const CREATE_AGENT_WIZARD_STEPS = [
  { id: 'start', label: 'Indulás', hint: 'Honnan indulsz?', phase: 'pre', optional: false },
  { id: 'identity', label: 'Ki ő?', hint: 'Név, bemutatkozás, kép', phase: 'pre', optional: false },
  { id: 'duties', label: 'Mi a dolga?', hint: 'Feladatok és hangnem', phase: 'pre', optional: false },
  { id: 'access', label: 'Mihez fér hozzá?', hint: 'Levelezés, dokumentumok, rendszerek', phase: 'post', optional: false },
  { id: 'knowledge', label: 'Mit tudjon?', hint: 'Dokumentumok, amiből dolgozik', phase: 'post', optional: false },
  { id: 'autonomy', label: 'Mennyire önálló?', hint: 'Mikor kérdezzen meg', phase: 'post', optional: false },
  { id: 'team', label: 'Ki dolgozik vele?', hint: 'Kik használhatják', phase: 'post', optional: false },
  { id: 'advanced', label: 'Haladó', hint: 'Kihagyható', phase: 'post', optional: true },
  { id: 'launch', label: 'Munkába állítás', hint: 'Próba és indulás', phase: 'post', optional: false },
] as const

export type CreateAgentWizardStepId = (typeof CREATE_AGENT_WIZARD_STEPS)[number]['id']

/** Félbehagyott munkatárs folytatása, ha nincs megjegyzett lépés. */
export const CREATE_AGENT_WIZARD_RESUME_STEP: CreateAgentWizardStepId = 'access'

export const CREATE_AGENT_WIZARD_EXTERNAL_HREFS = {
  skills: '/control-plane/skills',
  connections: '/control-plane/provisioning',
  connectors: '/control-plane/account',
} as const

/** Munkába állítás után: hol írhat neki / adhat neki feladatot a felhasználó. */
export const CREATE_AGENT_WIZARD_AFTER_LAUNCH_HREFS = {
  chat: '/control-plane/get-started',
  ticket: '/control-plane/operations',
} as const

export type CreateAgentWizardGate = {
  name: string
  roleInstruction: string
  description: string
  createdAgentId: string | null
}

export function isCreateAgentWizardStepId(value: unknown): value is CreateAgentWizardStepId {
  return CREATE_AGENT_WIZARD_STEPS.some((step) => step.id === value)
}

export function parseCreateAgentWizardStep(
  value: string | null | undefined,
  fallback: CreateAgentWizardStepId = 'start',
): CreateAgentWizardStepId {
  return isCreateAgentWizardStepId(value) ? value : fallback
}

export function createAgentWizardStepIndex(id: CreateAgentWizardStepId): number {
  return CREATE_AGENT_WIZARD_STEPS.findIndex((step) => step.id === id)
}

/** Kötelező a név és az egy mondatos bemutatkozás. */
export function isIdentityStepComplete(gate: Pick<CreateAgentWizardGate, 'name' | 'description'>) {
  return gate.name.trim().length > 0 && gate.description.trim().length > 0
}

/** Legalább egy feladat — a munkakör-szöveg ebből áll össze. */
export function isDutiesStepComplete(gate: Pick<CreateAgentWizardGate, 'roleInstruction'>) {
  return gate.roleInstruction.trim().length > 0
}

export function isPreCreateComplete(gate: CreateAgentWizardGate) {
  return isIdentityStepComplete(gate) && isDutiesStepComplete(gate)
}

export function canEnterCreateAgentWizardStep(
  stepId: CreateAgentWizardStepId,
  gate: CreateAgentWizardGate,
): boolean {
  const step = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === stepId)
  if (!step) return false
  if (step.phase === 'post') return Boolean(gate.createdAgentId)
  if (stepId === 'start') return !gate.createdAgentId
  if (stepId === 'duties') return Boolean(gate.createdAgentId) || isIdentityStepComplete(gate)
  return true
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
  stepId?: CreateAgentWizardStepId,
): string {
  const params = new URLSearchParams({ continue: agentId })
  if (stepId) params.set('step', stepId)
  return `/control-plane/agents/new?${params.toString()}`
}

/** Félkész = még nem dolgozik: vázlat, és soha nem állt munkába. */
export function isHalfFinishedAgent(agent: {
  status: string
  currentDefinitionVersionId: string | null
}): boolean {
  return agent.status === 'draft' && !agent.currentDefinitionVersionId
}

/** Böngészőnkénti emlék: melyik lépésnél hagyta félbe (a lista-link ide visz). */
export function createAgentWizardLastStepStorageKey(agentId: string): string {
  return `agent-hire:last-step:${agentId}`
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

/**
 * Meglévő agent másolásához — pre-create + post-create beállítások sablonja.
 * Titkot, személyes fiók-összekötést és projektmemóriát nem visz át.
 */
export type CreateAgentWizardCloneTemplate = {
  sourceAgentId: string
  sourceAgentName: string
  roleInstruction: string
  description: string
  enabledTools: string[]
  skillVersionIds: string[]
  connectors: Array<{ connectorId: string; accessMode: 'read' | 'write'; name: string }>
  writeModes: AgentWriteApprovalModes
  approverUserId: string | null
  /** A forrás nyers modell-beállítása; a szerver mentéskor újra ellenőrzi a céges korlátot. */
  modelConfig: unknown
  access: Array<{ userId: string; accessLevel: 'view' | 'operate'; label: string }>
}

export function cloneTemplateFromAgent(source: {
  sourceAgentId: string
  sourceAgentName: string
  roleInstruction: string
  description?: string | null
  capabilities: Array<{ toolName: string; allowed: boolean }>
  skills: Array<{ skillVersionId: string }>
  connectors: Array<{
    connector: { id: string; name: string }
    accessMode: 'read' | 'write'
  }>
  writeModes?: {
    memoryWriteMode?: unknown
    httpApiWriteMode?: unknown
    gmailWriteMode?: unknown
    driveWriteMode?: unknown
  }
  approverUserId?: string | null
  modelConfig?: unknown
  access?: Array<{
    id: string
    name: string
    email: string
    accessLevel: 'view' | 'operate' | null
  }>
}): CreateAgentWizardCloneTemplate {
  return {
    sourceAgentId: source.sourceAgentId,
    sourceAgentName: source.sourceAgentName,
    roleInstruction: source.roleInstruction,
    description: source.description?.trim() ?? '',
    enabledTools: grantedToolNames(source.capabilities),
    skillVersionIds: source.skills.map((skill) => skill.skillVersionId),
    connectors: source.connectors.map((row) => ({
      connectorId: row.connector.id,
      accessMode: row.accessMode,
      name: row.connector.name,
    })),
    writeModes: modesFromAgentRow(source.writeModes ?? {}),
    approverUserId: source.approverUserId ?? null,
    modelConfig: source.modelConfig ?? null,
    access: (source.access ?? []).flatMap((user) =>
      user.accessLevel
        ? [{ userId: user.id, accessLevel: user.accessLevel, label: user.name || user.email }]
        : [],
    ),
  }
}
