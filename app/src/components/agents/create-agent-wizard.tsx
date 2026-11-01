'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
} from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { asTranslate } from '@/i18n/translate'
import {
  createAgent,
  getAgent,
  getAgentGovernance,
  listAgentAccess,
  setAgentUserAccess,
  updateAgentAvatar,
  updateAgentCapabilities,
  updateAgentInstruction,
  updateAgentProfile,
  updateAgentWriteApprovalModes,
} from '@/app/actions/platform'
import { updateAgentModelConfig, type getAgentModelSettings } from '@/app/actions/model-config'
import { assignConnectorToAgent } from '@/app/actions/provisioning'
import {
  assignSkillAction,
  getAgentSkillsAction,
  type AgentSkillRow,
  type AssignableSkill,
} from '@/app/actions/skills'
import { ClientPolicyForm } from '@/components/client-policy/client-policy-form'
import { AgentAccessPanel, type AgentAccessUser } from '@/components/agents/agent-access-panel'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentAvatarUpload, fileToAvatarDataUrl } from '@/components/agents/agent-avatar-upload'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import {
  AgentConnectorBindingForm,
  type ConnectorCatalogOption,
} from '@/components/agents/agent-connector-binding-form'
import {
  AgentKnowledgeBasePanel,
  type KbDocumentRow,
} from '@/components/agents/agent-knowledge-base-panel'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import { AgentWikiAccessPanel, type AgentWikiLinkRow } from '@/components/agents/agent-wiki-access-panel'
import { AutonomySlider } from '@/components/agents/hire/autonomy-slider'
import { CapabilityDeck } from '@/components/agents/hire/capability-deck'
import { HireCard, type HireCardModel } from '@/components/agents/hire/hire-card'
import { HireCardList } from '@/components/agents/hire/hire-card-list'
import { InlinePageDialog } from '@/components/agents/hire/inline-page-dialog'
import { LaunchStep } from '@/components/agents/hire/launch-step'
import { AgentMailboxPanel } from '@/components/agents/agent-mailbox-panel'
import type { AgentMailboxSettings } from '@/app/actions/agent-mailbox'
import { StartPaths, type HireStartPath } from '@/components/agents/hire/start-paths'
import { TeamAccessStep } from '@/components/agents/hire/team-access-step'
import { PublishAgentDefinitionForm } from '@/components/agents/publish-agent-definition-form'
import { UpdateLocalRootsForm } from '@/components/agents/update-local-roots-form'
import { UpdateModelConfigForm } from '@/components/agents/update-model-config-form'
import { UpdateOutputFolderForm } from '@/components/agents/update-output-folder-form'
import { UpdateWriteApprovalForm } from '@/components/agents/update-write-approval-form'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Collapsible } from '@/components/ui/collapsible'
import { Card } from '@/components/ui/shell'
import { Spinner } from '@/components/ui/spinner'
import {
  DEFAULT_AUTONOMY_LEVEL,
  autonomyForWriteModes,
  clampAutonomyToCeiling,
  clampWriteModesToCeiling,
  writeModesForAutonomy,
  type AutonomyLevel,
} from '@/lib/agent-autonomy'
import { CAPABILITY_DECK, capabilityDeckLevel } from '@/lib/agent-capability-deck'
import {
  composeRoleInstruction,
  computeHireReadiness,
  draftFromSample,
  hireSharedWithOthers,
  knownToolNames,
  normalizeHireCards,
  parseComposedRoleInstruction,
  suggestDontExamples,
  suggestDutyExamples,
  suggestTestQuestions,
  type HireDraft,
  type HireLocale,
  type HireTone,
} from '@/lib/agent-hire'
import { settingSectionsForWizardStep } from '@/lib/agent-setting-sections'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  CREATE_AGENT_WIZARD_RESUME_STEP,
  CREATE_AGENT_WIZARD_STEPS,
  canEnterCreateAgentWizardStep,
  cloneTemplateFromAgent,
  createAgentWizardContinueHref,
  createAgentWizardLastStepStorageKey,
  createAgentWizardStepIndex,
  grantedToolNames,
  isCreateAgentWizardStepId,
  isDutiesStepComplete,
  isIdentityStepComplete,
  nextCreateAgentWizardStep,
  prevCreateAgentWizardStep,
  type CreateAgentWizardCloneTemplate,
  type CreateAgentWizardStepId,
} from '@/lib/create-agent-wizard'
import type { AgentWriteApprovalModes } from '@/lib/write-approval-modes'

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm'
const EXPERT_STORAGE_KEY = 'agent-hire:expert'
const LESS_MOTION_STORAGE_KEY = 'agent-hire:less-motion'

type AgentStatus = 'draft' | 'active' | 'suspended' | 'retired'
type ModelSettings = Extract<Awaited<ReturnType<typeof getAgentModelSettings>>, { success: true }>['data']
type HermesPolicy = ComponentProps<typeof ClientPolicyForm>['policy']
type Milestone = 'draft' | 'created' | 'access' | 'launched'

export type CreateAgentWizardCloneOption = {
  id: string
  name: string
}

export type CreateAgentWizardContinuation = {
  agentId: string
  /** #1029: a „Saját e-mail cím” lépés adatai (null = nem tölthető be). */
  mailbox?: AgentMailboxSettings | null
  name: string
  roleInstruction: string
  description: string | null
  avatarUrl: string | null
  status: AgentStatus
  currentDefinitionVersionId: string | null
  hasUnpublishedChanges: boolean
  capabilities: Array<{ toolName: string; allowed: boolean }>
  assignedSkills: AgentSkillRow[]
  assignableSkills: AssignableSkill[]
  connectors: Array<{
    connector: { id: string; name: string; type: string }
    accessMode: 'read' | 'write'
  }>
  assignableConnectors: ConnectorCatalogOption[]
  writeModes: AgentWriteApprovalModes
  approverUserId: string | null
  outputDriveFolderId: string | null
  localRoots: string
  knowledgeDocuments: KbDocumentRow[]
  knowledgeCatalog: KbDocumentRow[]
  wikiLinks: AgentWikiLinkRow[] | null
  accessUsers: AgentAccessUser[]
  currentUserId: string
  model: ModelSettings | null
  hermesPolicy: HermesPolicy
  drive: {
    grantId: string | null
    grants: Array<{ id: string; label: string }>
    pickerConfigured: boolean
  }
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // privát ablak / tiltott tárhely — csak kényelmi emlék
  }
}

/** A mentett munkakörből visszaállított kártyák (folytatáskor / másoláskor). */
function rolePartsFrom(input: {
  roleInstruction: string
  name: string
  description: string
  locale: HireLocale
}) {
  const parsed = parseComposedRoleInstruction(input)
  return {
    duties: parsed.duties,
    donts: parsed.donts,
    tone: parsed.tone,
    roleEdited: input.roleInstruction.trim().length > 0 && !parsed.exact,
  }
}

/**
 * „Új munkatárs felvétele” (#957): kezdőbarát varázsló, amely az adatlap
 * minden beállítási területét eléri (lásd `agent-setting-sections`), és
 * ugyanazokat a mentési műveleteket használja, mint az adatlap.
 */
export function CreateAgentWizard({
  cloneableAgents = [],
  initialStep,
  continuation = null,
  catalog = [],
  catalogDetails = [],
  autonomyCeiling = 'autonomous',
  hireDraftQuota = null,
}: {
  cloneableAgents?: CreateAgentWizardCloneOption[]
  initialStep?: string
  /** #957 D3: a céges felső korlát — ennél önállóbb szint nem választható. */
  autonomyCeiling?: AutonomyLevel
  /** #957 D1: a „Mondd el” javaslatok mai kerete (null = ismeretlen). */
  hireDraftQuota?: { limit: number; remaining: number } | null
  continuation?: CreateAgentWizardContinuation | null
  catalog?: ConnectorCatalogOption[]
  /** Teljes connector-katalógus (kötött kapcsolatok leírásához). */
  catalogDetails?: ConnectorCatalogOption[]
}) {
  const router = useRouter()
  const t = asTranslate(useTranslations('AgentCreate'))
  const locale: HireLocale = useLocale() === 'en' ? 'en' : 'hu'
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const c = continuation

  const [step, setStep] = useState<CreateAgentWizardStepId>(() =>
    isCreateAgentWizardStepId(initialStep)
      ? initialStep
      : c
        ? CREATE_AGENT_WIZARD_RESUME_STEP
        : 'start',
  )
  const [expert, setExpert] = useState(false)
  const [lessMotion, setLessMotion] = useState(false)
  const [startPath, setStartPath] = useState<HireStartPath | null>(null)
  const [describeText, setDescribeText] = useState('')

  const [name, setName] = useState(c?.name ?? '')
  const [description, setDescription] = useState(c?.description ?? '')
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null)
  const initialRole = useMemo(
    () =>
      rolePartsFrom({
        roleInstruction: c?.roleInstruction ?? '',
        name: c?.name ?? '',
        description: c?.description ?? '',
        locale,
      }),
    // csak az első betöltéskor — utána a felhasználó kártyái az irányadók
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [duties, setDuties] = useState<string[]>(initialRole.duties)
  const [donts, setDonts] = useState<string[]>(initialRole.donts)
  const [tone, setTone] = useState<HireTone>(initialRole.tone)
  const [rawRole, setRawRole] = useState(c?.roleInstruction ?? '')
  const [roleEdited, setRoleEdited] = useState(initialRole.roleEdited)

  const [createdAgentId, setCreatedAgentId] = useState<string | null>(c?.agentId ?? null)
  const [cloneSourceId, setCloneSourceId] = useState('')
  const [cloneTemplate, setCloneTemplate] = useState<CreateAgentWizardCloneTemplate | null>(null)
  const [loadingClone, setLoadingClone] = useState(false)
  const [suggestedTools, setSuggestedTools] = useState<string[]>([])
  const [suggestedAutonomy, setSuggestedAutonomy] = useState<AutonomyLevel>(DEFAULT_AUTONOMY_LEVEL)
  const [milestone, setMilestone] = useState<Milestone | null>(null)
  const [inline, setInline] = useState<{ href: string; title: string } | null>(null)

  const composedRole = useMemo(
    () => composeRoleInstruction({ name, description, duties, donts, tone, locale }),
    [name, description, duties, donts, tone, locale],
  )
  const roleInstruction = roleEdited ? rawRole : composedRole
  const gate = { name, roleInstruction, description, createdAgentId }
  const live = c?.status === 'active'

  // Kényelmi emlékek (szakértő nézet, animáció, félbehagyott lépés) — csak böngészőben.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- localStorage csak mount után olvasható */
    setExpert(readStorage(EXPERT_STORAGE_KEY) === 'true')
    setLessMotion(readStorage(LESS_MOTION_STORAGE_KEY) === 'true')
    if (c && !isCreateAgentWizardStepId(initialStep)) {
      const remembered = readStorage(createAgentWizardLastStepStorageKey(c.agentId))
      if (isCreateAgentWizardStepId(remembered) && remembered !== 'start') setStep(remembered)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = useCallback(() => {
    startRefresh(() => router.refresh())
  }, [router])

  // Másik lapról / helyben nyíló ablakból visszatérve frissül a lista.
  useEffect(() => {
    if (!createdAgentId) return
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [createdAgentId, refresh])

  useEffect(() => {
    if (!milestone) return
    const timer = window.setTimeout(() => setMilestone(null), 4500)
    return () => window.clearTimeout(timer)
  }, [milestone])

  const enabledTools = useMemo(
    () => new Set(c ? grantedToolNames(c.capabilities) : suggestedTools),
    [c, suggestedTools],
  )
  const activeDeckCards = CAPABILITY_DECK.filter((card) => capabilityDeckLevel(card, enabledTools) !== 'off').length
  const companyConnectorCount = (c?.connectors ?? []).filter(
    (row) => row.connector.type === 'http_api' || row.connector.type === 'mcp',
  ).length
  // A wiki-lista minden elérhető tudásbázist mutat; csak a bekötött, nem saját számít.
  const linkedWikiCount = (c?.wikiLinks ?? []).filter((row) => row.linked && !row.own).length
  const knowledgeCount = (c?.knowledgeDocuments.length ?? 0) + linkedWikiCount
  const readiness = computeHireReadiness({
    name,
    description,
    roleInstruction,
    grantedToolCount: enabledTools.size,
    connectorCount: companyConnectorCount,
    skillCount: c?.assignedSkills.length ?? 0,
    knowledgeDocumentCount: c?.knowledgeDocuments.length ?? 0,
    wikiLinkCount: linkedWikiCount,
    sharedWithOthers: c ? hireSharedWithOthers(c.accessUsers) : false,
    live,
  })

  // Mérföldkő: az első hozzáférés megadása.
  const hadAccess = useRef(readiness.items.find((item) => item.id === 'access')?.done ?? false)
  const hasAccess = readiness.items.find((item) => item.id === 'access')?.done ?? false
  useEffect(() => {
    if (hasAccess && !hadAccess.current && createdAgentId) {
      setMilestone('access')
    }
    hadAccess.current = hasAccess
  }, [hasAccess, createdAgentId])

  const autonomy = c ? autonomyForWriteModes(c.writeModes) : suggestedAutonomy
  const cardModel: HireCardModel = {
    name,
    description,
    avatarUrl: avatarDataUrl ?? c?.avatarUrl ?? null,
    status: c?.status ?? 'draft',
    dutyCount: normalizeHireCards(duties).length || (roleEdited && roleInstruction.trim() ? 1 : 0),
    toolCount: activeDeckCards,
    connectorCount: companyConnectorCount,
    skillCount: c?.assignedSkills.length ?? 0,
    knowledgeCount,
    autonomy,
    live,
  }

  const stepMeta = CREATE_AGENT_WIZARD_STEPS.find((item) => item.id === step) ?? CREATE_AGENT_WIZARD_STEPS[0]
  const visibleSteps = CREATE_AGENT_WIZARD_STEPS.filter((item) => item.id !== 'start' || !createdAgentId)
  const stepNumber = visibleSteps.findIndex((item) => item.id === step) + 1
  const roleText = `${name} ${description} ${duties.join(' ')}`
  const dutyExamples = suggestDutyExamples(roleText, locale)
  const dontExamples = suggestDontExamples(roleText, locale)
  const testQuestions = suggestTestQuestions({
    duties: duties.length > 0 ? duties : roleInstruction.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2)),
    description,
    locale,
  })
  const detailSection = settingSectionsForWizardStep(step)[0]?.detailSection

  function toggleExpert() {
    const next = !expert
    setExpert(next)
    writeStorage(EXPERT_STORAGE_KEY, String(next))
  }

  function toggleLessMotion() {
    const next = !lessMotion
    setLessMotion(next)
    writeStorage(LESS_MOTION_STORAGE_KEY, String(next))
  }

  function applyDraft(draft: HireDraft) {
    setName(draft.name)
    setDescription(draft.description)
    setDuties(draft.duties)
    setDonts(draft.donts)
    setTone(draft.tone)
    setRawRole('')
    setRoleEdited(false)
    setSuggestedTools(knownToolNames(draft.tools))
    setSuggestedAutonomy(clampAutonomyToCeiling(draft.autonomy, autonomyCeiling))
    setCloneTemplate(null)
    setCloneSourceId('')
    setError(null)
    setMilestone('draft')
    setStep('identity')
  }

  function startBlank() {
    setStartPath('blank')
    setCloneTemplate(null)
    setCloneSourceId('')
    setSuggestedTools([])
    setSuggestedAutonomy(DEFAULT_AUTONOMY_LEVEL)
    setError(null)
    setStep('identity')
  }

  async function handleCloneSourceChange(nextSourceId: string) {
    setCloneSourceId(nextSourceId)
    setError(null)
    if (!nextSourceId) {
      setCloneTemplate(null)
      return
    }
    setLoadingClone(true)
    try {
      const [agentRes, govRes, skillsRes, accessRes] = await Promise.all([
        getAgent({ id: nextSourceId }),
        getAgentGovernance({ agentId: nextSourceId }),
        getAgentSkillsAction(nextSourceId),
        listAgentAccess({ agentId: nextSourceId }),
      ])
      if (!agentRes.success || !govRes.success || !skillsRes.success) {
        setError(
          !agentRes.success ? agentRes.error : !govRes.success ? govRes.error : !skillsRes.success ? skillsRes.error : '',
        )
        setCloneTemplate(null)
        return
      }
      const source = agentRes.data
      const template = cloneTemplateFromAgent({
        sourceAgentId: source.id,
        sourceAgentName: source.name,
        roleInstruction: source.roleInstruction,
        description: source.description,
        capabilities: govRes.data.capabilities,
        skills: skillsRes.data,
        connectors: govRes.data.connectors,
        writeModes: source,
        approverUserId: source.approverUserId ?? null,
        modelConfig: source.modelConfig,
        access: accessRes.success ? accessRes.data.users : [],
      })
      const parts = rolePartsFrom({
        roleInstruction: template.roleInstruction,
        name: template.sourceAgentName,
        description: template.description,
        locale,
      })
      setCloneTemplate(template)
      setName('')
      setDescription(template.description)
      setDuties(parts.duties)
      setDonts(parts.donts)
      setTone(parts.tone)
      setRawRole(template.roleInstruction)
      setRoleEdited(parts.roleEdited)
      setSuggestedTools(template.enabledTools)
      const sourceAutonomy = autonomyForWriteModes(template.writeModes)
      setSuggestedAutonomy(
        sourceAutonomy === 'custom' ? DEFAULT_AUTONOMY_LEVEL : clampAutonomyToCeiling(sourceAutonomy, autonomyCeiling),
      )
    } finally {
      setLoadingClone(false)
    }
  }

  async function applyCloneSettings(agentId: string, template: CreateAgentWizardCloneTemplate) {
    const warnings: string[] = []
    if (template.enabledTools.length > 0) {
      const res = await updateAgentCapabilities({ agentId, enabledTools: template.enabledTools })
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
    // A forrás lehet önállóbb, mint amit a céges korlát most enged — a másolat a korlátig kap.
    const writeModes = clampWriteModesToCeiling(template.writeModes, autonomyCeiling)
    const writes = await updateAgentWriteApprovalModes({
      agentId,
      memoryWriteMode: writeModes.memory,
      httpApiWriteMode: writeModes.httpApi,
      gmailWriteMode: writeModes.gmail,
      driveWriteMode: writeModes.drive,
      approverUserId: template.approverUserId,
    })
    if (!writes.success) warnings.push(t('cloneApprovals', { error: writes.error }))
    if (template.modelConfig) {
      const res = await updateAgentModelConfig({ agentId, modelConfig: template.modelConfig })
      if (!res.success) warnings.push(t('cloneModel', { error: res.error }))
    }
    for (const grant of template.access) {
      const res = await setAgentUserAccess({ agentId, userId: grant.userId, accessLevel: grant.accessLevel })
      if (!res.success) warnings.push(t('cloneAccess', { name: grant.label, error: res.error }))
    }
    return warnings
  }

  /** Suggestion → valós beállítás, csak a már létrejött (még nem dolgozó) munkatárson. */
  async function applySuggestions(agentId: string) {
    const warnings: string[] = []
    const tools = knownToolNames(suggestedTools)
    if (tools.length > 0) {
      const res = await updateAgentCapabilities({ agentId, enabledTools: tools })
      if (!res.success) warnings.push(t('cloneTools', { error: res.error }))
    }
    if (suggestedAutonomy !== DEFAULT_AUTONOMY_LEVEL) {
      const modes = writeModesForAutonomy(suggestedAutonomy)
      const res = await updateAgentWriteApprovalModes({
        agentId,
        memoryWriteMode: modes.memory,
        httpApiWriteMode: modes.httpApi,
        gmailWriteMode: modes.gmail,
        driveWriteMode: modes.drive,
      })
      if (!res.success) warnings.push(t('cloneApprovals', { error: res.error }))
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
      const warnings: string[] = []
      if (avatarDataUrl) {
        const avatar = await updateAgentAvatar({ agentId, avatarUrl: avatarDataUrl })
        if (!avatar.success) warnings.push(t('cloneAvatar', { error: avatar.error }))
      }
      warnings.push(
        ...(cloneTemplate ? await applyCloneSettings(agentId, cloneTemplate) : await applySuggestions(agentId)),
      )
      if (warnings.length > 0) setError(t('clonePartial', { warnings: warnings.join(' ') }))
      setCreatedAgentId(agentId)
      setMilestone('created')
      setStep('access')
      writeStorage(createAgentWizardLastStepStorageKey(agentId), 'access')
      router.replace(createAgentWizardContinueHref(agentId, 'access'), { scroll: false })
    })
  }

  /** Létrejött munkatárson a Ki ő? / Mi a dolga? módosításai lépésváltáskor mentődnek. */
  async function saveIdentityAndRole(): Promise<boolean> {
    if (!createdAgentId || !c) return true
    if (!isIdentityStepComplete(gate)) {
      setError(t('identityRequired'))
      return false
    }
    if (!isDutiesStepComplete(gate)) {
      setError(t('dutiesRequired'))
      return false
    }
    const profileChanged = name.trim() !== c.name || description.trim() !== (c.description ?? '')
    if (profileChanged) {
      const res = await updateAgentProfile({
        agentId: createdAgentId,
        name: name.trim(),
        description: description.trim(),
      })
      if (!res.success) {
        setError(res.error)
        return false
      }
    }
    if (roleInstruction.trim() !== c.roleInstruction.trim()) {
      const res = await updateAgentInstruction({ agentId: createdAgentId, roleInstruction: roleInstruction.trim() })
      if (!res.success) {
        setError(res.error)
        return false
      }
    }
    return true
  }

  function goTo(next: CreateAgentWizardStepId) {
    if (!canEnterCreateAgentWizardStep(next, gate)) return
    if (!createdAgentId) {
      setError(null)
      setStep(next)
      return
    }
    startTransition(async () => {
      if ((step === 'identity' || step === 'duties') && !(await saveIdentityAndRole())) return
      setError(null)
      setStep(next)
      writeStorage(createAgentWizardLastStepStorageKey(createdAgentId), next)
      router.replace(createAgentWizardContinueHref(createdAgentId, next), { scroll: false })
    })
  }

  function handleNext() {
    if (step === 'identity' && !isIdentityStepComplete(gate)) {
      setError(t('identityRequired'))
      return
    }
    if (step === 'duties' && !createdAgentId) {
      if (!isDutiesStepComplete(gate)) {
        setError(t('dutiesRequired'))
        return
      }
      createAndContinue()
      return
    }
    const next = nextCreateAgentWizardStep(step)
    if (next) goTo(next)
  }

  function handleBack() {
    const prev = prevCreateAgentWizardStep(step)
    if (prev && canEnterCreateAgentWizardStep(prev, gate)) goTo(prev)
  }

  async function pickAvatar(file: File) {
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError(t('avatarNotImage'))
      return
    }
    try {
      setAvatarDataUrl(await fileToAvatarDataUrl(file))
    } catch {
      setError(t('avatarFailed'))
    }
  }

  const nextLabel =
    step === 'launch'
      ? null
      : step === 'duties' && !createdAgentId
        ? pending
          ? t('creating')
          : t('createAndContinue')
        : step === 'advanced'
          ? t('skipOrNext')
          : t('next')

  const postStepLoading = Boolean(createdAgentId) && !c && stepMeta.phase === 'post'

  const toneChip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
      active ? 'bg-coral text-white' : 'border border-line text-ink-soft hover:border-coral/40 hover:text-ink'
    }`

  const hireCard = (
    <HireCard
      model={cardModel}
      percent={readiness.percent}
      missing={readiness.missing}
      onGoTo={goTo}
      canGoTo={(target) => canEnterCreateAgentWizardStep(target, gate)}
    />
  )

  return (
    <div data-less-motion={lessMotion ? 'true' : 'false'}>
      <Card>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {stepNumber} / {visibleSteps.length}
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">
              {t(`steps.${stepMeta.id}.label`)}
            </h2>
            <p className="mt-1 text-sm text-ink-soft">{t(`steps.${stepMeta.id}.hint`)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" role="switch" className="h-4 w-4 accent-coral" checked={expert} onChange={toggleExpert} />
              {t('expertToggle')}
              <HelpHint>{t('expertHelp')}</HelpHint>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                role="switch"
                className="h-4 w-4 accent-coral"
                checked={lessMotion}
                onChange={toggleLessMotion}
              />
              {t('lessMotion')}
            </label>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_16rem]">
          <ol className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:block lg:space-y-2 lg:overflow-visible lg:px-0">
            {visibleSteps.map((item, index) => {
              const active = step === item.id
              const reachable = canEnterCreateAgentWizardStep(item.id, gate)
              const complete =
                !active &&
                ((item.id === 'identity' && isIdentityStepComplete(gate)) ||
                  (item.id === 'launch' && live) ||
                  (item.id === 'duties' && Boolean(createdAgentId)) ||
                  (item.phase === 'post' && Boolean(createdAgentId) && createAgentWizardStepIndex(step) > createAgentWizardStepIndex(item.id)))
              return (
                <li key={item.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    disabled={!reachable || pending}
                    onClick={() => goTo(item.id)}
                    aria-current={active ? 'step' : undefined}
                    className={`flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? 'border-coral/45 bg-coral/8'
                        : complete
                          ? 'border-sage/35 bg-sage/8'
                          : 'border-ink/12 bg-paper hover:border-coral/25'
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        complete ? 'bg-sage text-white' : active ? 'bg-coral text-white' : 'bg-wash text-ink-soft'
                      }`}
                    >
                      {complete ? '✓' : index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block whitespace-nowrap text-sm font-semibold lg:whitespace-normal">
                        {t(`steps.${item.id}.label`)}
                      </span>
                      <span className="hidden truncate text-xs text-ink-soft lg:block">
                        {item.optional ? t('optional') : t(`steps.${item.id}.hint`)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>

          <div className="min-w-0 space-y-5">
            <details className="rounded-2xl xl:hidden">
              <summary className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-ink/12 bg-paper px-3 py-2 text-sm">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <AgentAvatar name={name || '?'} status={live ? 'active' : 'draft'} avatarUrl={cardModel.avatarUrl} size="sm" />
                  <span className="truncate font-semibold">{name.trim() || t('card.unnamed')}</span>
                </span>
                <span className="text-xs font-semibold text-ink-soft">
                  {t('readiness.short', { percent: readiness.percent })}
                </span>
              </summary>
              <div className="mt-2">{hireCard}</div>
            </details>

            <div className="space-y-5 rounded-md border border-ink/12 bg-wash/35 p-4">
              {milestone ? (
                <p
                  role="status"
                  className="animate-hire-pop rounded-lg border border-sage/35 bg-sage/12 px-3 py-2 text-sm font-semibold text-sage"
                >
                  {t(`milestones.${milestone}`, { name: name.trim() || t('card.unnamed') })}
                </p>
              ) : null}

              <p className="flex gap-2 rounded-lg bg-paper/80 px-3 py-2 text-xs text-ink-soft">
                <span aria-hidden>💡</span>
                <span>{t(`tips.${step}`)}</span>
              </p>

              {expert && createdAgentId && detailSection ? (
                <p className="text-xs">
                  <Link
                    href={`/control-plane/agents/${createdAgentId}?section=${detailSection}`}
                    className="font-semibold text-coral-deep hover:underline"
                  >
                    {t('openDetailSection')}
                  </Link>
                </p>
              ) : null}

              {step === 'start' ? (
                <StartPaths
                  locale={locale}
                  path={startPath}
                  onPathChange={setStartPath}
                  describeText={describeText}
                  onDescribeTextChange={setDescribeText}
                  hireDraftQuota={hireDraftQuota}
                  onDescribeDraft={applyDraft}
                  onSample={(sample) => applyDraft(draftFromSample(sample, locale))}
                  cloneableAgents={cloneableAgents}
                  cloneSourceId={cloneSourceId}
                  onCloneSource={(id) => void handleCloneSourceChange(id)}
                  cloneLoading={loadingClone}
                  cloneLoadedName={cloneTemplate?.sourceAgentName ?? null}
                  onBlank={startBlank}
                />
              ) : null}

              {step === 'identity' ? (
                <div className="space-y-4">
                  <label className="block text-sm">
                    <span className="text-ink-soft">{t('name')}</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={120}
                      className={INPUT}
                      placeholder={t('namePlaceholder')}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="inline-flex items-center text-ink-soft">
                      {t('intro')}
                      <HelpHint>{t('introHelp')}</HelpHint>
                    </span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      required
                      rows={2}
                      maxLength={500}
                      className={INPUT}
                      placeholder={t('introPlaceholder')}
                    />
                  </label>

                  <div className="space-y-2">
                    <p className="text-sm text-ink-soft">{t('avatarTitle')}</p>
                    {createdAgentId && c ? (
                      <AgentAvatarUpload
                        agentId={createdAgentId}
                        name={name || c.name}
                        status={c.status}
                        avatarUrl={c.avatarUrl}
                        bare
                      />
                    ) : (
                      <div className="flex items-center gap-4">
                        <AgentAvatar name={name || '?'} status="draft" avatarUrl={avatarDataUrl} size="lg" />
                        <div className="space-y-2">
                          <p className="text-xs text-ink-faint">{t('avatarAuto')}</p>
                          <div className="flex flex-wrap gap-2">
                            <label className="cursor-pointer rounded-full bg-sky/20 px-4 py-1.5 text-xs font-semibold text-sky">
                              {avatarDataUrl ? t('avatarReplace') : t('avatarUpload')}
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0]
                                  if (file) void pickAvatar(file)
                                  e.target.value = ''
                                }}
                              />
                            </label>
                            {avatarDataUrl ? (
                              <button
                                type="button"
                                onClick={() => setAvatarDataUrl(null)}
                                className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-soft"
                              >
                                {t('avatarRemove')}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <p className="inline-flex items-center text-sm text-ink-soft">
                      {t('toneTitle')}
                      <HelpHint>{t('toneHelp')}</HelpHint>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(['informal', 'formal'] as const).map((value) => (
                        <button key={value} type="button" className={toneChip(tone.address === value)} onClick={() => setTone({ ...tone, address: value })}>
                          {t(`tone.${value}`)}
                        </button>
                      ))}
                      <span aria-hidden className="mx-1 text-ink-faint">·</span>
                      {(['short', 'detailed'] as const).map((value) => (
                        <button key={value} type="button" className={toneChip(tone.length === value)} onClick={() => setTone({ ...tone, length: value })}>
                          {t(`tone.${value}`)}
                        </button>
                      ))}
                      <span aria-hidden className="mx-1 text-ink-faint">·</span>
                      {(['match', 'hu', 'en'] as const).map((value) => (
                        <button key={value} type="button" className={toneChip(tone.language === value)} onClick={() => setTone({ ...tone, language: value })}>
                          {t(`tone.lang.${value}`)}
                        </button>
                      ))}
                    </div>
                    {roleEdited ? <p className="text-xs text-ink-faint">{t('toneManualRole')}</p> : null}
                  </div>
                </div>
              ) : null}

              {step === 'duties' ? (
                <div className="space-y-5">
                  {roleEdited && !expert ? (
                    <div className="space-y-2 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-3 text-xs text-ink">
                      <p className="font-semibold">{t('roleManualTitle')}</p>
                      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-ink-soft">{roleInstruction}</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={toggleExpert} className="rounded-full border border-line px-3 py-1 font-semibold">
                          {t('roleManualEdit')}
                        </button>
                        <button type="button" onClick={() => setRoleEdited(false)} className="rounded-full border border-line px-3 py-1 font-semibold">
                          {t('roleManualRebuild')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {!roleEdited || expert ? (
                    <>
                      <section className="space-y-2">
                        <h3 className="text-sm font-semibold">{t('dutiesTitle')}</h3>
                        <p className="text-xs text-ink-soft">{t('dutiesBody')}</p>
                        <HireCardList
                          cards={duties}
                          onChange={setDuties}
                          placeholder={t('dutyPlaceholder')}
                          addLabel={t('addCard')}
                          examples={dutyExamples}
                          examplesLabel={t('examples')}
                          disabled={roleEdited}
                        />
                      </section>
                      <section className="space-y-2">
                        <h3 className="text-sm font-semibold">{t('dontsTitle')}</h3>
                        <p className="text-xs text-ink-soft">{t('dontsBody')}</p>
                        <HireCardList
                          cards={donts}
                          onChange={setDonts}
                          placeholder={t('dontPlaceholder')}
                          addLabel={t('addCard')}
                          examples={dontExamples}
                          examplesLabel={t('examples')}
                          tone="dont"
                          disabled={roleEdited}
                        />
                      </section>
                    </>
                  ) : null}
                  {expert ? (
                    <label className="block text-sm">
                      <span className="inline-flex items-center text-ink-soft">
                        {t('roleRaw')}
                        <HelpHint>{t('roleRawHelp')}</HelpHint>
                      </span>
                      <textarea
                        value={roleInstruction}
                        onChange={(e) => {
                          setRawRole(e.target.value)
                          setRoleEdited(true)
                        }}
                        rows={10}
                        className={`${INPUT} font-mono text-xs`}
                      />
                      {roleEdited ? (
                        <button
                          type="button"
                          onClick={() => setRoleEdited(false)}
                          className="mt-2 rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft"
                        >
                          {t('roleManualRebuild')}
                        </button>
                      ) : null}
                    </label>
                  ) : !roleEdited && composedRole ? (
                    <Collapsible title={t('rolePreview')} subtitle={t('rolePreviewHint')}>
                      <p className="whitespace-pre-wrap text-xs text-ink-soft">{composedRole}</p>
                    </Collapsible>
                  ) : null}
                  {!createdAgentId ? <p className="text-xs text-ink-faint">{t('createHint')}</p> : null}
                </div>
              ) : null}

              {postStepLoading ? (
                <p className="inline-flex items-center gap-2 text-sm text-ink-soft">
                  <Spinner size="sm" />
                  {t('loading')}
                </p>
              ) : null}

              {step === 'access' && createdAgentId && c ? (
                <div className="space-y-5">
                  {expert ? (
                    <div className="space-y-4">
                      <AgentCapabilitiesPanel agentId={createdAgentId} currentCapabilities={c.capabilities} />
                      <AgentConnectorBindingForm
                        agentId={createdAgentId}
                        bindings={c.connectors}
                        catalog={c.assignableConnectors}
                        catalogDetails={catalogDetails.length > 0 ? catalogDetails : catalog}
                        canManageApprovers
                        onAssigned={refresh}
                      />
                      <AgentSkillsPanel
                        agentId={createdAgentId}
                        assigned={c.assignedSkills}
                        assignable={c.assignableSkills}
                        canEdit
                        isAdmin
                        onChanged={refresh}
                      />
                    </div>
                  ) : (
                    <CapabilityDeck
                      key={grantedToolNames(c.capabilities).sort().join(',')}
                      agentId={createdAgentId}
                      capabilities={c.capabilities}
                      connectors={c.connectors}
                      assignableConnectors={c.assignableConnectors}
                      assignedSkills={c.assignedSkills}
                      assignableSkills={c.assignableSkills}
                      onChanged={refresh}
                      onOpenAccounts={() =>
                        setInline({ href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors, title: t('inline.accounts') })
                      }
                    />
                  )}
                  <div className="rounded-lg border border-line bg-paper/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{t('inline.title')}</p>
                    <p className="mt-1 text-xs text-ink-faint">{t('inline.body')}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(
                        [
                          ['connections', t('inline.newSystem')],
                          ['skills', t('inline.newMethod')],
                          ['connectors', t('inline.accounts')],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setInline({ href: CREATE_AGENT_WIZARD_EXTERNAL_HREFS[key], title: label })}
                          className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-coral/40 hover:text-ink"
                        >
                          + {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={refresh}
                        disabled={refreshing}
                        className="rounded-full px-3 py-1.5 text-xs font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
                      >
                        {refreshing ? t('refreshing') : t('refreshList')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 'mailbox' && createdAgentId && c ? (
                c.mailbox ? (
                  <AgentMailboxPanel key={c.mailbox.primaryConnectorId ?? 'none'} settings={c.mailbox} onChanged={refresh} />
                ) : (
                  <p className="text-sm text-ink-soft">{t('loading')}</p>
                )
              ) : null}

              {step === 'knowledge' && createdAgentId && c ? (
                <div className="space-y-4">
                  {c.knowledgeDocuments.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-ink/20 bg-paper px-3 py-3 text-sm text-ink-soft">
                      {t('knowledgeEmpty')}
                    </p>
                  ) : null}
                  <AgentKnowledgeBasePanel
                    agentId={createdAgentId}
                    documents={c.knowledgeDocuments}
                    catalog={c.knowledgeCatalog}
                    canManage
                  />
                  {c.wikiLinks ? <AgentWikiAccessPanel agentId={createdAgentId} rows={c.wikiLinks} /> : null}
                </div>
              ) : null}

              {step === 'autonomy' && createdAgentId && c ? (
                <div className="space-y-4">
                  <AutonomySlider
                    agentId={createdAgentId}
                    modes={c.writeModes}
                    ceiling={autonomyCeiling}
                    onChanged={refresh}
                  />
                  <Collapsible key={`details-${expert}`} title={t('autonomy.detailsTitle')} subtitle={t('autonomy.detailsHint')} defaultOpen={expert}>
                    <UpdateWriteApprovalForm
                      agentId={createdAgentId}
                      memoryWriteMode={c.writeModes.memory}
                      httpApiWriteMode={c.writeModes.httpApi}
                      gmailWriteMode={c.writeModes.gmail}
                      driveWriteMode={c.writeModes.drive}
                      approverUserId={c.approverUserId}
                    />
                  </Collapsible>
                  {CAPABILITY_DECK.some(
                    (card) => (card.id === 'documents' || card.id === 'sheets') && capabilityDeckLevel(card, enabledTools) !== 'off',
                  ) || c.connectors.some((row) => row.connector.type === 'google_drive') ? (
                    <Collapsible title={t('autonomy.driveTitle')} subtitle={t('autonomy.driveHint')} defaultOpen>
                      <UpdateOutputFolderForm
                        agentId={createdAgentId}
                        outputDriveFolderId={c.outputDriveFolderId}
                        driveGrantId={c.drive.grantId}
                        driveGrants={c.drive.grants}
                        drivePickerConfigured={c.drive.pickerConfigured}
                      />
                    </Collapsible>
                  ) : null}
                </div>
              ) : null}

              {step === 'team' && createdAgentId && c ? (
                expert ? (
                  <AgentAccessPanel agentId={createdAgentId} users={c.accessUsers} />
                ) : (
                  <TeamAccessStep agentId={createdAgentId} users={c.accessUsers} onChanged={refresh} />
                )
              ) : null}

              {step === 'advanced' && createdAgentId && c ? (
                <div key={`advanced-${expert}`} className="space-y-3">
                  {c.model ? (
                    <Collapsible title={t('advanced.modelTitle')} subtitle={t('advanced.modelHint')} defaultOpen={expert}>
                      <UpdateModelConfigForm
                        agentId={createdAgentId}
                        policy={c.model.policy}
                        globalChain={c.model.globalChain}
                        config={c.model.config}
                        effectivePrimary={c.model.effectivePrimary}
                        maxAttempts={c.model.maxAttempts}
                        canEdit
                      />
                    </Collapsible>
                  ) : null}
                  <Collapsible title={t('advanced.hermesTitle')} subtitle={t('advanced.hermesHint')} defaultOpen={expert}>
                    <ClientPolicyForm
                      key={createdAgentId}
                      scope="agent"
                      scopeId={createdAgentId}
                      policy={c.hermesPolicy}
                      tenantPolicy={null}
                    />
                  </Collapsible>
                  <Collapsible title={t('advanced.localRootsTitle')} subtitle={t('advanced.localRootsHint')} defaultOpen={expert}>
                    <UpdateLocalRootsForm agentId={createdAgentId} localRoots={c.localRoots} bare />
                  </Collapsible>
                </div>
              ) : null}

              {step === 'launch' && createdAgentId && c ? (
                <div className="space-y-5">
                  <div className="xl:hidden">{hireCard}</div>
                  <LaunchStep
                    agentId={createdAgentId}
                    name={name}
                    status={c.status}
                    hasUnpublishedChanges={c.hasUnpublishedChanges}
                    testQuestions={testQuestions}
                    autonomyIsTrainee={autonomy === 'trainee'}
                    onLaunched={() => {
                      setMilestone('launched')
                      refresh()
                    }}
                  />
                  {expert ? (
                    <PublishAgentDefinitionForm
                      agentId={createdAgentId}
                      currentDefinitionId={c.currentDefinitionVersionId}
                      status={c.status}
                      goLive
                      wizard
                      hasUnpublishedChanges={c.hasUnpublishedChanges}
                      onChanged={refresh}
                    />
                  ) : null}
                  <Link
                    href={`/control-plane/agents/${createdAgentId}`}
                    className="inline-block rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage"
                  >
                    {t('openAgent')}
                  </Link>
                </div>
              ) : null}

              {error ? <p className="text-sm text-coral">{error}</p> : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={
                    pending ||
                    !prevCreateAgentWizardStep(step) ||
                    !canEnterCreateAgentWizardStep(prevCreateAgentWizardStep(step)!, gate)
                  }
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

          <aside className="hidden xl:block">
            <div className="sticky top-4">{hireCard}</div>
          </aside>
        </div>
      </Card>
      {inline ? (
        <InlinePageDialog
          href={inline.href}
          title={inline.title}
          onClose={() => {
            setInline(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
