'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, useTransition } from 'react'
import { createAgent, draftAgentFromDescription, getAgentCloneTemplate, getAgentGovernance, listBehaviorProfiles, setAgentBehaviorProfile, applyAgentCloneSettings } from '@/app/actions/platform'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import {
  getAgentSkillsAction,
  listAssignableSkillsAction,
  type AgentSkillRow,
  type AssignableSkill,
} from '@/app/actions/skills'
import { AddApiConnectorForm } from '@/components/agents/add-api-connector-form'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import { AgentKnowledgeBasePanel } from '@/components/agents/agent-knowledge-base-panel'
import { AgentLifecycleControls } from '@/components/agents/agent-lifecycle-controls'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import { ApiConnectorList } from '@/components/agents/api-connector-list'
import { AssignExistingConnectorForm } from '@/components/agents/assign-existing-connector-form'
import { ModelSelectField } from '@/components/agents/model-select-field'
import { ModelTypeSelectField } from '@/components/agents/model-type-select-field'
import { OperatorVisibilityForm } from '@/components/agents/operator-visibility-form'
import { PrivacyAdminPanel } from '@/components/privacy/privacy-admin-panel'
import { TaskOnlyForm } from '@/components/agents/task-only-form'
import { UpdateSelfEvolutionProfileForm } from '@/components/agents/update-self-evolution-profile-form'
import { Card } from '@/components/ui/shell'
import { Spinner } from '@/components/ui/spinner'
import { WizardExternalPrompt } from '@/components/ui/wizard-external-prompt'
import { agentDisplayName } from '@/lib/agent-persona'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  CREATE_AGENT_WIZARD_STEPS,
  assignableConnectorsFromCatalog,
  canEnterCreateAgentWizardStep,
  createAgentWizardContinueHref,
  createAgentWizardStepIndex,
  isIdentityStepComplete,
  isPreCreateComplete,
  isStyleStepComplete,
  nextCreateAgentWizardStep,
  parseCreateAgentWizardStep,
  prevCreateAgentWizardStep,
  type CreateAgentWizardProposal,
  type CreateAgentWizardStepId,
  type CreateAgentWizardCloneTemplate,
} from '@/lib/create-agent-wizard'
import {
  DEFAULT_MODEL_TYPE,
  MODEL_PROVIDERS,
  normalizeModelForProvider,
  providerUsesThinkingProfile,
  type ModelProviderOption,
  type ModelType,
} from '@/lib/model-providers'

const DEFAULT_MODEL = {
  provider: 'chatgpt-oauth',
  model: 'chatgpt-oauth-default',
  modelType: DEFAULT_MODEL_TYPE,
  temperature: 0.2,
  maxTokens: 4096,
}

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

const API_KEY_STORAGE_PREFIX = 'create-agent-wizard-api-key:'

export type CreateAgentWizardProfile = {
  id: string
  name: string
  currentVersion: number
}

export type CreateAgentWizardCloneOption = {
  id: string
  name: string
  personaNickname?: string | null
}

export type CreateAgentWizardConnector = {
  connector: {
    id: string
    type: string
    name: string
    scope: string
    secretAlias: string | null
    config: unknown
    authMode?: string
  }
  accessMode: 'read' | 'write'
}

export type CreateAgentWizardContinuation = {
  agentId: string
  name: string
  role: 'worker' | 'orchestrator'
  roleInstruction: string
  behaviorProfile: string
  status: 'draft' | 'active' | 'suspended' | 'retired'
  taskOnly: boolean
  allowSensitiveExternalModel: boolean
  hiddenFromOperators: boolean
  selfEvolutionProfile: unknown
  capabilities: Array<{ toolName: string; allowed: boolean }>
  assignedSkills: AgentSkillRow[]
  assignableSkills: AssignableSkill[]
  connectors: CreateAgentWizardConnector[]
  assignableConnectors: Array<{ id: string; type: string; name: string }>
}

function readStoredApiKey(agentId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem(`${API_KEY_STORAGE_PREFIX}${agentId}`)
  } catch {
    return null
  }
}

function storeApiKey(agentId: string, apiKey: string) {
  try {
    sessionStorage.setItem(`${API_KEY_STORAGE_PREFIX}${agentId}`, apiKey)
  } catch {
    // sessionStorage lehet tiltva — a kulcs akkor csak ebben a körben látszik.
  }
}

export function CreateAgentWizard({
  providers = MODEL_PROVIDERS,
  profiles,
  cloneableAgents = [],
  initialStep,
  continuation = null,
}: {
  providers?: ModelProviderOption[]
  profiles: CreateAgentWizardProfile[]
  cloneableAgents?: CreateAgentWizardCloneOption[]
  initialStep?: string
  continuation?: CreateAgentWizardContinuation | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const safeProviders = providers.length > 0 ? providers : MODEL_PROVIDERS

  const [step, setStep] = useState<CreateAgentWizardStepId>(() =>
    parseCreateAgentWizardStep(initialStep),
  )
  const [name, setName] = useState(continuation?.name ?? '')
  const [role, setRole] = useState<'worker' | 'orchestrator'>(continuation?.role ?? 'worker')
  const [roleInstruction, setRoleInstruction] = useState(continuation?.roleInstruction ?? '')
  const [behaviorProfile, setBehaviorProfile] = useState(continuation?.behaviorProfile ?? '')
  const [behaviorProfileId, setBehaviorProfileId] = useState('')
  const [profileOptions, setProfileOptions] = useState(profiles)
  const [provider, setProvider] = useState(safeProviders[0].value)
  const [model, setModel] = useState(safeProviders[0].defaultModel)
  const [modelType, setModelType] = useState<ModelType>(DEFAULT_MODEL_TYPE)
  const [temperature, setTemperature] = useState(String(DEFAULT_MODEL.temperature))
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(continuation?.agentId ?? null)
  const [apiKey, setApiKey] = useState<string | null>(() =>
    continuation ? readStoredApiKey(continuation.agentId) : null,
  )
  const [agentStatus, setAgentStatus] = useState(continuation?.status ?? 'draft')
  const [capabilities, setCapabilities] = useState(continuation?.capabilities ?? [])
  const [assignedSkills, setAssignedSkills] = useState(continuation?.assignedSkills ?? [])
  const [assignableSkills, setAssignableSkills] = useState(continuation?.assignableSkills ?? [])
  const [connectors, setConnectors] = useState(continuation?.connectors ?? [])
  const [assignableConnectors, setAssignableConnectors] = useState(
    continuation?.assignableConnectors ?? [],
  )
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [proposal, setProposal] = useState<CreateAgentWizardProposal | null>(null)
  const [proposalWarnings, setProposalWarnings] = useState<string[]>([])
  const [cloneSourceId, setCloneSourceId] = useState('')
  const [cloneTemplate, setCloneTemplate] = useState<CreateAgentWizardCloneTemplate | null>(null)
  const [loadingClone, setLoadingClone] = useState(false)
  const [operationDefaults, setOperationDefaults] = useState<{
    taskOnly: boolean
    hiddenFromOperators: boolean
    allowSensitiveExternalModel: boolean
    selfEvolutionProfile: unknown
  }>({
    taskOnly: continuation?.taskOnly ?? false,
    hiddenFromOperators: continuation?.hiddenFromOperators ?? false,
    allowSensitiveExternalModel: continuation?.allowSensitiveExternalModel ?? false,
    selfEvolutionProfile: continuation?.selfEvolutionProfile ?? null,
  })

  const selectedProvider = safeProviders.find((p) => p.value === provider) ?? safeProviders[0]
  const gate = { name, roleInstruction, behaviorProfile, createdAgentId }
  const stepMeta = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === step) ?? CREATE_AGENT_WIZARD_STEPS[0]
  const stepNumber = createAgentWizardStepIndex(step) + 1

  const refreshCatalogs = useCallback(() => {
    if (!createdAgentId) return
    startRefresh(async () => {
      const [skillsRes, assignableRes, govRes, catalogRes, profilesRes] = await Promise.all([
        getAgentSkillsAction(createdAgentId),
        listAssignableSkillsAction(createdAgentId),
        getAgentGovernance({ agentId: createdAgentId }),
        listConnectorCatalog(),
        listBehaviorProfiles(),
      ])
      if (skillsRes.success) setAssignedSkills(skillsRes.data)
      if (assignableRes.success) setAssignableSkills(assignableRes.data)
      if (govRes.success) {
        setCapabilities(govRes.data.capabilities)
        setConnectors(govRes.data.connectors as CreateAgentWizardConnector[])
        const assignedIds = govRes.data.connectors.map((item) => item.connector.id)
        if (catalogRes.success) {
          setAssignableConnectors(assignableConnectorsFromCatalog(catalogRes.data, assignedIds))
        }
      }
      if (profilesRes.success) {
        setProfileOptions(
          profilesRes.data.map((p) => ({
            id: p.id,
            name: p.name,
            currentVersion: p.currentVersion,
          })),
        )
      }
    })
  }, [createdAgentId])

  useEffect(() => {
    if (!createdAgentId) return
    refreshCatalogs()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshCatalogs()
    }
    window.addEventListener('focus', refreshCatalogs)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refreshCatalogs)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [createdAgentId, refreshCatalogs])

  function resetFormToEmpty() {
    setName('')
    setRole('worker')
    setRoleInstruction('')
    setBehaviorProfile('')
    setBehaviorProfileId('')
    setProvider(safeProviders[0].value)
    setModel(safeProviders[0].defaultModel)
    setModelType(DEFAULT_MODEL_TYPE)
    setTemperature(String(DEFAULT_MODEL.temperature))
    setOperationDefaults({
      taskOnly: false,
      hiddenFromOperators: false,
      allowSensitiveExternalModel: false,
      selfEvolutionProfile: null,
    })
    setProposal(null)
    setProposalWarnings([])
    setPrompt('')
  }

  function applyCloneTemplate(template: CreateAgentWizardCloneTemplate) {
    setCloneTemplate(template)
    setName('')
    setRole(template.role)
    setRoleInstruction(template.roleInstruction)
    setBehaviorProfile(template.behaviorProfile)
    setBehaviorProfileId(template.behaviorProfileId)
    setProvider(template.modelConfig.provider)
    setModel(
      normalizeModelForProvider(
        template.modelConfig.provider,
        template.modelConfig.model,
        safeProviders,
      ),
    )
    setModelType(template.modelConfig.modelType)
    setTemperature(String(template.modelConfig.temperature))
    setOperationDefaults({
      taskOnly: template.taskOnly,
      hiddenFromOperators: template.hiddenFromOperators,
      allowSensitiveExternalModel: template.allowSensitiveExternalModel,
      selfEvolutionProfile: template.selfEvolutionProfile,
    })
    setProposal(null)
    setProposalWarnings([])
    setPrompt('')
  }

  function clearCloneTemplate() {
    setCloneTemplate(null)
    setCloneSourceId('')
    resetFormToEmpty()
  }

  async function handleCloneSourceChange(nextSourceId: string) {
    setCloneSourceId(nextSourceId)
    setError(null)
    if (!nextSourceId) {
      clearCloneTemplate()
      return
    }
    setLoadingClone(true)
    try {
      const res = await getAgentCloneTemplate({ sourceAgentId: nextSourceId })
      if (!res.success) {
        setError(res.error)
        clearCloneTemplate()
        return
      }
      applyCloneTemplate(res.data)
    } finally {
      setLoadingClone(false)
    }
  }

  function goTo(next: CreateAgentWizardStepId) {
    if (!canEnterCreateAgentWizardStep(next, gate)) return
    setStep(next)
    if (createdAgentId) {
      router.replace(createAgentWizardContinueHref(createdAgentId, next), { scroll: false })
    }
  }

  function createAndContinue() {
    startTransition(async () => {
      setError(null)
      const res = await createAgent({
        name: name.trim(),
        roleInstruction: roleInstruction.trim(),
        behaviorProfile: behaviorProfile.trim(),
        role,
        modelConfig: {
          ...DEFAULT_MODEL,
          provider,
          model: normalizeModelForProvider(provider, model, safeProviders),
          modelType,
          temperature: Number(temperature || DEFAULT_MODEL.temperature),
        },
      })
      if (!res.success) {
        setError(res.error)
        return
      }

      const agentId = res.data.agent.id
      const postCreateWarnings: string[] = []

      if (behaviorProfileId) {
        const profileRes = await setAgentBehaviorProfile({
          agentId,
          profileId: behaviorProfileId,
          overlay: behaviorProfile.trim(),
        })
        if (!profileRes.success) {
          postCreateWarnings.push(
            `A központi profilt nem sikerült rákötni: ${profileRes.error}`,
          )
        }
      }

      if (cloneTemplate) {
        const cloneRes = await applyAgentCloneSettings({
          targetAgentId: agentId,
          settings: {
            enabledTools: cloneTemplate.enabledTools,
            skillVersionIds: cloneTemplate.skillVersionIds,
            connectors: cloneTemplate.connectors,
            taskOnly: cloneTemplate.taskOnly,
            hiddenFromOperators: cloneTemplate.hiddenFromOperators,
            allowSensitiveExternalModel: cloneTemplate.allowSensitiveExternalModel,
            selfEvolutionProfile: cloneTemplate.selfEvolutionProfile,
          },
        })
        if (!cloneRes.success) {
          postCreateWarnings.push(`A másolás befejezése nem sikerült teljesen: ${cloneRes.error}`)
        }
      }

      if (postCreateWarnings.length > 0) {
        setError(`Az agent létrejött, de ${postCreateWarnings.join(' ')}`)
      }

      storeApiKey(agentId, res.data.apiKey)
      setApiKey(res.data.apiKey)
      setCreatedAgentId(agentId)
      setAgentStatus(res.data.agent.status)
      setStep('tools')
      router.replace(createAgentWizardContinueHref(agentId, 'tools'), { scroll: false })
      router.refresh()
    })
  }

  async function generateProposal() {
    setError(null)
    setProposalWarnings([])
    if (!prompt.trim()) {
      setError('Írd le, milyen agentet szeretnél — a provisioning agent ebből javasol vázat.')
      return
    }
    setGenerating(true)
    try {
      const res = await draftAgentFromDescription({ description: prompt.trim() })
      if (!res.success) {
        setError(res.error)
        return
      }
      const data = res.data as {
        draft: CreateAgentWizardProposal
        validation: { warnings: Array<{ message: string }> }
      }
      const draft = data.draft
      setProposal(draft)
      clearCloneTemplate()
      setCloneSourceId('')
      setName(draft.name)
      setRole(draft.role)
      setRoleInstruction(draft.roleInstruction)
      setBehaviorProfile(draft.behaviorProfile)
      setProvider(draft.modelConfig.provider)
      setModel(
        normalizeModelForProvider(draft.modelConfig.provider, draft.modelConfig.model, safeProviders),
      )
      if (draft.modelConfig.modelType) setModelType(draft.modelConfig.modelType)
      if (typeof draft.modelConfig.temperature === 'number') {
        setTemperature(String(draft.modelConfig.temperature))
      }
      setProposalWarnings(data.validation.warnings.map((w) => w.message))
      setPrompt('')
    } finally {
      setGenerating(false)
    }
  }


  function handleNext() {
    if (step === 'identity' && !isIdentityStepComplete(gate)) {
      setError('Add meg a nevet és a munkaköri leírást.')
      return
    }
    if (step === 'style' && !isStyleStepComplete(gate)) {
      setError('Add meg, hogyan dolgozzon az agent.')
      return
    }
    if (step === 'model' && !createdAgentId) {
      if (!isPreCreateComplete(gate)) {
        setError('Az alapok és a munkastílus még hiányos.')
        return
      }
      createAndContinue()
      return
    }
    const next = nextCreateAgentWizardStep(step)
    if (next) {
      setError(null)
      goTo(next)
    }
  }

  function handleBack() {
    const prev = prevCreateAgentWizardStep(step)
    if (prev && canEnterCreateAgentWizardStep(prev, gate)) {
      setError(null)
      goTo(prev)
    }
  }

  const nextLabel =
    step === 'model' && !createdAgentId
      ? pending
        ? 'Létrehozás…'
        : 'Agent létrehozása és tovább'
      : step === 'done'
        ? null
        : 'Tovább'

  return (
    <Card>
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
          {stepNumber} / {CREATE_AGENT_WIZARD_STEPS.length}
        </p>
        <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">{stepMeta.label}</h2>
        <p className="mt-1 text-sm text-ink-soft">{stepMeta.hint}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <ol className="space-y-2">
          {CREATE_AGENT_WIZARD_STEPS.map((item, index) => {
            const active = step === item.id
            const reachable = canEnterCreateAgentWizardStep(item.id, gate)
            const complete =
              (item.id === 'identity' && isIdentityStepComplete(gate)) ||
              (item.id === 'style' && isStyleStepComplete(gate)) ||
              (item.id === 'model' && Boolean(createdAgentId)) ||
              (item.phase === 'post' &&
                Boolean(createdAgentId) &&
                createAgentWizardStepIndex(step) > index)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => goTo(item.id)}
                  className={`flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? 'border-coral/45 bg-coral/8'
                      : complete
                        ? 'border-sage/35 bg-sage/8'
                        : 'border-ink/12 bg-paper hover:border-coral/25'
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      complete ? 'bg-sage text-card' : active ? 'bg-coral text-card' : 'bg-night-2 text-ink-soft'
                    }`}
                  >
                    {complete ? '✓' : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{item.label}</span>
                    <span className="block truncate text-xs text-ink-soft">{item.hint}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="min-w-0 space-y-5 rounded-md border border-ink/12 bg-wash/35 p-4">
          {createdAgentId && stepMeta.phase === 'pre' ? (
            <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
              Az agent már létrejött. Az alapokat itt átnézheted; a további lépéseken
              eszközöket, skilleket és kapcsolatokat adhatsz hozzá.
            </p>
          ) : null}

          {step === 'identity' ? (
            <div className="space-y-4">
              {!createdAgentId ? (
                <div className="space-y-3 rounded-md border border-ink/12 bg-paper px-3 py-3">
                  <div>
                    <p className="text-sm font-semibold">Másolás meglévő munkatársból</p>
                    <p className="mt-1 text-xs text-ink-soft">
                      Válassz egy agentet sablonnak — a varázsló mezői kitöltődnek az ő
                      beállításaival. Csak az új nevet kell megadnod; a többit átnézheted
                      lépésről lépésre.
                    </p>
                  </div>
                  <label className="block text-sm">
                    <span className="text-ink-soft">Sablon agent</span>
                    <select
                      value={cloneSourceId}
                      onChange={(e) => void handleCloneSourceChange(e.target.value)}
                      disabled={loadingClone || generating || pending || cloneableAgents.length === 0}
                      className={INPUT}
                    >
                      <option value="">Nincs — üres űrlap</option>
                      {cloneableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agentDisplayName(agent.name, agent)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {loadingClone ? (
                    <p className="inline-flex items-center gap-2 text-xs text-ink-soft">
                      <Spinner size="sm" />
                      Sablon betöltése…
                    </p>
                  ) : null}
                  {cloneTemplate ? (
                    <div className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
                      <p className="font-semibold text-sage">
                        „{cloneTemplate.sourceAgentName}" sablonja betöltve — add meg az új nevet,
                        majd lépj tovább.
                      </p>
                      {cloneTemplate.enabledTools.length > 0 ? (
                        <p className="mt-1 text-ink-soft">
                          Eszközök, skillek és kapcsolatok a létrehozáskor másolódnak.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!createdAgentId ? (
                <div className="space-y-3 rounded-md border border-ink/12 bg-paper px-3 py-3">
                  <div>
                    <p className="text-sm font-semibold">Provisioning agent javaslat</p>
                    <p className="mt-1 text-xs text-ink-soft">
                      Írd le természetes nyelven, milyen agent kell — a provisioning agent
                      vázat javasol. Te átnézed és módosítod; az agent a „Létrehozás”
                      gombra jön létre. A javasolt eszközöket, skilleket és kapcsolatokat
                      a következő lépéseken te kapcsolod be.
                    </p>
                  </div>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    disabled={generating || pending}
                    className={INPUT}
                    placeholder="Pl. Belső tudás-asszisztens, aki csak a jóváhagyott wiki-ből válaszol, magyarul, forráshivatkozással…"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void generateProposal()}
                      disabled={generating || pending || !prompt.trim()}
                      className="inline-flex items-center gap-2 rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-card disabled:opacity-50"
                      aria-busy={generating}
                    >
                      {generating ? (
                        <>
                          <Spinner size="sm" className="text-card" />
                          Javaslat készül…
                        </>
                      ) : (
                        'Provisioning agent javasol'
                      )}
                    </button>
                    {proposal ? (
                      <button
                        type="button"
                        onClick={() => {
                          setProposal(null)
                          setProposalWarnings([])
                        }}
                        className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm"
                      >
                        Javaslat elvetése
                      </button>
                    ) : null}
                  </div>
                  {proposal ? (
                    <div className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
                      <p className="font-semibold text-sage">
                        Javaslat betöltve — nézd át az alábbi mezőket, majd lépj tovább.
                        Az eszközök és skillek a létrehozás utáni lépéseken, mentésre kerülnek rá.
                      </p>
                      {proposal.summary ? <p className="mt-1 text-ink-soft">{proposal.summary}</p> : null}
                      {proposal.suggestedCapabilities.length > 0 ? (
                        <p className="mt-1 text-ink-soft">
                          Javasolt eszközök: {proposal.suggestedCapabilities.join(', ')}
                        </p>
                      ) : null}
                      {proposal.suggestedSkills.length > 0 ? (
                        <p className="mt-1 text-ink-soft">
                          Javasolt skillek: {proposal.suggestedSkills.join(', ')}
                        </p>
                      ) : null}
                      {(proposal.suggestedConnectors?.length ?? 0) > 0 ? (
                        <p className="mt-1 text-ink-soft">
                          Javasolt kapcsolatok: {proposal.suggestedConnectors!.join(', ')}
                        </p>
                      ) : null}
                      {proposalWarnings.length > 0 ? (
                        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-ink-soft">
                          {proposalWarnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <label className="block text-sm">
                <span className="text-ink-soft">Név</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder="Wiki agent"
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Registry szerep</span>
                <select
                  value={role}
                  onChange={(e) =>
                    setRole(e.target.value === 'orchestrator' ? 'orchestrator' : 'worker')
                  }
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                >
                  <option value="worker">worker</option>
                  <option value="orchestrator">orchestrator (tool-less)</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Szerep-instrukció („mit csinál”)</span>
                <textarea
                  value={roleInstruction}
                  onChange={(e) => setRoleInstruction(e.target.value)}
                  required
                  rows={4}
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder="Te az Excellence Pay belső tudás-asszisztense vagy. Kizárólag a jóváhagyott belső tudásbázisból válaszolsz."
                />
              </label>
            </div>
          ) : null}

          {step === 'style' ? (
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="text-ink-soft">Központi profil (opcionális)</span>
                <select
                  value={behaviorProfileId}
                  onChange={(e) => setBehaviorProfileId(e.target.value)}
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                >
                  <option value="">Egyedi (nincs központi profil)</option>
                  {profileOptions.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} (v{profile.currentVersion})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Viselkedés-profil („hogyan”)</span>
                <textarea
                  value={behaviorProfile}
                  onChange={(e) => setBehaviorProfile(e.target.value)}
                  required
                  rows={6}
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder="Magyarul, tömören válaszolj, minden állításhoz adj forráshivatkozást..."
                />
              </label>
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.behaviorProfiles,
                    label: 'Új viselkedés-profil',
                    description: 'Céges hangnem, nyelv, formázás — a katalógusban hozod létre.',
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'model' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-ink-soft">Modellforrás (provider)</span>
                  <select
                    value={provider}
                    disabled={Boolean(createdAgentId)}
                    onChange={(e) => {
                      const next =
                        safeProviders.find((p) => p.value === e.target.value) ?? safeProviders[0]
                      setProvider(next.value)
                      setModel(normalizeModelForProvider(next.value, model, safeProviders))
                    }}
                    className={INPUT}
                  >
                    {safeProviders.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-ink-soft">Modell</span>
                  <ModelSelectField
                    provider={provider}
                    model={model}
                    onModelChange={setModel}
                    providers={safeProviders}
                  />
                </label>
                {providerUsesThinkingProfile(provider) ? (
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-ink-soft">Modell típus (gondolkodási profil)</span>
                    <ModelTypeSelectField modelType={modelType} onModelTypeChange={setModelType} />
                  </label>
                ) : null}
              </div>
              <p className="text-xs text-ink-soft">{selectedProvider.hint}</p>
              <label className="block text-sm">
                <span className="text-ink-soft">Temperature</span>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={temperature}
                  disabled={Boolean(createdAgentId)}
                  onChange={(e) => setTemperature(e.target.value)}
                  className="mt-1 w-32 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
                />
              </label>
              {!createdAgentId ? (
                <p className="text-xs text-ink-faint">
                  A tovább gomb itt hozza létre az agentet vázlatként. Utána eszközöket,
                  skilleket és kapcsolatokat adhatsz hozzá — ha közben újat kell
                  definiálnod, az új ablakban nyílik.
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 'tools' && createdAgentId ? (
            <div className="space-y-4">
              <AgentCapabilitiesPanel
                agentId={createdAgentId}
                currentCapabilities={capabilities}
                isOrchestrator={role === 'orchestrator'}
                suggestedTools={
                  role === 'worker'
                    ? proposal?.suggestedCapabilities ?? cloneTemplate?.enabledTools
                    : undefined
                }
                bare
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections,
                    label: 'Új kapcsolat a provisioningban',
                    description: 'Ha egy eszközhöz még nincs connector, itt hozod létre.',
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'skills' && createdAgentId ? (
            <div className="space-y-4">
              <AgentSkillsPanel
                agentId={createdAgentId}
                assigned={assignedSkills}
                assignable={assignableSkills}
                suggestedSkillNames={
                  proposal?.suggestedSkills ??
                  (cloneTemplate
                    ? assignedSkills.map((skill) => skill.name)
                    : undefined)
                }
                canEdit
                bare
                onChanged={refreshCatalogs}
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills,
                    label: 'Új skill a katalógusban',
                    description: 'Importálás vagy appon belüli skill — jóváhagyás után itt hozzárendeled.',
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'connections' && createdAgentId ? (
            <div className="space-y-4">
              <ApiConnectorList agentId={createdAgentId} connectors={connectors} canEdit />
              <AssignExistingConnectorForm
                agentId={createdAgentId}
                connectors={assignableConnectors}
                suggestedConnectorNames={
                  proposal?.suggestedConnectors ??
                  (cloneTemplate ? cloneTemplate.connectors.map((c) => c.name) : undefined)
                }
                bare
                onAssigned={refreshCatalogs}
              />
              <AddApiConnectorForm
                agentId={createdAgentId}
                bare
                onCreated={refreshCatalogs}
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections,
                    label: 'Új kapcsolat definiálása',
                    description: 'Draft connector a provisioning-varázslóban, új ablakban.',
                  },
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors,
                    label: 'Kapcsolat-katalógus',
                    description: 'Meglévő, aktivált kapcsolatok áttekintése.',
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'knowledge' && createdAgentId ? (
            <AgentKnowledgeBasePanel
              agentId={createdAgentId}
              agentName={name || 'Új agent'}
              isOrchestrator={role === 'orchestrator'}
              canUpload
              canApprove
            />
          ) : null}

          {step === 'operation' && createdAgentId ? (
            <div className="space-y-6">
              <PrivacyAdminPanel agentId={createdAgentId} layers={['agent']} />
              <OperatorVisibilityForm
                agentId={createdAgentId}
                hiddenFromOperators={operationDefaults.hiddenFromOperators}
              />
              <TaskOnlyForm agentId={createdAgentId} taskOnly={operationDefaults.taskOnly} />
              <UpdateSelfEvolutionProfileForm
                agentId={createdAgentId}
                currentProfile={operationDefaults.selfEvolutionProfile}
                bare
              />
              <div className="rounded-lg border border-line p-4">
                <p className="mb-3 text-sm font-semibold text-ink">Életciklus</p>
                <AgentLifecycleControls
                  agentId={createdAgentId}
                  status={agentStatus}
                  canManage
                />
              </div>
            </div>
          ) : null}

          {step === 'done' && createdAgentId ? (
            <div className="space-y-4">
              <p className="text-sm text-ink">
                <strong>{name || 'Az agent'}</strong> készen áll. A vázlatot az
                adatlapján aktiválhatod, ha még nem tetted meg.
              </p>
              {apiKey ? (
                <div className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
                  API kulcs (egyszer látható): {apiKey}
                </div>
              ) : (
                <p className="text-xs text-ink-faint">
                  Az API kulcs csak a létrehozáskor látszik. Ha frissítetted az oldalt,
                  az adatlap Technikai adatai között a maszkos előnézet marad.
                </p>
              )}
              <button
                type="button"
                onClick={() => router.push(`/control-plane/agents/${createdAgentId}`)}
                className="rounded-full bg-sage/30 px-4 py-2 text-sm font-semibold"
              >
                Agent megnyitása →
              </button>
            </div>
          ) : null}

          {error ? <p className="text-sm text-coral">{error}</p> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <button
              type="button"
              onClick={handleBack}
              disabled={!prevCreateAgentWizardStep(step) || pending}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft disabled:opacity-50"
            >
              Vissza
            </button>
            {nextLabel ? (
              <button
                type="button"
                onClick={handleNext}
                disabled={pending}
                className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
              >
                {nextLabel}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  )
}
