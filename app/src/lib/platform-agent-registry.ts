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
/**
 * FÜGGŐSÉGI IRÁNY: ez a modul SZÁNDÉKOSAN import-mentes. A varázsló-neveket itt
 * deklaráljuk, és a domain-sablonok (`PLAYBOOK_AUTHOR_TEMPLATE`,
 * `PROVISIONING_ASSISTANT_TEMPLATE`) innen veszik át — fordítva nem lehet, mert a
 * sablonok a Model Gateway-en át `node:fs`-ig húzzák be a szervert. A kapcsolati
 * ábra (`agent-access-graph-editor`) kliens-komponens ezt a fájlt is bundle-öli,
 * és egy szerver-import ott build-hibát okoz.
 */

/** A Web-Egress perzisztált rendszer-szerepazonosítója. */
export const WEB_EGRESS_SYSTEM_ROLE = 'web_egress' as const

/** A Futás-elemző perzisztált rendszer-szerepazonosítója. */
export const RUN_ANALYST_SYSTEM_ROLE = 'run_analyst' as const

/**
 * Rendszer-szerepek, amelyek kiinduló user→agent grantot kapnak a
 * `materializeDefaultUserAgentGrants` során. Alapértelmezés: üres (deny-by-default).
 * Kivételt csak itt nevesíts — ne tagadással egyetlen szerepre.
 */
export const DEFAULT_GRANTABLE_SYSTEM_ROLES: readonly string[] = []

/** True, ha az agent megkapja a tenant tagok kiinduló user→agent grantjait. */
export function receivesDefaultUserAgentGrants(agent: { systemRole?: string | null }): boolean {
  const role = agent.systemRole ?? null
  if (role === null) return true
  return DEFAULT_GRANTABLE_SYSTEM_ROLES.includes(role)
}

/** A dedikált-panel varázslók kanonikus Registry-nevei. */
export const PLAYBOOK_AUTHOR_AGENT_NAME = 'Playbook Author' as const
export const PROVISIONING_ASSISTANT_AGENT_NAME = 'Provisioning Assistant' as const

/**
 * A dedikált-panel varázslók nevei. A Skill Distiller és a Skill Review a
 * Provisioning Assistant Registry-bejegyzését használja, ezért nincs külön sora.
 */
export const PANEL_WIZARD_AGENT_NAMES: readonly string[] = [
  PLAYBOOK_AUTHOR_AGENT_NAME,
  PROVISIONING_ASSISTANT_AGENT_NAME,
]

/** Beépített panel-varázsló kanonikus neve. Önmagában nem jogosultsági kapu. */
export function isPanelWizardAgentName(name: string): boolean {
  return PANEL_WIZARD_AGENT_NAMES.includes(name)
}

/**
 * True, ha az agent dedikált-panel varázsló: `tenantId = null` ÉS a nevesített
 * varázslók egyike. A `tenantId` feltétel szándékos: egy tenant SAJÁT, azonos nevű
 * agentje normál gráfcsomópont marad, nem kap varázsló-immunitást.
 */
export function isPanelWizardAgent(agent: { name: string; tenantId: string | null }): boolean {
  return agent.tenantId === null && isPanelWizardAgentName(agent.name)
}

/**
 * A platform-beállítások felületén megjelenő valódi rendszer-varázslókat választja ki.
 * Egy tenant saját, azonos nevű agentje adat- és módosítási szempontból is tenant-scope-os
 * marad; nem kerülhet át a globális rendszeragent-admin felületre.
 */
export function selectSystemPanelWizardAgents<T extends { name: string; tenantId: string | null }>(
  agents: readonly T[],
): T[] {
  return agents.filter(isPanelWizardAgent)
}

/**
 * True, ha az agent Web-Egress szolgáltató. A rendszer-szerep szándékosan NEM az
 * agent nevéből következik: a név szerkeszthető UI-adat lenne egy biztonsági kapun.
 */
export function isWebEgressAgent(agent: { systemRole?: string | null }): boolean {
  return agent.systemRole === WEB_EGRESS_SYSTEM_ROLE
}

/**
 * True, ha az agent Futás-elemző. A rendszer-szerep szándékosan NEM az agent nevéből
 * következik: a név szerkeszthető UI-adat lenne egy biztonsági kapun.
 */
export function isRunAnalystAgent(agent: { systemRole?: string | null }): boolean {
  return agent.systemRole === RUN_ANALYST_SYSTEM_ROLE
}

/**
 * True, ha az agent CSAK admin/kormányzási felületen látszik. Ma ez a Web-Egress és a
 * Futás-elemző; az org-ábra és az admin kormányzási felület megkapja, az operátori
 * felületek nem.
 */
export function isAdminOnlyGraphNode(agent: { systemRole?: string | null }): boolean {
  return isWebEgressAgent(agent) || isRunAnalystAgent(agent)
}
