import Link from 'next/link'
import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { isAgentDetailLoadError } from '@/lib/agent-detail-access'
import { loadAgentDetailPageData } from '@/lib/agent-detail-page-data'
import { AgentDetailUnavailable } from '@/components/agents/agent-detail-unavailable'
import { repositories } from '@/repositories/postgres'
import { Badge, Card } from '@/components/ui/shell'
import { EditableCard } from '@/components/ui/editable-card'
import { ExpandableContent } from '@/components/ui/expandable-content'
import { ChatMarkdown } from '@/components/chat/chat-markdown'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentIdentityCard } from '@/components/agents/agent-identity-card'
import { AgentRoleDescriptionButton } from '@/components/agents/agent-role-description-modal'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { AgentIdCopyButton } from '@/components/agents/agent-id-copy-button'
import { UpdateInstructionForm } from '@/components/agents/update-instruction-form'
import { UpdatePersonaForm } from '@/components/agents/update-persona-form'
import { PrivacyAdminPanel } from '@/components/privacy/privacy-admin-panel'
import { getPrivacyAdminView } from '@/app/actions/privacy'
import { OperatorVisibilityForm } from '@/components/agents/operator-visibility-form'
import { TaskOnlyForm } from '@/components/agents/task-only-form'
import { OperatorSkillManagementForm } from '@/components/agents/operator-skill-management-form'
import { EfficiencyAdvisorPanel } from '@/components/agents/efficiency-advisor-panel'
import { AgentTaskButton } from '@/components/agents/agent-task-button'
import { AgentAvatarUpload } from '@/components/agents/agent-avatar-upload'
import { UpdateModelConfigForm } from '@/components/agents/update-model-config-form'
import { UpdateSelfEvolutionProfileForm } from '@/components/agents/update-self-evolution-profile-form'
import { AssignConnectorModal } from '@/components/agents/assign-existing-connector-form'
import { ApiConnectorList } from '@/components/agents/api-connector-list'
import { AgentKnowledgeBasePanel } from '@/components/agents/agent-knowledge-base-panel'
import { AgentCapabilitiesPanel } from '@/components/agents/agent-capabilities-panel'
import { AgentDiagnosticsPanel } from '@/components/agents/agent-diagnostics-panel'
import { AgentToolsOverview } from '@/components/agents/agent-tools-overview'
import { AgentSkillsPanel } from '@/components/agents/agent-skills-panel'
import type { AgentSkillRow, AssignableSkill } from '@/app/actions/skills'
import { WebSearchPolicyCard } from '@/components/agents/web-search-policy-card'
import { AgentLifecycleControls } from '@/components/agents/agent-lifecycle-controls'
import { CodeSandboxConnectorPanel } from '@/components/agents/code-sandbox-connector-panel'
import {
  BehaviorProfileEditForm,
  BehaviorProfileView,
} from '@/components/agents/behavior-profile-box'
import { MemoryPanel } from '@/components/agents/memory-panel'
import { resolveSelfEvolutionProfile } from '@/lib/self-evolution-profile'
import { resolveBehaviorOverlay } from '@/lib/behavior-profile'
import {
  agentRoleLabel,
  modelConfigSummary,
  selfEvolutionSummary,
} from '@/lib/agent-profile-labels'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { enabledModelProviders } from '@/lib/model-policy'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import { RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE } from '@/domain/agents/run-analyst-role'
import { SettingsSectionShell, type SettingsSection } from '../../system/system-settings-shell'

export const dynamic = 'force-dynamic'

/**
 * EGY TÉMA — EGY HELY.
 *
 * Az oldal témánként szerveződik (munkakör, munkastílus, tanulás, eszközök,
 * kapcsolatok…). Minden témán belül ugyanaz a doboz mutatja az információt és —
 * ha az admin rákattint a „Szerkesztés" gombra — ugyanott engedi módosítani.
 * Nincs külön „Szerkesztés" menüpont: az csak megduplázta a dobozokat, és nem
 * derült ki, melyik az érvényes adat.
 */

function InfoCard({
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
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{title}</h2>
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
  embedded = false,
}: {
  params: Promise<{ agentId: string }>
  searchParams: Promise<{
    conversation?: string
    openChat?: string
    granted?: string
    /** RA-08: Futás-elemző — szerkeszthető első üzenet a chat composerben. */
    prefill?: string
    /** EFF-12: hatékonysági link → szekció (pl. motor, kapcsolatok). */
    section?: string
  }>
  /** Workspace Adatlap-fül: nincs vissza-link, a chat/feladat a füleken van. */
  embedded?: boolean
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
  let privacyRes
  try {
    ;[loaded, privacyRes] = await Promise.all([
      loadAgentDetailPageData(agentId, tenantCtx),
      getPrivacyAdminView({ agentId, layer: 'agent' }),
    ])
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

  const isPlatformAdmin = Boolean(
    tenantCtx.platformRoles?.some((r) => r === 'superadmin' || r === 'platform_operator'),
  )
  const {
    isAdmin,
    canManageKb,
    canApproveKb,
    canManageSkills,
    agent,
    memoryContent,
    memoryVersion,
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
    efficiencyAdvisor,
    secondaryError,
  } = loaded

  const openChat = query.openChat === '1' || Boolean(query.conversation)
  const initialConversationId = query.conversation ?? null
  const resumeAfterGrant = query.granted === '1'
  const initialPrefill = query.prefill?.trim() ? query.prefill : null

  const assignedConnectorIds = new Set(
    governance?.connectors.map((item) => item.connector.id) ?? [],
  )
  const sandboxCapabilityMissingConnector = Boolean(
    governance?.capabilities.some((capability) => capability.toolName === 'sandbox_exec' && capability.allowed)
    && !governance.connectors.some((item) => item.connector.type === 'code_sandbox'),
  )
  const assignableConnectors = (connectorCatalog ?? []).filter(
    (connector) =>
      (connector.type === 'http_api' || connector.type === 'gmail' || connector.type === 'code_sandbox') &&
      !assignedConnectorIds.has(connector.id),
  )
  const capabilitiesLocked = agent.systemRole === RUN_ANALYST_SYSTEM_ROLE
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
        <EditableCard
          title="Munkaköri leírás"
          subtitle={`Mit csinál a csapatban — jelenleg v${agent.currentRoleInstructionVersion}`}
          canEdit={isAdmin}
          view={
            <ExpandableContent>
              <ProseBlock text={agent.roleInstruction} empty="Még nincs leírva, miben segít." />
            </ExpandableContent>
          }
          edit={
            <UpdateInstructionForm
              agentId={agent.id}
              roleInstruction={agent.roleInstruction}
              roleVersion={agent.currentRoleInstructionVersion}
              bare
            />
          }
        />
      ),
    },
    {
      id: 'munkastilus',
      label: 'Munkastílus',
      description: 'Hogyan dolgozik — központi profil + egyedi rész.',
      content: (
        <EditableCard
          title="Munkastílus"
          subtitle="Hogyan dolgozik — központi profil + egyedi rész"
          canEdit={isAdmin}
          view={<BehaviorProfileView link={behaviorProfileLink} overlay={behaviorOverlay} />}
          edit={
            <BehaviorProfileEditForm
              agentId={agent.id}
              profiles={behaviorProfiles}
              link={behaviorProfileLink}
              overlay={behaviorOverlay}
            />
          }
        />
      ),
    },
    {
      id: 'hatekonysag',
      label: 'Hatékonyság',
      description: 'Mire megy el a token, és mit lehetne olcsóbban csinálni.',
      content: efficiencyAdvisor ? (
        <EfficiencyAdvisorPanel
          view={efficiencyAdvisor}
          agentId={agent.id}
          canApply={isAdmin}
        />
      ) : (
        <p className="text-sm text-ink-faint">A hatékonysági kártya most nem érhető el.</p>
      ),
    },
    {
      id: 'tanulas',
      label: 'Tanulás',
      description: 'A rögzített tapasztalatok és az önfejlesztés szabályai.',
      content: (
        <div className="space-y-6">
          <InfoCard
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
            {/* A tanult szabályok szerkesztése külön munkafelületen történik (verziózás,
                visszaállítás), ezért itt nem doboz-belső szerkesztés, hanem átvezetés. */}
            <Link
              href={`/control-plane/agents/${agent.id}/training`}
              className="mt-4 inline-block rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky"
            >
              Szabályok szerkesztése / törlése →
            </Link>
          </InfoCard>
          <EditableCard
            title="Önfejlesztés szabályai"
            subtitle="Mit módosíthat magán az agent, és ki hagyja jóvá"
            canEdit={isAdmin}
            view={
              <p className="text-sm leading-relaxed text-ink-soft">
                {selfEvolutionSummary(evolutionProfile)}
              </p>
            }
            edit={
              <UpdateSelfEvolutionProfileForm
                agentId={agent.id}
                currentProfile={agent.selfEvolutionProfile}
                bare
              />
            }
          />
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
            id: 'projekt-memoria',
            label: 'Projekt-memória',
            description: 'Amit az agent a beszélgetések között megjegyez erről a projektről.',
            content: (
              <InfoCard
                title="Projekt-memória"
                subtitle="Hol tart a munka, milyen döntések és szabályok vannak rögzítve, és visszaállíthatod egy korábbi állapotra. A viselkedési szabályok a Tanulás fülön vannak, a céges dokumentumok a Tudásbázisban."
              >
                {memoryPanel ? (
                  <MemoryPanel
                    agentId={agent.id}
                    initialProjectKeys={memoryPanel.projectKeys}
                    initialProjectKey={memoryPanel.initialProjectKey}
                    initialProjectLabels={memoryPanel.projectLabels}
                    initialOverview={memoryPanel.initialOverview}
                  />
                ) : (
                  <MemoryPanel agentId={agent.id} />
                )}
              </InfoCard>
            ),
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            id: 'diagnosztika',
            label: 'Tesztelés',
            description: 'Egy gombnyomásra kiderül, működnek-e az agent eszközei és kapcsolatai.',
            content: (
              <InfoCard
                title="Agent tesztelése"
                subtitle="Eszközök, skillek, kapcsolatok — élő próbával, oda vezető javítással"
              >
                <AgentDiagnosticsPanel agentId={agent.id} bare />
              </InfoCard>
            ),
          },
        ]
      : []),
    {
      id: 'eszkozok',
      label: 'Eszközök és skillek',
      description: 'Mit hívhat meg az agent, és milyen skillek vannak ráadva.',
      content: (
        <div className="space-y-6">
          {governance && (
            <EditableCard
              title="Engedélyezett eszközök"
              subtitle={
                capabilitiesLocked
                  ? RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE
                  : 'Mit hívhat meg az agent munka közben'
              }
              canEdit={isAdmin && !capabilitiesLocked}
              view={
                <AgentToolsOverview
                  capabilities={governance.capabilities}
                  canEdit={isAdmin && !capabilitiesLocked}
                />
              }
              edit={
                <AgentCapabilitiesPanel
                  agentId={agent.id}
                  currentCapabilities={governance.capabilities}
                  isOrchestrator={agent.role === 'orchestrator'}
                  bare
                />
              }
            />
          )}
          <AgentSkillsPanel
            agentId={agent.id}
            assigned={agentSkills as AgentSkillRow[]}
            assignable={assignableSkills as AssignableSkill[]}
            canEdit={canManageSkills}
            isAdmin={isAdmin}
            isPlatformAdmin={isPlatformAdmin}
          />
        </div>
      ),
    },
    {
      id: 'kapcsolatok',
      label: 'Kapcsolatok',
      description: 'Külső rendszerek, amelyekhez az agent hozzáfér.',
      content: (
        <div className="space-y-6">
          {governance && (
            <InfoCard
              title="Külső kapcsolatok"
              subtitle={
                capabilitiesLocked
                  ? RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE
                  : isAdmin
                    ? 'Amikhez ez az agent hozzáfér — és itt tudsz újat kötni hozzá.'
                    : 'Amikhez ez az agent hozzáfér.'
              }
            >
              {sandboxCapabilityMissingConnector ? (
                <p className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                  A jog engedélyezve van, de nincs kódfuttató kapcsolat hozzárendelve — az
                  agent nem tud kódot futtatni.
                </p>
              ) : null}
              {isAdmin && !capabilitiesLocked && assignableConnectors.length > 0 ? (
                <div className="mb-4 flex justify-end">
                  <AssignConnectorModal agentId={agent.id} connectors={assignableConnectors} />
                </div>
              ) : null}
              <ApiConnectorList
                agentId={agent.id}
                connectors={governance.connectors}
                canEdit={isAdmin && !capabilitiesLocked}
              />
            </InfoCard>
          )}
          {governance && !capabilitiesLocked && (
            <WebSearchPolicyCard agentId={agent.id} connectors={governance.connectors} />
          )}
          {isAdmin && !capabilitiesLocked ? <CodeSandboxConnectorPanel /> : null}
        </div>
      ),
    },
    {
      id: 'motor',
      label: 'Gondolkodási motor',
      description: 'Melyik modellt használja, milyen beállításokkal.',
      content: (
        <EditableCard
          title="Gondolkodási motor"
          subtitle="Melyik modellt hívja, és mi a tartalék, ha az nem elérhető"
          canEdit={isAdmin}
          view={<p className="text-sm text-ink-soft">{modelConfigSummary(modelConfig)}</p>}
          edit={
            <UpdateModelConfigForm
              agentId={agent.id}
              providers={modelProviders}
              embedded
              current={{
                provider: String(modelConfig.provider ?? 'chatgpt-oauth'),
                model: String(modelConfig.model ?? ''),
                modelType:
                  modelConfig.modelType === 'luna' ||
                  modelConfig.modelType === 'terra' ||
                  modelConfig.modelType === 'sol'
                    ? modelConfig.modelType
                    : undefined,
                temperature:
                  typeof modelConfig.temperature === 'number'
                    ? modelConfig.temperature
                    : undefined,
                maxTokens:
                  typeof modelConfig.maxTokens === 'number' ? modelConfig.maxTokens : undefined,
                fallbackModels: Array.isArray(modelConfig.fallbackModels)
                  ? (modelConfig.fallbackModels as Array<{ provider: string; model: string }>)
                      .filter(
                        (row) =>
                          row && typeof row.provider === 'string' && typeof row.model === 'string',
                      )
                      .map((row) => ({ provider: row.provider, model: row.model }))
                  : undefined,
              }}
            />
          }
        />
      ),
    },
    {
      id: 'mukodes',
      label: 'Működés és hozzáférés',
      description: 'Ki látja az agentet, hogyan védjük a neveket és a titkos mintákat, és milyen életciklus-állapotban van.',
      content: (
        <div className="space-y-6">
          {privacyRes.success ? (
            <PrivacyAdminPanel
              initial={privacyRes.data}
              agentId={agent.id}
              layers={['agent']}
            />
          ) : (
            <p className="text-sm text-coral">{privacyRes.error}</p>
          )}
          {isAdmin ? (
            <OperatorVisibilityForm
              agentId={agent.id}
              hiddenFromOperators={agent.hiddenFromOperators}
            />
          ) : null}
          <OperatorSkillManagementForm
            agentId={agent.id}
            operatorCanManageSkills={agent.operatorCanManageSkills}
            canEdit={isAdmin}
          />
          <TaskOnlyForm agentId={agent.id} taskOnly={agent.taskOnly} canEdit={isAdmin} />
          <InfoCard
            title="Életciklus"
            subtitle="Aktiválás befagyaszt egy reprodukálhatósági verziót; felfüggesztve/nyugdíjazva az agent nem kap új feladatot, a múltbeli munkák visszakereshetők maradnak."
          >
            <AgentLifecycleControls
              agentId={agent.id}
              status={agent.status}
              suspendedReason={agent.suspendedReason}
              canManage={isAdmin}
            />
            <p className="mt-4 border-t border-line pt-4 text-sm text-ink-soft">
              Aktuális verziók: Munkakör v{agent.currentRoleInstructionVersion} · Munkastílus v
              {agent.currentBehaviorProfileVersion} · Agent v{agent.currentVersion}
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              {roleInfo.title} — {roleInfo.description}
            </p>
          </InfoCard>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {embedded ? null : (
        <Link
          href="/control-plane/agents"
          className="inline-block text-sm font-medium text-ink-soft hover:text-coral-deep"
        >
          ← Vissza a csapathoz
        </Link>
      )}
      {secondaryError ? (
        <div className="rounded-xl border border-honey/40 bg-honey/10 px-4 py-3 text-sm text-ink-soft">
          Az agent betöltődött, de néhány panel (memória, tudásbázis vagy eszközök) most nem ért
          el. Frissítsd az oldalt, ha hiányzik valami.
        </div>
      ) : null}

      {agent.status === 'draft' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-ink">
            <span className="font-semibold">Még vázlat</span> — {agent.name} nem kap feladatot és nem dispatchelhető, amíg nem aktiválod.
            {isAdmin ? ' Az aktiválás befagyasztja az első verziót.' : ' Ehhez admin jog kell.'}
          </p>
          {isAdmin ? (
            <AgentLifecycleControls agentId={agent.id} status={agent.status} canManage />
          ) : null}
        </div>
      ) : null}

      <AgentIdentityCard
        canEdit={isAdmin}
        header={
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
              <div className="mt-2 flex max-w-2xl items-start gap-1.5">
                <p className="min-w-0 flex-1 text-base italic text-ink-soft">
                  &quot;{persona.greeting}&quot;
                </p>
                <AgentRoleDescriptionButton
                  nickname={persona.nickname}
                  description={agent.roleInstruction}
                />
              </div>
            </div>
            {delegatedConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={delegatedConnectors} variant="sidebar" />
            ) : null}
          </div>
        }
        trait={<p className="text-sm leading-relaxed text-ink-soft">{persona.trait}</p>}
        actions={
          <>
            {embedded ? null : agent.taskOnly ? (
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
                initialConversationId={initialConversationId}
                autoOpen={openChat}
                resumeAfterGrant={resumeAfterGrant}
                initialPrefill={initialPrefill}
              />
            )}
            {embedded ? null : <AgentMiniAppsLink agentId={agent.id} />}
            {embedded ? null : <AgentIdCopyButton agentId={agent.id} />}
            <span className="text-sm text-ink-faint">
              {roleInfo.title} — {roleInfo.description}
            </span>
          </>
        }
        edit={
          <>
            <div>
              <p className="mb-3 text-sm font-semibold text-ink">Arckép</p>
              <AgentAvatarUpload
                agentId={agent.id}
                name={agent.name}
                status={agent.status}
                avatarUrl={agent.avatarUrl}
                personaNickname={agent.personaNickname}
                bare
              />
            </div>
            <div className="border-t border-line pt-5">
              <p className="mb-3 text-sm font-semibold text-ink">Bemutatkozás</p>
              <UpdatePersonaForm
                agentId={agent.id}
                storedNickname={agent.personaNickname}
                storedGreeting={agent.personaGreeting}
                storedTrait={agent.personaTrait}
                defaultNickname={defaultPersona.nickname}
                defaultGreeting={defaultPersona.greeting}
                defaultTrait={defaultPersona.trait}
                bare
              />
            </div>
          </>
        }
      />

      <SettingsSectionShell
        ariaLabel="Agent témák"
        sections={agentSections}
        initialId={query.section}
      />
    </div>
  )
}
