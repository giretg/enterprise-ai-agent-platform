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
import { Collapsible } from '@/components/ui/collapsible'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentIdentityCard } from '@/components/agents/agent-identity-card'
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
import {
  BehaviorProfileEditForm,
  BehaviorProfileView,
} from '@/components/agents/behavior-profile-box'
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
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'
import { CREATE_AGENT_WIZARD_EXTERNAL_HREFS } from '@/lib/create-agent-wizard'
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

/** Eszközjogok olvasható nézete: mit hívhat meg ténylegesen, és mi van letiltva. */
function CapabilityView({
  capabilities,
}: {
  capabilities: Array<{ toolName: string; allowed: boolean }>
}) {
  if (capabilities.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        Még nincs beállítva egyetlen eszközjog sem — az agent csak beszélgetni tud.
      </p>
    )
  }
  const allowed = capabilities.filter((c) => c.allowed)
  const denied = capabilities.filter((c) => !c.allowed)

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink">
        <strong>{allowed.length}</strong> eszközt használhat
        {denied.length > 0 ? `, ${denied.length} le van tiltva` : ''}.
      </p>
      <ExpandableContent>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Engedélyezett
            </p>
            {allowed.length === 0 ? (
              <p className="text-sm italic text-ink-faint">Nincs engedélyezett eszköz.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {allowed.map((cap) => (
                  <li key={cap.toolName} className="atelier-soft px-2.5 py-1 text-xs text-ink">
                    {formatToolUiName(cap.toolName)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {denied.length > 0 && (
            <div className="border-t border-line pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Letiltva
              </p>
              <ul className="flex flex-wrap gap-2">
                {denied.map((cap) => (
                  <li
                    key={cap.toolName}
                    className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-faint"
                  >
                    {formatToolUiName(cap.toolName)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </ExpandableContent>
    </div>
  )
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>
  searchParams: Promise<{ conversation?: string; openChat?: string; granted?: string }>
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
  const resumeAfterGrant = query.granted === '1'

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
  const visibleResources = isAdmin
    ? resources
    : resources.filter((r) => r.type !== 'secret')

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
              href={`/control-plane/training?agentId=${agent.id}`}
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
            description: 'Tartós, conversationök közötti projektfolytonosság.',
            content: (
              <InfoCard
                title="Projekt-memória"
                subtitle="Amit az agent projektfolytonossági állapotként megjegyzett — fókusz, döntések, nyitott feladatok, konfliktusok — a jóváhagyási és visszaállítási eszközökkel együtt."
              >
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
              subtitle="Mit hívhat meg az agent munka közben"
              canEdit={isAdmin}
              view={<CapabilityView capabilities={governance.capabilities} />}
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
          {isAdmin && governance && <AgentToolAccessDiagnostics report={governance.toolAccess} />}
          <AgentSkillsPanel
            agentId={agent.id}
            assigned={agentSkills as AgentSkillRow[]}
            assignable={assignableSkills as AssignableSkill[]}
            canEdit={isAdmin}
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
                isAdmin
                  ? 'Amikhez ez az agent hozzáfér — és itt tudsz újat kötni hozzá.'
                  : 'Amikhez ez az agent hozzáfér.'
              }
            >
              <ApiConnectorList
                agentId={agent.id}
                connectors={governance.connectors}
                canEdit={isAdmin}
              />
              {isAdmin ? (
                <div className="mt-6 space-y-3 border-t border-line pt-5">
                  <p className="text-sm font-semibold text-ink">Új kapcsolat</p>
                  <p className="text-xs text-ink-faint">
                    Ha közben új kapcsolatot kell definiálnod, az új ablakban nyílik — ez az
                    oldal itt marad.{' '}
                    <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections}>
                      Provisioning-varázsló
                    </OpenInNewWindowLink>
                    {' · '}
                    <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors}>
                      Kapcsolat-katalógus
                    </OpenInNewWindowLink>
                  </p>
                  <Collapsible
                    title="Új API-kapcsolat hozzáadása"
                    subtitle="Külső REST API bekötése új connectorként"
                  >
                    <AddApiConnectorForm agentId={agent.id} bare />
                  </Collapsible>
                  <Collapsible
                    title="Meglévő kapcsolat hozzárendelése"
                    subtitle="Már aktivált provisioning-kapcsolat csatolása"
                  >
                    <AssignExistingConnectorForm
                      agentId={agent.id}
                      connectors={assignableConnectors}
                      bare
                    />
                  </Collapsible>
                </div>
              ) : null}
            </InfoCard>
          )}
          {governance && (
            <WebSearchPolicyCard agentId={agent.id} connectors={governance.connectors} />
          )}
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
          view={
            <div className="space-y-2">
              <p className="text-sm text-ink-soft">{modelConfigSummary(modelConfig)}</p>
              {isAdmin && apiKeyPreview && (
                <p className="text-xs text-ink-faint">API kulcs: {apiKeyPreview}</p>
              )}
            </div>
          }
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
      description: 'Ki látja az agentet, mit kezelhet, és milyen életciklus-állapotban van.',
      content: (
        <div className="space-y-6">
          <SensitivityPolicyForm
            agentId={agent.id}
            allowSensitiveExternalModel={agent.allowSensitiveExternalModel}
            canEdit={isAdmin}
          />
          {isAdmin ? (
            <OperatorVisibilityForm
              agentId={agent.id}
              hiddenFromOperators={agent.hiddenFromOperators}
            />
          ) : null}
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
          </InfoCard>
        </div>
      ),
    },
    {
      id: 'technikai',
      label: 'Technikai adatok',
      description: 'Verziók, munkafolyamat-sablon és hozzárendelt források.',
      content: (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Verziók">
            <p className="text-sm text-ink-soft">
              Munkakör v{agent.currentRoleInstructionVersion} · Munkastílus v
              {agent.currentBehaviorProfileVersion} · Agent v{agent.currentVersion}
            </p>
            <p className="mt-2 text-xs text-ink-faint">
              {roleInfo.title} — {roleInfo.description}
            </p>
          </Card>
          <Card title="Munkafolyamat-sablon">
            {recipe ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-ink">{recipe.name}</p>
                <p className="text-ink-soft">
                  {recipe.ticketType === 'training' ? 'tanítási' : 'interakciós'} folyamat · v
                  {recipe.version} · {recipeStatusLabel(recipe.status)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-ink-faint">
                Nincs munkafolyamat-sablon ehhez a verzióhoz.
              </p>
            )}
          </Card>
          <Card title="Hozzárendelt források">
            {visibleResources.length === 0 ? (
              <p className="text-sm text-ink-faint">Nincs hozzárendelt forrás.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {visibleResources.map((r) => (
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
        </div>
      ),
    },
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
              <p className="mt-2 max-w-2xl text-base italic text-ink-soft">
                &quot;{persona.greeting}&quot;
              </p>
            </div>
            {delegatedConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={delegatedConnectors} variant="sidebar" />
            ) : null}
          </div>
        }
        trait={<p className="text-sm leading-relaxed text-ink-soft">{persona.trait}</p>}
        actions={
          <>
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
                resumeAfterGrant={resumeAfterGrant}
              />
            )}
            <AgentMiniAppsLink agentId={agent.id} />
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

      <SettingsSectionShell ariaLabel="Agent témák" sections={agentSections} />
    </div>
  )
}
