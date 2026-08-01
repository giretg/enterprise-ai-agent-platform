/**
 * Platform-szintű (`tenantId = null`) agentek osztályozása — Access-Policy
 * §agent-scope / „Platform-agentek" (issue #142).
 *
 * ÜZLETI JELENTÉS: két, egymástól élesen különböző dolgot hívtunk eddig egyaránt
 * „platform-agentnek", és ez valós biztonsági rést hagyott:
 *
 *  1. **Dedikált-panel varázslók** (Playbook Author, Provisioning Assistant, Skill
 *     Distiller/Review). Ezek NEM gráfcsomópontok: chatből, ticketből, katalógusból és
 *     `agent_ask`-ból elérhetetlenek, kizárólag a saját, jogosultsággal védett
 *     admin-paneljük indíthatja őket. A korábbi „`tenantId = null` minden tenantból
 *     elérhető" tool-kivétel azt jelentette, hogy bármelyik tenant bármelyik agentje
 *     megszólíthatta ezeket a privilegizált varázslókat — ezt a kivételt megszüntetjük.
 *
 *  2. **Web-Egress**: TENANTONKÉNT materializált, normál tenant-agent és teljes
 *     gráfcsomópont. Egyirányú szolgáltató: csak agent→Web-Egress `address` granttal
 *     hívható, kimenő éle nincs, és a napi operátori felületeken (katalógus,
 *     felelős-választó, chat-indító) nem jelenik meg.
 */
import { PLAYBOOK_AUTHOR_TEMPLATE } from '@/domain/playbook/playbook-author-agent'
import { PROVISIONING_ASSISTANT_TEMPLATE } from '@/domain/provisioning/provisioning-assistant'

/** A Web-Egress perzisztált rendszer-szerepazonosítója. */
export const WEB_EGRESS_SYSTEM_ROLE = 'web_egress' as const

/**
 * A dedikált-panel varázslók nevei. A Skill Distiller és a Skill Review a
 * Provisioning Assistant Registry-bejegyzését használja, ezért nincs külön sora.
 */
export const PANEL_WIZARD_AGENT_NAMES: readonly string[] = [
  PLAYBOOK_AUTHOR_TEMPLATE.name,
  PROVISIONING_ASSISTANT_TEMPLATE.name,
]

/**
 * True, ha az agent dedikált-panel varázsló: `tenantId = null` ÉS a nevesített
 * varázslók egyike. A `tenantId` feltétel szándékos: egy tenant SAJÁT, azonos nevű
 * agentje normál gráfcsomópont marad, nem kap varázsló-immunitást.
 */
export function isPanelWizardAgent(agent: { name: string; tenantId: string | null }): boolean {
  return agent.tenantId === null && PANEL_WIZARD_AGENT_NAMES.includes(agent.name)
}

/**
 * True, ha az agent Web-Egress szolgáltató. A rendszer-szerep szándékosan NEM az
 * agent nevéből következik: a név szerkeszthető UI-adat lenne egy biztonsági kapun.
 */
export function isWebEgressAgent(agent: { systemRole?: string | null }): boolean {
  return agent.systemRole === WEB_EGRESS_SYSTEM_ROLE
}

/**
 * True, ha az agent CSAK admin/kormányzási felületen látszik. Ma ez a Web-Egress; az
 * org-ábra és az admin kormányzási felület megkapja, az operátori felületek nem.
 */
export function isAdminOnlyGraphNode(agent: { systemRole?: string | null }): boolean {
  return isWebEgressAgent(agent)
}
