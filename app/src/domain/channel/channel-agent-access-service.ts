/**
 * Csatorna-agent-hozzáférés — a metszet, a projektkötés és a szervezeti kill-switch VARRATA
 * (Telegram feature-spec #70/#75, D5/D9/D13/D54).
 *
 * Ez a modul a #75 szelet magja. Egyetlen helyen dönti el, mely agentek érhetők el egy kötött
 * identitásnak a csatornán:
 *
 *   elérhető = (a platform hozzáférési szabálya engedi) ∩ (az admin Telegramra engedélyezte)
 *              ∩ (a szervezeti kapcsoló nincs elzárva)
 *
 * Nem új jogosultság-forrás, hanem SZŰKÍTÉS (D5): a telefonon legfeljebb annyit érsz el, mint a
 * weben, és szerkezetileg nem tud fail-open lenni — a kill-switch és az inaktív identitás minden
 * úton üres eredményt ad.
 *
 * A varrat egyetlen helyen dublőrizhető: a platform-jog oldala (`ChannelAgentDirectory`), a
 * kill-switch (`isChannelEnabled`), a tárak és az audit BEFECSKENDEZETT függőségek. A teszt
 * hatást ér a szolgáltatáson, és a visszaadott döntést + a rögzített audit-bejegyzéseket nézi —
 * sosem hívja külön a metszet egyik oldalát sem.
 */
import type { ChannelAgentGrant, ChannelIdentity } from '@prisma/client'
import type {
  AuditRepository,
  ChannelAgentGrantRepository,
  ChannelIdentityRepository,
} from '@/repositories/interfaces'
import {
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_DEFAULT_PROJECT_KEY,
  isValidProjectKey,
  type ChannelAgentGrantView,
} from './channel-types'
import { pseudonymFromLookupHash } from './channel-identity-crypto'

/** Egy agent a platform-jog oldaláról: azonosító, megjelenített név, és hogy MA elérhető-e. */
export type ChannelAgentBrief = {
  id: string
  name: string
  /** A platform hozzáférési szabálya szerint MA használható-e (aktív, nem nyugdíjazott/felfüggesztett). */
  usable: boolean
}

/**
 * A platform-jog oldala (D5 bal oldala). A csatorna nem ismeri az agent-registry részleteit —
 * csak azt kérdezi meg, mely agentek elérhetők egy szervezetben, és egy adott agent elérhető-e.
 * (Ma a szervezeti szűrés az egyetlen platform-jog; a per-felhasználó dedikálás élesítésekor a
 * bal oldal magától szigorodik — l. #70 Further Notes 1.)
 */
export interface ChannelAgentDirectory {
  /** A szervezet ÖSSZES agentje a használhatósági jelzővel (a nyugdíjazott is, `usable=false`). */
  listForTenant(tenantId: string | null): Promise<ChannelAgentBrief[]>
  /** Egy agent a szervezetben, vagy `null`, ha nem ehhez a szervezethez tartozik. */
  findInTenant(agentId: string, tenantId: string | null): Promise<ChannelAgentBrief | null>
}

export type ChannelAgentAccessDeps = {
  grants: ChannelAgentGrantRepository
  identities: Pick<ChannelIdentityRepository, 'findById'>
  agents: ChannelAgentDirectory
  /** A szervezeti kill-switch (D54): igaz, ha a csatorna él ennek a szervezetnek. Fail-closed. */
  isChannelEnabled: (tenantId: string | null) => Promise<boolean>
  audit: Pick<AuditRepository, 'append'>
}

/** Egy identitás csatorna-agent képe: a szervezeti kapcsoló állapota + a kötések a metszettel. */
export type IdentityAgentsView = {
  /** A csatorna él-e ennek az identitásnak (kill-switch KI és az identitás aktív). */
  channelEnabled: boolean
  /** Az identitás engedélyezett agentjei, mindegyik az agent-oldali metszet-eredménnyel. */
  agents: ChannelAgentGrantView[]
}

export type GrantAgentResult =
  | { ok: true; created: boolean; grant: ChannelAgentGrant }
  | {
      ok: false
      reason:
        | 'identity_not_found'
        | 'cross_tenant'
        | 'identity_inactive'
        | 'agent_not_found'
        | 'agent_not_usable'
    }

export type RevokeAgentResult =
  | { ok: true }
  | { ok: false; reason: 'identity_not_found' | 'cross_tenant' | 'not_found' }

export type SetProjectKeyResult =
  | { ok: true; grant: ChannelAgentGrant }
  | {
      ok: false
      reason: 'identity_not_found' | 'not_owner' | 'invalid_project_key' | 'not_found'
    }

export type SelectAgentResult =
  | { ok: true; agent: ChannelAgentGrantView }
  | { ok: false; reason: 'channel_disabled' | 'not_granted' | 'agent_removed' }

export class ChannelAgentAccessService {
  constructor(private readonly deps: ChannelAgentAccessDeps) {}

  // ── Admin: agentenként engedélyezés / visszavonás (D13/D31) ─────────────────

  /**
   * A tenant-admin engedélyezi egy kötött identitásnak egy agent Telegram-elérését. Fail-closed:
   * csak a SAJÁT szervezetéhez tartozó, AKTÍV identitáshoz, és csak a szervezetben ténylegesen
   * használható agenthez. Az ismételt engedélyezés idempotens (nem hoz létre második sort).
   * A projektkulcs alapértéke a gyűjtő — a felhasználó a weben állítja át (D9).
   */
  async grantAgent(input: {
    identityId: string
    agentId: string
    actorUserId: string
    actorTenantId: string
    projectKey?: string
  }): Promise<GrantAgentResult> {
    const identity = await this.deps.identities.findById(input.identityId)
    if (!identity) return { ok: false, reason: 'identity_not_found' }
    if (identity.tenantId !== input.actorTenantId) return { ok: false, reason: 'cross_tenant' }
    if (identity.status !== 'active') return { ok: false, reason: 'identity_inactive' }

    const agent = await this.deps.agents.findInTenant(input.agentId, input.actorTenantId)
    if (!agent) return { ok: false, reason: 'agent_not_found' }
    if (!agent.usable) return { ok: false, reason: 'agent_not_usable' }

    const existing = await this.deps.grants.findByIdentityAndAgent(input.identityId, input.agentId)
    if (existing) return { ok: true, created: false, grant: existing }

    const projectKey =
      input.projectKey && isValidProjectKey(input.projectKey)
        ? input.projectKey.trim()
        : CHANNEL_DEFAULT_PROJECT_KEY

    const grant = await this.deps.grants.create({
      identityId: input.identityId,
      agentId: input.agentId,
      projectKey,
      grantedById: input.actorUserId,
    })

    await this.auditGrant(CHANNEL_AUDIT_ACTIONS.agentGranted, 'granted', identity, {
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      grantId: grant.id,
      projectKey,
    })
    return { ok: true, created: true, grant }
  }

  /** A tenant-admin visszavonja egy identitás agent-engedélyét — azonnal fail-closed. */
  async revokeAgent(input: {
    identityId: string
    agentId: string
    actorUserId: string
    actorTenantId: string
  }): Promise<RevokeAgentResult> {
    const identity = await this.deps.identities.findById(input.identityId)
    if (!identity) return { ok: false, reason: 'identity_not_found' }
    if (identity.tenantId !== input.actorTenantId) return { ok: false, reason: 'cross_tenant' }

    const existing = await this.deps.grants.findByIdentityAndAgent(input.identityId, input.agentId)
    if (!existing) return { ok: false, reason: 'not_found' }

    await this.deps.grants.deleteById(existing.id)
    await this.auditGrant(CHANNEL_AUDIT_ACTIONS.agentRevoked, 'revoked', identity, {
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      grantId: existing.id,
      projectKey: existing.projectKey,
    })
    return { ok: true }
  }

  // ── Felhasználó: projektkulcs a weben (D9/D33/D34) ──────────────────────────

  /**
   * A felhasználó a webes felületen állítja be, melyik projekthez tartozzon az agent Telegramon.
   * Az `expectUserId` fail-closed őr: csak a SAJÁT engedélyének projektkulcsát írhatja át.
   */
  async setProjectKey(input: {
    identityId: string
    agentId: string
    projectKey: string
    actorUserId: string
    expectUserId: string
  }): Promise<SetProjectKeyResult> {
    const identity = await this.deps.identities.findById(input.identityId)
    if (!identity) return { ok: false, reason: 'identity_not_found' }
    if (identity.userId !== input.expectUserId) return { ok: false, reason: 'not_owner' }
    if (!isValidProjectKey(input.projectKey)) return { ok: false, reason: 'invalid_project_key' }

    const grant = await this.deps.grants.findByIdentityAndAgent(input.identityId, input.agentId)
    if (!grant) return { ok: false, reason: 'not_found' }

    const projectKey = input.projectKey.trim()
    const updated = await this.deps.grants.updateProjectKey(grant.id, projectKey)
    await this.auditGrant(CHANNEL_AUDIT_ACTIONS.agentProjectSet, 'project_set', identity, {
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      grantId: grant.id,
      projectKey,
    })
    return { ok: true, grant: updated }
  }

  // ── Metszet-feloldás (D5) — a runtime és a felület közös forrása ─────────────

  /**
   * Egy identitás csatorna-agent képe: a szervezeti kapcsoló állapota + minden engedély az
   * agent-oldali metszet-eredménnyel. A felület ezt mutatja (a nem elérhető agentet érthető
   * jelzéssel, nem nyers hibával), a runtime ebből szűri a ténylegesen választhatókat.
   */
  async describeIdentityAgents(identityId: string): Promise<IdentityAgentsView> {
    const identity = await this.deps.identities.findById(identityId)
    if (!identity) return { channelEnabled: false, agents: [] }

    const channelEnabled =
      identity.status === 'active' && (await this.deps.isChannelEnabled(identity.tenantId))

    const [platformAgents, grants] = await Promise.all([
      this.deps.agents.listForTenant(identity.tenantId),
      this.deps.grants.listByIdentity(identityId),
    ])
    const byId = new Map(platformAgents.map((a) => [a.id, a]))

    const agents: ChannelAgentGrantView[] = grants.map((g) => {
      const a = byId.get(g.agentId)
      return {
        agentId: g.agentId,
        agentName: a?.name ?? '(már nem elérhető agent)',
        projectKey: g.projectKey,
        availability: a && a.usable ? 'available' : 'agent_removed',
      }
    })
    return { channelEnabled, agents }
  }

  /**
   * A runtime metszete: a ténylegesen VÁLASZTHATÓ agentek. Kill-switch elzárva vagy inaktív
   * identitás → üres (fail-closed). Csak az `available` (platformon is elérhető ÉS Telegramra
   * engedélyezett) agentek maradnak.
   */
  async resolveAvailableAgents(identityId: string): Promise<ChannelAgentGrantView[]> {
    const view = await this.describeIdentityAgents(identityId)
    if (!view.channelEnabled) return []
    return view.agents.filter((a) => a.availability === 'available')
  }

  /**
   * Váltás egy konkrét agentre (D5 — parancsból váltás). A metszet mindkét oldalát és a
   * kill-switchet ellenőrzi, és a tiltás okát ÉRTHETŐEN adja vissza (nem nyers hiba), hogy a
   * hívó hétköznapi magyar üzenetet tudjon mutatni:
   *  - `channel_disabled` — a szervezeti kapcsoló elzárva (vagy az identitás inaktív);
   *  - `not_granted`      — ehhez az agenthez nincs Telegram-engedély;
   *  - `agent_removed`    — Telegramra engedélyezett, de a platformon már nem elérhető.
   */
  async selectAgent(input: { identityId: string; agentId: string }): Promise<SelectAgentResult> {
    const view = await this.describeIdentityAgents(input.identityId)
    if (!view.channelEnabled) return { ok: false, reason: 'channel_disabled' }
    const found = view.agents.find((a) => a.agentId === input.agentId)
    if (!found) return { ok: false, reason: 'not_granted' }
    if (found.availability !== 'available') return { ok: false, reason: 'agent_removed' }
    return { ok: true, agent: found }
  }

  private async auditGrant(
    action: string,
    policyDecision: string,
    identity: ChannelIdentity,
    info: { actorUserId: string; agentId: string; grantId: string; projectKey: string },
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'human',
      actorId: info.actorUserId,
      agentVersion: null,
      action,
      targetType: 'channel_agent_grant',
      targetId: info.grantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision,
      metadata: {
        channelType: identity.channelType,
        tenantId: identity.tenantId,
        agentId: info.agentId,
        projectKey: info.projectKey,
        pseudonym: pseudonymFromLookupHash(identity.lookupHash),
      },
      tenantId: identity.tenantId,
    })
  }
}
