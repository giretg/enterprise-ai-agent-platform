/**
 * Közös beállítás-jegyzék (#957 WP-1): az agent-adatlap minden beállítási
 * területe itt kötelezően megmondja, hol állítható a varázslóban
 * (`wizardStep`), vagy miért marad ki onnan (`wizardSkipReason`).
 *
 * A `scripts/agent-setting-sections.test.ts` elbukik, ha az adatlapon új
 * beállító komponens jelenik meg besorolás nélkül, vagy a varázsló nem
 * használja a megnevezett mentési műveletet — így a varázsló nem marad le
 * újra az adatlaptól.
 */
import type { AgentDetailSectionId } from '@/lib/agent-detail-sections'
import type { CreateAgentWizardStepId } from '@/lib/create-agent-wizard'

export type AgentSettingSection = {
  id: string
  /** Az adatlap bal sávjának szekciója, ahol a terület él. */
  detailSection: AgentDetailSectionId
  /** Az adatlapon renderelt beállító komponens neve. */
  detailComponent: string
  /**
   * Komponens- vagy szerverművelet-nevek, amelyeket a varázsló is használ —
   * ugyanaz a mentési út, nincs duplikált üzleti logika.
   */
  wizardUses?: readonly string[]
} & (
  | { wizardStep: CreateAgentWizardStepId; wizardSkipReason?: never }
  | { wizardStep?: never; wizardSkipReason: string }
)

export const AGENT_SETTING_SECTIONS = [
  {
    id: 'profile',
    detailSection: 'profil',
    detailComponent: 'UpdateAgentProfileForm',
    wizardStep: 'identity',
    wizardUses: ['createAgent', 'updateAgentProfile'],
  },
  {
    id: 'avatar',
    detailSection: 'profil',
    detailComponent: 'AgentAvatarUpload',
    wizardStep: 'identity',
    wizardUses: ['AgentAvatarUpload', 'updateAgentAvatar'],
  },
  {
    id: 'localRoots',
    detailSection: 'profil',
    detailComponent: 'UpdateLocalRootsForm',
    wizardStep: 'advanced',
    wizardUses: ['UpdateLocalRootsForm'],
  },
  {
    id: 'roleInstruction',
    detailSection: 'munkakor',
    detailComponent: 'UpdateInstructionForm',
    wizardStep: 'duties',
    wizardUses: ['updateAgentInstruction'],
  },
  {
    id: 'model',
    detailSection: 'modell',
    detailComponent: 'UpdateModelConfigForm',
    wizardStep: 'advanced',
    wizardUses: ['UpdateModelConfigForm'],
  },
  {
    id: 'platformChat',
    detailSection: 'modell',
    detailComponent: 'UpdatePlatformChatForm',
    wizardSkipReason:
      'Alapból bekapcsolva: minden új munkatárs elérhető a platform-chatben, ha a cégnél be van kapcsolva — kikapcsolni utólag az adatlapon lehet.',
  },
  {
    id: 'connectors',
    detailSection: 'kapcsolatok',
    detailComponent: 'AgentConnectorBindingForm',
    wizardStep: 'access',
    wizardUses: ['AgentConnectorBindingForm', 'assignConnectorToAgent'],
  },
  {
    id: 'mailbox',
    detailSection: 'email',
    detailComponent: 'AgentMailboxPanel',
    wizardStep: 'mailbox',
    wizardUses: ['AgentMailboxPanel'],
  },
  {
    id: 'knowledgeBase',
    detailSection: 'tudasbazis',
    detailComponent: 'AgentKnowledgeBasePanel',
    wizardStep: 'knowledge',
    wizardUses: ['AgentKnowledgeBasePanel'],
  },
  {
    id: 'wikiAccess',
    detailSection: 'tudasbazis',
    detailComponent: 'AgentWikiAccessPanel',
    wizardStep: 'knowledge',
    wizardUses: ['AgentWikiAccessPanel'],
  },
  {
    id: 'tools',
    detailSection: 'eszkozok',
    detailComponent: 'AgentCapabilitiesPanel',
    wizardStep: 'access',
    wizardUses: ['AgentCapabilitiesPanel', 'updateAgentCapabilities'],
  },
  {
    id: 'hermesPolicy',
    detailSection: 'eszkozok',
    detailComponent: 'ClientPolicyForm',
    wizardStep: 'advanced',
    wizardUses: ['ClientPolicyForm'],
  },
  {
    id: 'skills',
    detailSection: 'skillek',
    detailComponent: 'AgentSkillsPanel',
    wizardStep: 'access',
    wizardUses: ['AgentSkillsPanel', 'assignSkillAction'],
  },
  {
    id: 'writeApprovals',
    detailSection: 'memoriairas',
    detailComponent: 'UpdateWriteApprovalForm',
    wizardStep: 'autonomy',
    wizardUses: ['UpdateWriteApprovalForm', 'updateAgentWriteApprovalModes'],
  },
  {
    id: 'outputFolder',
    detailSection: 'memoriairas',
    detailComponent: 'UpdateOutputFolderForm',
    wizardStep: 'autonomy',
    wizardUses: ['UpdateOutputFolderForm'],
  },
  {
    id: 'placementOverrides',
    detailSection: 'memoriairas',
    detailComponent: 'UpdatePlacementOverridesForm',
    wizardSkipReason:
      'Nem kötelező: az alapszabály (tények a memóriába, szabályok skillbe) a legtöbb munkatársnak megfelel — eltérés utólag az adatlapon adható meg.',
  },
  {
    id: 'projectMemory',
    detailSection: 'memoriairas',
    detailComponent: 'AgentProjectMemoryBrowser',
    wizardSkipReason:
      'Létrehozáskor a projektmemória üres, nincs mit böngészni — a munka során az adatlapon érhető el.',
  },
  {
    id: 'miniApps',
    detailSection: 'miniappok',
    detailComponent: 'AgentMiniAppsPanel',
    wizardSkipReason:
      'Létrehozáskor a munkatársnak még nincs mini appja — a munka során készülnek, az adatlapon kezelhetők.',
  },
  {
    id: 'miniAppGuide',
    detailSection: 'miniappok',
    detailComponent: 'UpdateMiniAppGuideForm',
    wizardSkipReason:
      'Nem kötelező, és csak akkor van értelme, ha a munkatárs már készít mini appokat — utólag az adatlapon adható meg.',
  },
  {
    id: 'customerPromises',
    detailSection: 'igeretek',
    detailComponent: 'PromisesPanel',
    wizardSkipReason:
      'Létrehozáskor a munkatárs még nem tett ügyfélvállalást — az ígéretek a munka során keletkeznek, az adatlapon kezelhetők.',
  },
  {
    id: 'access',
    detailSection: 'hozzaferes',
    detailComponent: 'AgentAccessPanel',
    wizardStep: 'team',
    wizardUses: ['AgentAccessPanel', 'setAgentUserAccess'],
  },
  {
    id: 'goLive',
    detailSection: 'elesites',
    detailComponent: 'PublishAgentDefinitionForm',
    wizardStep: 'launch',
    wizardUses: ['publishAgentDefinitionAction', 'activateAgent'],
  },
] as const satisfies readonly AgentSettingSection[]

export type AgentSettingSectionId = (typeof AGENT_SETTING_SECTIONS)[number]['id']

/** A varázsló adott lépésén állítható területek. */
export function settingSectionsForWizardStep(step: CreateAgentWizardStepId): AgentSettingSection[] {
  return (AGENT_SETTING_SECTIONS as readonly AgentSettingSection[]).filter(
    (section) => section.wizardStep === step,
  )
}
