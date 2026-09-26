'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { asTranslate } from '@/i18n/translate'
import {
  createAgent,
  getAgent,
  getAgentGovernance,
  updateAgentCapabilities,
} from '@/app/actions/platform'
import { assignConnectorToAgent, listConnectorCatalog } from '@/app/actions/provisioning'
import {
  assignSkillAction,
  getAgentSkillsAction,
  listAssignableSkillsAction,
  type AgentSkillRow,
  type AssignableSkill,
} from '@/app/actions/skills'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import {
  AgentConnectorBindingForm,
  type ConnectorCatalogOption,
} from '@/components/agents/agent-connector-binding-form'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import { PublishAgentDefinitionForm } from '@/components/agents/publish-agent-definition-form'
import { Card } from '@/components/ui/shell'
import { Spinner } from '@/components/ui/spinner'
import { WizardExternalPrompt } from '@/components/ui/wizard-external-prompt'
import { agentDisplayName } from '@/lib/agent-persona'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  CREATE_AGENT_WIZARD_STEPS,
  canEnterCreateAgentWizardStep,
  cloneTemplateFromAgent,
  createAgentWizardContinueHref,
  createAgentWizardStepIndex,
  isIdentityStepComplete,
  nextCreateAgentWizardStep,
  parseCreateAgentWizardStep,
  prevCreateAgentWizardStep,
  type CreateAgentWizardCloneTemplate,
  type CreateAgentWizardStepId,
} from '@/lib/create-agent-wizard'

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm'

export type CreateAgentWizardCloneOption = {
  id: string
  name: string
}

export type CreateAgentWizardContinuation = {
  agentId: string
  name: string
  roleInstruction: string
  description: string | null
  status: 'draft' | 'active' | 'suspended' | 'retired'
  currentDefinitionVersionId: string | null
  capabilities: Array<{ toolName: string; allowed: boolean }>
  assignedSkills: AgentSkillRow[]
  assignableSkills: AssignableSkill[]
  connectors: Array<{
    connector: { id: string; name: string; type: string }
    accessMode: 'read' | 'write'
  }>
  assignableConnectors: ConnectorCatalogOption[]
}

export function CreateAgentWizard({
  cloneableAgents = [],
  initialStep,
  continuation = null,
  catalog = [],
  catalogDetails = [],
}: {
  cloneableAgents?: CreateAgentWizardCloneOption[]
  initialStep?: string
  continuation?: CreateAgentWizardContinuation | null
  catalog?: ConnectorCatalogOption[]
  /** Teljes connector-katalógus (kötött kapcsolatok leírásához). */
  catalogDetails?: ConnectorCatalogOption[]
}) {
  const router = useRouter()
  const t = asTranslate(useTranslations('AgentCreate'))
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [step, setStep] = useState<CreateAgentWizardStepId>(() =>
    parseCreateAgentWizardStep(initialStep),
  )
  const [name, setName] = useState(continuation?.name ?? '')
  const [roleInstruction, setRoleInstruction] = useState(continuation?.roleInstruction ?? '')
  const [description, setDescription] = useState(continuation?.description ?? '')
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(continuation?.agentId ?? null)
  const [agentStatus, setAgentStatus] = useState(continuation?.status ?? 'draft')
  const [currentDefinitionId, setCurrentDefinitionId] = useState(
    continuation?.currentDefinitionVersionId ?? null,
  )
  const [capabilities, setCapabilities] = useState(continuation?.capabilities ?? [])
  const [assignedSkills, setAssignedSkills] = useState(continuation?.assignedSkills ?? [])
  const [assignableSkills, setAssignableSkills] = useState(continuation?.assignableSkills ?? [])
  const [connectors, setConnectors] = useState(continuation?.connectors ?? [])
  const [assignableConnectors, setAssignableConnectors] = useState(
    continuation?.assignableConnectors ?? catalog,
  )
  const [connectorCatalogDetails, setConnectorCatalogDetails] = useState(
    catalogDetails.length > 0 ? catalogDetails : catalog,
  )
  const [cloneSourceId, setCloneSourceId] = useState('')
  const [cloneTemplate, setCloneTemplate] = useState<CreateAgentWizardCloneTemplate | null>(null)
  const [loadingClone, setLoadingClone] = useState(false)

  const gate = { name, roleInstruction, description, createdAgentId }
  const stepMeta = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === step) ?? CREATE_AGENT_WIZARD_STEPS[0]
  const stepNumber = createAgentWizardStepIndex(step) + 1

  const refreshCatalogs = useCallback(() => {
    if (!createdAgentId) return
    startRefresh(async () => {
      const [skillsRes, assignableRes, govRes, catalogRes] = await Promise.all([
        getAgentSkillsAction(createdAgentId),
        listAssignableSkillsAction(createdAgentId),
        getAgentGovernance({ agentId: createdAgentId }),
        listConnectorCatalog(),
      ])
      if (skillsRes.success) setAssignedSkills(skillsRes.data)
      if (assignableRes.success) setAssignableSkills(assignableRes.data.assignable)
      if (govRes.success) {
        setCapabilities(govRes.data.capabilities)
        setConnectors(govRes.data.connectors)
        const assignedIds = govRes.data.connectors.map((row) => row.connector.id)
        const nextCatalog = catalogRes.success ? catalogRes.data : assignableConnectors
        if (catalogRes.success) setConnectorCatalogDetails(catalogRes.data)
        setAssignableConnectors(nextCatalog.filter((item) => !assignedIds.includes(item.id)))
      }
    })
  }, [assignableConnectors, createdAgentId])

  function goTo(next: CreateAgentWizardStepId) {
    if (!canEnterCreateAgentWizardStep(next, gate)) return
    setStep(next)
    if (createdAgentId) {
      router.replace(createAgentWizardContinueHref(createdAgentId, next), { scroll: false })
    }
  }

  function applyCloneTemplate(template: CreateAgentWizardCloneTemplate) {
    setCloneTemplate(template)
    setName('')
    setRoleInstruction(template.roleInstruction)
    setDescription(template.description)
  }

  function clearCloneTemplate() {
    setCloneTemplate(null)
    setCloneSourceId('')
    setName('')
    setRoleInstruction('')
    setDescription('')
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
      const [agentRes, govRes, skillsRes] = await Promise.all([
        getAgent({ id: nextSourceId }),
        getAgentGovernance({ agentId: nextSourceId }),
        getAgentSkillsAction(nextSourceId),
      ])
      if (!agentRes.success) {
        setError(agentRes.error)
        clearCloneTemplate()
        return
      }
      if (!govRes.success) {
        setError(govRes.error)
        clearCloneTemplate()
        return
      }
      if (!skillsRes.success) {
        setError(skillsRes.error)
        clearCloneTemplate()
        return
      }
      applyCloneTemplate(
        cloneTemplateFromAgent({
          sourceAgentId: agentRes.data.id,
          sourceAgentName: agentRes.data.name,
          roleInstruction: agentRes.data.roleInstruction,
          description: agentRes.data.description,
          capabilities: govRes.data.capabilities,
          skills: skillsRes.data,
          connectors: govRes.data.connectors,
        }),
      )
    } finally {
      setLoadingClone(false)
    }
  }

  async function applyCloneSettings(agentId: string, template: CreateAgentWizardCloneTemplate) {
    const warnings: string[] = []
    if (template.enabledTools.length > 0) {
      const res = await updateAgentCapabilities({
        agentId,
        enabledTools: template.enabledTools,
      })
      if (!res.success) warnings.push(t('cloneTools', { error: res.error }))
    }
    for (const skillVersionId of template.skillVersionIds) {
      const res = await assignSkillAction({ agentId, skillVersionId })
      if (!res.success) warnings.push(t('cloneSkill', { error: res.error }))
    }
    for (const connector of template.connectors) {
      const res = await assignConnectorToAgent({
        agentId,
        connectorId: connector.connectorId,
        accessMode: connector.accessMode,
      })
      if (!res.success) warnings.push(t('cloneConnector', { name: connector.name, error: res.error }))
    }
    return warnings
  }

  function createAndContinue() {
    startTransition(async () => {
      setError(null)
      const res = await createAgent({
        name: name.trim(),
        roleInstruction: roleInstruction.trim(),
        description: description.trim(),
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      const agentId = res.data.agent.id
      if (cloneTemplate) {
        const warnings = await applyCloneSettings(agentId, cloneTemplate)
        if (warnings.length > 0) {
          setError(t('clonePartial', { warnings: warnings.join(' ') }))
        }
      }
      const [skillsRes, assignableRes, govRes, catalogRes] = await Promise.all([
        getAgentSkillsAction(agentId),
        listAssignableSkillsAction(agentId),
        getAgentGovernance({ agentId }),
        listConnectorCatalog(),
      ])
      if (skillsRes.success) setAssignedSkills(skillsRes.data)
      if (assignableRes.success) setAssignableSkills(assignableRes.data.assignable)
      if (govRes.success) {
        setCapabilities(govRes.data.capabilities)
        setConnectors(govRes.data.connectors)
        const assignedIds = new Set(govRes.data.connectors.map((row) => row.connector.id))
        const nextCatalog = catalogRes.success ? catalogRes.data : catalog
        setAssignableConnectors(nextCatalog.filter((item) => !assignedIds.has(item.id)))
      }
      setCreatedAgentId(agentId)
      setAgentStatus(res.data.agent.status)
      setCurrentDefinitionId(res.data.agent.currentDefinitionVersionId)
      setStep('tools')
      router.replace(createAgentWizardContinueHref(agentId, 'tools'), { scroll: false })
    })
  }

  function handleNext() {
    if (step === 'identity' && !createdAgentId) {
      if (!isIdentityStepComplete(gate)) {
        setError(t('nameRequired'))
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
    step === 'identity' && !createdAgentId
      ? pending
        ? t('creating')
        : t('createAndContinue')
      : step === 'done'
        ? null
        : t('next')

  return (
    <Card>
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
          {stepNumber} / {CREATE_AGENT_WIZARD_STEPS.length}
        </p>
        <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">
          {t(`steps.${stepMeta.id}.label`)}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{t(`steps.${stepMeta.id}.hint`)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <ol className="space-y-2">
          {CREATE_AGENT_WIZARD_STEPS.map((item, index) => {
            const active = step === item.id
            const reachable = canEnterCreateAgentWizardStep(item.id, gate)
            const complete =
              (item.id === 'identity' && Boolean(createdAgentId || isIdentityStepComplete(gate))) ||
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
                      complete
                        ? 'bg-sage text-white'
                        : active
                          ? 'bg-coral text-white'
                          : 'bg-wash text-ink-soft'
                    }`}
                  >
                    {complete ? '✓' : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{t(`steps.${item.id}.label`)}</span>
                    <span className="block truncate text-xs text-ink-soft">{t(`steps.${item.id}.hint`)}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="min-w-0 space-y-5 rounded-md border border-ink/12 bg-wash/35 p-4">
          {createdAgentId && step === 'identity' ? (
            <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
              {t('alreadyCreated')}
            </p>
          ) : null}

          {step === 'identity' ? (
            <div className="space-y-4">
              {!createdAgentId ? (
                <div className="space-y-3 rounded-md border border-ink/12 bg-paper px-3 py-3">
                  <div>
                    <p className="text-sm font-semibold">{t('cloneTitle')}</p>
                    <p className="mt-1 text-xs text-ink-soft">{t('cloneBody')}</p>
                  </div>
                  <label className="block text-sm">
                    <span className="text-ink-soft">{t('cloneSelect')}</span>
                    <select
                      value={cloneSourceId}
                      onChange={(e) => void handleCloneSourceChange(e.target.value)}
                      disabled={loadingClone || pending || cloneableAgents.length === 0}
                      className={INPUT}
                    >
                      <option value="">{t('cloneNone')}</option>
                      {cloneableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agentDisplayName(agent.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {loadingClone ? (
                    <p className="inline-flex items-center gap-2 text-xs text-ink-soft">
                      <Spinner size="sm" />
                      {t('cloneLoading')}
                    </p>
                  ) : null}
                  {cloneTemplate ? (
                    <div className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
                      <p className="font-semibold text-sage">
                        {t('cloneLoaded', { name: cloneTemplate.sourceAgentName })}
                      </p>
                      <p className="mt-1 text-ink-soft">{t('cloneCopied')}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <label className="block text-sm">
                <span className="text-ink-soft">{t('name')}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder={t('namePlaceholder')}
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">{t('scope')}</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  rows={3}
                  maxLength={500}
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder={t('scopePlaceholder')}
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">{t('role')}</span>
                <textarea
                  value={roleInstruction}
                  onChange={(e) => setRoleInstruction(e.target.value)}
                  required
                  rows={8}
                  disabled={Boolean(createdAgentId)}
                  className={INPUT}
                  placeholder={t('rolePlaceholder')}
                />
              </label>
              {!createdAgentId ? (
                <p className="text-xs text-ink-faint">{t('identityHint')}</p>
              ) : null}
            </div>
          ) : null}

          {step === 'tools' && createdAgentId ? (
            <div className="space-y-4">
              <AgentCapabilitiesPanel
                agentId={createdAgentId}
                currentCapabilities={capabilities}
                suggestedTools={cloneTemplate?.enabledTools}
                bare
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections,
                    label: t('newConnector'),
                    description: t('newConnectorHint'),
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
                suggestedSkillNames={cloneTemplate ? assignedSkills.map((skill) => skill.name) : undefined}
                canEdit
                isAdmin
                bare
                onChanged={refreshCatalogs}
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills,
                    label: t('newSkill'),
                    description: t('newSkillHint'),
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'connections' && createdAgentId ? (
            <div className="space-y-4">
              <AgentConnectorBindingForm
                agentId={createdAgentId}
                bindings={connectors}
                catalog={assignableConnectors}
                catalogDetails={connectorCatalogDetails}
                suggestedConnectorNames={cloneTemplate?.connectors.map((item) => item.name)}
                bare
                onAssigned={refreshCatalogs}
              />
              <WizardExternalPrompt
                links={[
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections,
                    label: t('defineConnector'),
                    description: t('defineConnectorHint'),
                  },
                  {
                    href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors,
                    label: t('linkedAccounts'),
                    description: t('linkedAccountsHint'),
                  },
                ]}
                onRefresh={refreshCatalogs}
                refreshing={refreshing}
              />
            </div>
          ) : null}

          {step === 'done' && createdAgentId ? (
            <div className="space-y-4">
              <p className="text-sm text-ink">
                {t('draftReady', { name: name || t('draftReadyFallback') })}
              </p>
              <PublishAgentDefinitionForm
                agentId={createdAgentId}
                currentDefinitionId={
                  continuation?.currentDefinitionVersionId ?? currentDefinitionId
                }
                status={continuation?.status ?? agentStatus}
                goLive
                wizard
                bare
                onChanged={(next) => {
                  setCurrentDefinitionId(next.definitionId)
                  setAgentStatus(next.status)
                }}
              />
              <button
                type="button"
                onClick={() => router.push(`/control-plane/agents/${createdAgentId}`)}
                className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage"
              >
                {t('openAgent')}
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
              {t('back')}
            </button>
            {nextLabel ? (
              <button
                type="button"
                onClick={handleNext}
                disabled={pending}
                className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
