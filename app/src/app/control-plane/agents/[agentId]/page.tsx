import Link from 'next/link'
import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { isAgentDetailLoadError } from '@/lib/agent-detail-access'
import { loadAgentDetailPageData } from '@/lib/agent-detail-page-data'
import { AgentDetailUnavailable } from '@/components/agents/agent-detail-unavailable'
import { repositories } from '@/repositories/postgres'
import { Badge, Card } from '@/components/ui/shell'
import { ExpandableContent } from '@/components/ui/expandable-content'
import { ChatMarkdown } from '@/components/chat/chat-markdown'
import { Collapsible } from '@/components/ui/collapsible'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { UpdateInstructionForm } from '@/components/agents/update-instruction-form'
import { UpdatePersonaForm } from '@/components/agents/update-persona-form'
import { SensitivityPolicyForm } from '@/components/agents/sensitivity-policy-form'
import { OperatorVisibilityForm } from '@/components/agents/operator-visibility-form'
import { TaskOnlyForm } from '@/components/agents/task-only-form'
import { AgentTaskButton } from '@/components/agents/agent-task-button'
import { AgentAvatarUpload } from '@/components/agents/agent-avatar-upload'
import { UpdateModelConfigForm } from '@/components/agents/update-model-config-form'
import { UpdateSelfEvolutionProfileForm } from '@/components/agents/update-self-evolution-profile-form'
import { AddApiConnectorForm } from '@/components/agents/add-api-connector-form'
import { AssignExistingConnectorForm } from '@/components/agents/assign-existing-connector-form'
import { ApiConnectorList } from '@/components/agents/api-connector-list'
import { AgentKnowledgeBasePanel } from '@/components/agents/agent-knowledge-base-panel'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import { AgentToolAccessDiagnostics } from '@/components/agents/agent-tool-access-diagnostics'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import type { AgentSkillRow, AssignableSkill } from '@/app/actions/skills'
import { WebSearchPolicyCard } from '@/components/agents/web-search-policy-card'
import { AgentLifecycleControls } from '@/components/agents/agent-lifecycle-controls'
import { BehaviorProfileBox } from '@/components/agents/behavior-profile-box'
import { MemoryPanel } from '@/components/agents/memory-panel'
import { resolveSelfEvolutionProfile } from '@/lib/self-evolution-profile'
import { resolveBehaviorOverlay } from '@/lib/behavior-profile'
import { formatToolUiName } from '@/lib/tool-ui-labels'
import {
  agentRoleLabel,
  modelConfigSummary,
  recipeStatusLabel,
  resourceTypeLabel,
  selfEvolutionSummary,
} from '@/lib/agent-profile-labels'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { enabledModelProviders } from '@/lib/model-policy'
import { SettingsSectionShell, type SettingsSection } from '../../system/system-settings-shell'

export const dynamic = 'force-dynamic'

function ProfileSection({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <Card>
      <div className="mb-3">
        <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {children}
    </Card>
  )
}

function ProseBlock({ text, empty }: { text: string | null | undefined; empty: string }) {
  if (!text?.trim()) {
    return <p className="text-sm italic text-ink-faint">{empty}</p>
  }
  return <ChatMarkdown content={text} variant="agent" />
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>
  searchParams: Promise<{ conversation?: string; openChat?: string }>
}) {
  const { agentId } = await params
  const query = await searchParams

  let tenantCtx
  try {
    tenantCtx = await requireTenantRole('viewer')
  } catch (e) {
    if (e instanceof TenantAuthError) notFound()
    throw e
  }

  let loaded
  try {
    loaded = await loadAgentDetailPageData(agentId, tenantCtx)
  } catch (e) {
    if (isAgentDetailLoadError(e) && e.code === 'WRONG_TENANT' && e.meta.agentTenantId) {
      const tenant = await repositories.tenants.findById(e.meta.agentTenantId)
      return (
        <AgentDetailUnavailable
          reason="wrong_tenant"
          agentName={e.meta.agentName ?? 'Ez az agent'}
          tenantId={e.meta.agentTenantId}
          tenantLabel={tenant?.displayName ?? 'másik tenant'}
        />
      )
    }
    if (isAgentDetailLoadError(e) && (e.code === 'NOT_FOUND' || e.code === 'NO_VIEW')) {
      notFound()
    }
    return (
      <AgentDetailUnavailable
        reason="load_failed"
        message={e instanceof Error ? e.message : 'Failed to load agent detail page'}
      />
    )
  }

  const {
    isAdmin,
    canManageKb,
    canApproveKb,
    agent,
    memoryContent,
    memoryVersion,
    recipe,
    resources,
    apiKeyPreview,
    behaviorProfileLink,
    delegatedConnectors,
    governance,
    modelPolicy,
    connectorCatalog,
    behaviorProfiles,
    agentSkills,
    assignableSkills,
    memoryPanel,
    knowledgeBase,
    secondaryError,
  } = loaded

  const openChat = query.openChat === '1' || Boolean(query.conversation)
  const initialConversationId = query.conversation ?? null

  const assignedConnectorIds = new Set(
    governance?.connectors.map((item) => item.connector.id) ?? [],
  )
  const assignableConnectors = (connectorCatalog ?? []).filter(
    (connector) =>
      (connector.type === 'http_api' || connector.type === 'gmail') &&
      !assignedConnectorIds.has(connector.id),
  )
  const modelConfig = agent.modelConfig as Record<string, unknown>
  const persona = personaFor(agent.name, agent)
  const defaultPersona = personaFor(agent.name)
  const mood = humanStatus(agent.status)
  const evolutionProfile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
  const roleInfo = agentRoleLabel(agent.role)
  const modelProviders = modelPolicy ? enabledModelProviders(modelPolicy) : []
  const behaviorOverlay = resolveBehaviorOverlay(agent)

  const agentSections: SettingsSection[] = [
    {
      id: 'munkakor',
      label: 'Munkakör',
      description: 'Mit csinál az agent a csapatban.',
      content: (
        <ProfileSection title="Munkaköri leírás" subtitle="Mit csinál a csapatban">
          <ExpandableContent>
            <ProseBlock text={agent.roleInstruction} empty="Még nincs leírva, miben segít." />
          </ExpandableContent>
        </ProfileSection>
      ),
    },
    {
      id: 'munkastilus',
      label: 'Munkastílus',
      description: 'Hogyan dolgozik — központi profil + egyedi rész.',
      content: (
        <ProfileSection
          title="Munkastílus"
          subtitle="Hogyan dolgozik — központi profil + egyedi rész"
        >
          <BehaviorProfileBox
            agentId={agent.id}
            canEdit={isAdmin}
            profiles={behaviorProfiles}
            link={behaviorProfileLink}
            overlay={behaviorOverlay}
          />
        </ProfileSection>
      ),
    },
    {
      id: 'tanulas',
      label: 'Tanulás',
      description: 'A rögzített tapasztalatok és tanulási szabályok.',
      content: (
        <div className="space-y-6">
          <ProfileSection
            title="Amit eddig megtanult"
            subtitle={
              memoryVersion != null
                ? `${memoryVersion}. frissítés — ezt használja a mindennapi munkában`
                : 'Tanulási emlékek'
            }
          >
            <ExpandableContent>
              <ProseBlock text={memoryContent} empty="Még nincs rögzített tapasztalat." />
            </ExpandableContent>
          </ProfileSection>
          <Card>
            <h2 className="font-display text-xl font-semibold text-ink">Fejlődés</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Itt tudod szerkeszteni vagy törölni a megtanult szabályokat, újakat hozzáadni, és
              korábbi állapotokra visszaállítani.
            </p>
            <Link
              href={`/control-plane/training?agentId=${agent.id}`}
              className="mt-4 inline-block rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky"
            >
              Szabályok szerkesztése / törlése →
            </Link>
          </Card>
        </div>
      ),
    },
    ...(canManageKb
      ? [
          {
            id: 'tudasbazis',
            label: 'Tudásbázis',
            description: 'Az agent által használható dokumentumok és tudásforrások.',
            content: (
              <AgentKnowledgeBasePanel
                agentId={agent.id}
                agentName={persona.nickname}
                isOrchestrator={agent.role === 'orchestrator'}
                canUpload={canManageKb}
                canApprove={canApproveKb}
                initialData={knowledgeBase ?? undefined}
              />
            ),
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            id: 'admin-attekintes',
            label: 'Admin áttekintés',
            description: 'Az agent technikai és életciklus-információi.',
            content: (
              <div className="grid gap-6 xl:grid-cols-2">
                <Card title="Gondolkodási motor">
                  <p className="text-sm text-ink-soft">{modelConfigSummary(modelConfig)}</p>
                  {apiKeyPreview && (
                    <p className="mt-3 text-xs text-ink-faint">API kulcs: {apiKeyPreview}</p>
                  )}
                </Card>
                <Card title="Szerep a rendszerben">
                  <p className="font-medium text-ink">{roleInfo.title}</p>
                  <p className="mt-1 text-sm text-ink-soft">{roleInfo.description}</p>
                  <p className="mt-2 text-xs text-ink-faint">
                    Munkakör v{agent.currentRoleInstructionVersion} · Munkastílus v
                    {agent.currentBehaviorProfileVersion} · Agent v{agent.currentVersion}
                  </p>
                </Card>
                <Card title="Munkafolyamat-sablon">
                  {recipe ? (
                    <div className="space-y-1 text-sm">
                      <p className="font-medium text-ink">{recipe.name}</p>
                      <p className="text-ink-soft">
                        {recipe.ticketType === 'training' ? 'tanítási' : 'interakciós'} folyamat ·
                        v{recipe.version} · {recipeStatusLabel(recipe.status)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-ink-faint">Nincs munkafolyamat-sablon ehhez a verzióhoz.</p>
                  )}
                </Card>
                <Card title="Hozzárendelt források">
                  {resources.length === 0 ? (
                    <p className="text-sm text-ink-faint">Nincs hozzárendelt forrás.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {resources.map((r) => (
                        <li key={r.id} className="atelier-soft p-3">
                          <span className="font-medium text-ink">{r.name}</span>
                          <span className="ml-2 text-ink-faint">
                            {resourceTypeLabel(r.type)} · {r.scope} · v{r.version}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="Önfejlesztés szabályai">
                  <p className="text-sm leading-relaxed text-ink-soft">{selfEvolutionSummary(evolutionProfile)}</p>
                </Card>
                <Card title="Életciklus">
                  <p className="mb-3 text-sm leading-relaxed text-ink-soft">
                    Aktiválás befagyaszt egy reprodukálhatósági verziót; felfüggesztve/nyugdíjazva az agent nem kap új feladatot, a múltbeli munkák visszakereshetők maradnak.
                  </p>
                  <AgentLifecycleControls
                    agentId={agent.id}
                    status={agent.status}
                    suspendedReason={agent.suspendedReason}
                  />
                </Card>
              </div>
            ),
          },
          {
            id: 'projekt-memoria',
            label: 'Projekt-memória',
            description: 'Tartós, conversationök közötti projektfolytonosság.',
            content: (
              <Card title="Projekt-memória (tartós, cross-conversation)">
                <p className="mb-4 text-sm leading-relaxed text-ink-soft">
                  Amit az agent projektfolytonossági állapotként megjegyzett — fókusz, döntések,
                  nyitott feladatok, konfliktusok — és a jóváhagyási/karbantartási/rollback-eszközök.
                </p>
                {memoryPanel ? (
                  <MemoryPanel
                    agentId={agent.id}
                    initialProjectKeys={memoryPanel.projectKeys}
                    initialProjectKey={memoryPanel.initialProjectKey}
                    initialOverview={memoryPanel.initialOverview}
                  />
                ) : (
                  <MemoryPanel agentId={agent.id} />
                )}
              </Card>
            ),
          },
          {
            id: 'eszkozok',
            label: 'Eszközök és kapcsolatok',
            description: 'Engedélyezett eszközök, külső kapcsolatok és webes keresés.',
            content: (
              <div className="space-y-6">
                {governance && (
                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card title="Engedélyezett eszközök">
                      {governance.capabilities.length === 0 ? (
                        <p className="text-sm text-ink-faint">Nincs meghatározott eszközjog.</p>
                      ) : (
                        <ExpandableContent>
                          <ul className="space-y-2 text-sm">
                            {governance.capabilities.map((cap) => (
                              <li key={cap.toolName} className="flex items-center justify-between atelier-soft p-3">
                                <span className="font-medium text-ink">{formatToolUiName(cap.toolName)}</span>
                                <Badge tone={cap.allowed ? 'success' : 'danger'}>{cap.allowed ? 'engedélyezett' : 'tiltott'}</Badge>
                              </li>
                            ))}
                          </ul>
                        </ExpandableContent>
                      )}
                    </Card>
                    <Card title="Külső kapcsolatok">
                      <ApiConnectorList agentId={agent.id} connectors={governance.connectors} />
                    </Card>
                  </div>
                )}
                {governance && <WebSearchPolicyCard agentId={agent.id} connectors={governance.connectors} />}
              </div>
            ),
          },
          {
            id: 'szerkesztes',
            label: 'Szerkesztés',
            description: 'Az agent alapadatainak, modelljének és jogosultságainak kezelése.',
            content: (
              <div className="space-y-6">
                <UpdateInstructionForm agentId={agent.id} roleInstruction={agent.roleInstruction} roleVersion={agent.currentRoleInstructionVersion} />
                <AgentAvatarUpload agentId={agent.id} name={agent.name} status={agent.status} avatarUrl={agent.avatarUrl} personaNickname={agent.personaNickname} />
                <UpdatePersonaForm agentId={agent.id} storedNickname={agent.personaNickname} storedGreeting={agent.personaGreeting} storedTrait={agent.personaTrait} defaultNickname={defaultPersona.nickname} defaultGreeting={defaultPersona.greeting} defaultTrait={defaultPersona.trait} />
                <SensitivityPolicyForm agentId={agent.id} allowSensitiveExternalModel={agent.allowSensitiveExternalModel} />
                <OperatorVisibilityForm agentId={agent.id} hiddenFromOperators={agent.hiddenFromOperators} />
                <TaskOnlyForm agentId={agent.id} taskOnly={agent.taskOnly} />
                <UpdateModelConfigForm agentId={agent.id} providers={modelProviders} current={{
                  provider: String(modelConfig.provider ?? 'chatgpt-oauth'),
                  model: String(modelConfig.model ?? ''),
                  modelType: modelConfig.modelType === 'luna' || modelConfig.modelType === 'terra' || modelConfig.modelType === 'sol' ? modelConfig.modelType : undefined,
                  temperature: typeof modelConfig.temperature === 'number' ? modelConfig.temperature : undefined,
                  maxTokens: typeof modelConfig.maxTokens === 'number' ? modelConfig.maxTokens : undefined,
                  fallbackModels: Array.isArray(modelConfig.fallbackModels) ? (modelConfig.fallbackModels as Array<{ provider: string; model: string }>).filter((row) => row && typeof row.provider === 'string' && typeof row.model === 'string').map((row) => ({ provider: row.provider, model: row.model })) : undefined,
                }} />
                <UpdateSelfEvolutionProfileForm agentId={agent.id} currentProfile={agent.selfEvolutionProfile} />
                <Card title="Külső kapcsolatok kezelése">
                  <p className="mb-4 text-xs text-ink-faint">Új REST API bekötése vagy egy meglévő kapcsolat hozzárendelése. Nyisd ki a kívánt szekciót.</p>
                  <div className="space-y-3">
                    <Collapsible title="Új API-kapcsolat hozzáadása" subtitle="Külső REST API bekötése új connectorként"><AddApiConnectorForm agentId={agent.id} bare /></Collapsible>
                    <Collapsible title="Meglévő kapcsolat hozzárendelése" subtitle="Már aktivált provisioning-kapcsolat csatolása"><AssignExistingConnectorForm agentId={agent.id} connectors={assignableConnectors} bare /></Collapsible>
                  </div>
                </Card>
                {governance && <AgentToolAccessDiagnostics report={governance.toolAccess} />}
                {governance && <AgentCapabilitiesPanel agentId={agent.id} currentCapabilities={governance.capabilities} isOrchestrator={agent.role === 'orchestrator'} />}
                <AgentSkillsPanel agentId={agent.id} assigned={agentSkills as AgentSkillRow[]} assignable={assignableSkills as AssignableSkill[]} />
              </div>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="space-y-6">
      <Link
        href="/control-plane/agents"
        className="inline-block text-sm font-medium text-ink-soft hover:text-coral-deep"
      >
        ← Vissza a csapathoz
      </Link>
      {secondaryError ? (
        <div className="rounded-xl border border-honey/40 bg-honey/10 px-4 py-3 text-sm text-ink-soft">
          Az agent betöltődött, de néhány panel (memória, tudásbázis vagy eszközök) most nem ért
          el. Frissítsd az oldalt, ha hiányzik valami.
        </div>
      ) : null}

      <Card className="animate-rise">
        <div className="flex flex-wrap items-start gap-5">
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="lg"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-[2.2rem] font-semibold leading-none">
                {persona.nickname}
              </h1>
              <span className="text-2xl" aria-hidden>
                {persona.emoji}
              </span>
              <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>{mood.label}</Badge>
            </div>
            <p className="mt-2 max-w-2xl text-base italic text-ink-soft">&quot;{persona.greeting}&quot;</p>
          </div>
          {delegatedConnectors.length > 0 ? (
            <AgentDelegatedConnectorsBar items={delegatedConnectors} variant="sidebar" />
          ) : null}
        </div>
        <div className="estate-rule my-4" />
        <p className="text-sm leading-relaxed text-ink-soft">{persona.trait}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {/* #199 — korlátozott feladatkörű agentnél nincs chat, csak egyetlen
              skill-kötött feladat-indító gomb. */}
          {agent.taskOnly ? (
            <AgentTaskButton agentId={agent.id} />
          ) : (
            <AgentChatButton
              agent={{
                id: agent.id,
                name: agent.name,
                status: agent.status,
                avatarUrl: agent.avatarUrl,
                personaNickname: agent.personaNickname,
                personaGreeting: agent.personaGreeting,
                personaTrait: agent.personaTrait,
              }}
              canDistillSkill={isAdmin}
              initialConversationId={initialConversationId}
              autoOpen={openChat}
            />
          )}
          <AgentMiniAppsLink agentId={agent.id} />
          <span className="text-sm text-ink-faint">
            {roleInfo.title} — {roleInfo.description}
          </span>
        </div>
      </Card>

      <SettingsSectionShell ariaLabel="Agent témák" sections={agentSections} />
    </div>
  )
}
