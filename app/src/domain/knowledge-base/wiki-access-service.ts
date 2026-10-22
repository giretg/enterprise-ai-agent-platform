/**
 * #942 LLM Wiki 1/6 — agent ↔ wiki kapcsolat és a privát tudásbázis életciklusa
 * (#941 D2, D13, D14, D16). UI és MCP-eszköz itt nincs; ez a szabály-réteg,
 * amit a Control Plane (5/6) és az MCP-eszközök (2/6) hívnak.
 */
import { randomUUID } from 'node:crypto'
import type { Connector, ConnectorAccessMode, MemoryWriteMode, WikiAccess } from '@prisma/client'
import type {
  AgentConnectorBinding,
  AgentRepository,
  AuditRepository,
  ConnectorRepository,
  PrivateKnowledgeBasePurgeCounts,
  PrivateKnowledgeBaseStore,
  WikiRepository,
} from '@/repositories/interfaces'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { isKbLanguage, type KbLanguage } from '@/lib/kb-language'
import {
  PRIVATE_KB_ORPHAN_GRACE_MS,
  canManageKnowledgeBaseLink,
  defaultWikiWriteMode,
  effectiveWikiAccess,
  isPrivateKnowledgeBase,
  isWikiAccessLevel,
} from '@/lib/wiki-access'

export const PRIVATE_KB_NAME_PREFIX = 'kb:private:'
const MAX_DISPLAY_NAME = 120
const MAX_COLLECT_FOCUS = 2000

export type WikiActor = { userId: string; tenantId: string; role: string }

export class WikiAccessError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'forbidden'
      | 'invalid_args'
      | 'visibility_immutable'
      | 'private_kb_not_shareable',
  ) {
    super(code)
    this.name = 'WikiAccessError'
  }
}

export type WikiAccessServiceDeps = {
  connectors: Pick<ConnectorRepository, 'findById' | 'create'> & {
    setKbLanguage?: (connectorId: string, kbLanguage: KbLanguage) => Promise<Connector>
  }
  agents: Pick<
    AgentRepository,
    'findById' | 'findConnectorBinding' | 'upsertConnectorBinding' | 'updateWikiLink'
  >
  wikis: Pick<WikiRepository, 'releaseClaimsForAgent'>
  privateKnowledgeBases: PrivateKnowledgeBaseStore
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

/** A privát KB megjelenített neve a configban él; a connector-név tartalommentes. */
export function privateKnowledgeBaseDisplayName(connector: Pick<Connector, 'config'>): string | null {
  const config = connector.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const name = (config as Record<string, unknown>).displayName
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export class WikiAccessService {
  constructor(private readonly deps: WikiAccessServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private async loadKnowledgeBase(tenantId: string, connectorId: string): Promise<Connector> {
    const connector = await this.deps.connectors.findById(connectorId, tenantId)
    if (!connector || connector.tenantId !== tenantId || connector.type !== 'knowledge_base') {
      throw new WikiAccessError('not_found')
    }
    return connector
  }

  /**
   * D13: privát tudásbázis — csak a tulajdonos látja. A connector-név
   * (`kb:private:<uuid>`) nem hordoz tartalmat; a megjelenített név a configban van,
   * így admin-listában és auditban sem jelenik meg.
   */
  async createPrivateKnowledgeBase(input: {
    actor: WikiActor
    displayName: string
    kbLanguage?: KbLanguage
  }): Promise<Connector> {
    const displayName = input.displayName.trim().slice(0, MAX_DISPLAY_NAME)
    if (!displayName) throw new WikiAccessError('invalid_args')
    let connector = await this.deps.connectors.create({
      tenantId: input.actor.tenantId,
      type: 'knowledge_base',
      name: `${PRIVATE_KB_NAME_PREFIX}${randomUUID()}`,
      authMode: 'agent_owned',
      scope: 'single',
      config: { displayName },
      visibility: 'private_to_user',
      ownerUserId: input.actor.userId,
    })
    if (input.kbLanguage && isKbLanguage(input.kbLanguage) && this.deps.connectors.setKbLanguage) {
      connector = await this.deps.connectors.setKbLanguage(connector.id, input.kbLanguage)
    }
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: input.actor.userId,
        action: 'kb.private.created',
        targetType: 'connector',
        targetId: connector.id,
        policyDecision: 'allowed',
        metadata: { connectorId: connector.id, ownerUserId: input.actor.userId },
        tenantId: input.actor.tenantId,
      }),
    )
    return connector
  }

  /**
   * Tudásbázis kapcsolása agenthez. Privátot csak a tulajdonos (D13), közöset a
   * tenant admin. Új kapcsolat `wikiAccess: read`; privátnál a mód `direct` (D14).
   */
  async linkKnowledgeBase(input: {
    actor: WikiActor
    agentId: string
    connectorId: string
    accessMode?: ConnectorAccessMode
  }): Promise<AgentConnectorBinding> {
    const connector = await this.loadKnowledgeBase(input.actor.tenantId, input.connectorId)
    this.assertCanManage(connector, input.actor)
    const agent = await this.deps.agents.findById(input.agentId, input.actor.tenantId)
    if (!agent) throw new WikiAccessError('not_found')
    const existing = await this.deps.agents.findConnectorBinding(agent.id, connector.id)
    await this.deps.agents.upsertConnectorBinding({
      agentId: agent.id,
      connectorId: connector.id,
      accessMode: input.accessMode ?? existing?.accessMode ?? 'read',
      initialWikiWriteMode: defaultWikiWriteMode(connector.visibility),
    })
    const binding = await this.deps.agents.findConnectorBinding(agent.id, connector.id)
    if (!binding) throw new WikiAccessError('not_found')
    if (!existing || existing.accessMode !== binding.accessMode) {
      await this.handleAccessChange(connector, input.actor, agent.id, existing, binding, existing ? 'changed' : 'linked')
    }
    return binding
  }

  /** D1/D2: hozzáférés, írási mód, „Mit gyűjtsön" egy meglévő kapcsolaton. */
  async setWikiAccess(input: {
    actor: WikiActor
    agentId: string
    connectorId: string
    wikiAccess?: WikiAccess
    wikiWriteMode?: MemoryWriteMode
    wikiCollectFocus?: string | null
  }): Promise<AgentConnectorBinding> {
    if (input.wikiAccess !== undefined && !isWikiAccessLevel(input.wikiAccess)) {
      throw new WikiAccessError('invalid_args')
    }
    if (input.wikiWriteMode !== undefined && input.wikiWriteMode !== 'approval' && input.wikiWriteMode !== 'direct') {
      throw new WikiAccessError('invalid_args')
    }
    const connector = await this.loadKnowledgeBase(input.actor.tenantId, input.connectorId)
    this.assertCanManage(connector, input.actor)
    const before = await this.deps.agents.findConnectorBinding(input.agentId, connector.id)
    if (!before || before.connector.tenantId !== input.actor.tenantId) throw new WikiAccessError('not_found')

    const focus =
      input.wikiCollectFocus === undefined
        ? undefined
        : input.wikiCollectFocus?.trim().slice(0, MAX_COLLECT_FOCUS) || null
    const after = await this.deps.agents.updateWikiLink({
      agentId: input.agentId,
      connectorId: connector.id,
      // Írási wiki-jog a meglévő `accessMode: write` KB-linkre épül (#941 §6).
      ...(input.wikiAccess === 'write' ? { accessMode: 'write' as const } : {}),
      ...(input.wikiAccess ? { wikiAccess: input.wikiAccess } : {}),
      ...(input.wikiWriteMode ? { wikiWriteMode: input.wikiWriteMode } : {}),
      ...(focus !== undefined ? { wikiCollectFocus: focus } : {}),
    })
    if (!after) throw new WikiAccessError('not_found')

    await this.handleAccessChange(connector, input.actor, input.agentId, before, after, 'changed')
    return after
  }

  /** Láthatóság nem állítható át (privátból közösbe sem, közösből privátba sem). */
  assertVisibilityChange(connector: Pick<Connector, 'visibility'>, next: unknown): void {
    if (next !== connector.visibility) throw new WikiAccessError('visibility_immutable')
  }

  /** Privát KB nem kerülhet a közös katalógusba, és nem osztható meg más felhasználóval. */
  assertShareable(connector: Pick<Connector, 'visibility'>): void {
    if (isPrivateKnowledgeBase(connector)) throw new WikiAccessError('private_kb_not_shareable')
  }

  /**
   * Végleges törlés. A tulajdonos és a tenant admin indíthatja; az admin a
   * tartalmat ekkor sem látja — a válasz és az audit csak darabszám.
   */
  async purgePrivateKnowledgeBase(input: {
    actor: WikiActor
    connectorId: string
  }): Promise<PrivateKnowledgeBasePurgeCounts> {
    const row = await this.deps.privateKnowledgeBases.findPrivate(input.connectorId)
    if (!row || row.tenantId !== input.actor.tenantId) throw new WikiAccessError('not_found')
    const isOwner = row.ownerUserId === input.actor.userId
    if (!isOwner && input.actor.role !== 'admin') throw new WikiAccessError('not_found')
    const counts = await this.deps.privateKnowledgeBases.purge(row.connectorId)
    await this.auditPurge(row, counts, {
      actorType: 'human',
      actorId: input.actor.userId,
      trigger: isOwner ? 'owner' : 'admin',
    })
    return counts
  }

  /**
   * D16: a tenantból eltávolított (felfüggesztett / törölt) tulajdonos privát
   * KB-ja 30 nap után törlődik. A hozzáférés már a felfüggesztéskor megszűnik
   * (aktív tagság nélkül nincs principal); visszaállításkor újra elérhető.
   */
  async sweepOrphanedPrivateKnowledgeBases(): Promise<{ purged: number }> {
    const now = this.now()
    const olderThan = new Date(now.getTime() - PRIVATE_KB_ORPHAN_GRACE_MS)
    const orphans = await this.deps.privateKnowledgeBases.listOrphaned({ olderThan, now })
    let purged = 0
    for (const row of orphans) {
      const counts = await this.deps.privateKnowledgeBases.purge(row.connectorId, { olderThan })
      if (!counts) continue
      await this.auditPurge(row, counts, { actorType: 'system', actorId: null, trigger: 'owner_removed' })
      purged++
    }
    return { purged }
  }

  private assertCanManage(connector: Connector, actor: WikiActor) {
    if (canManageKnowledgeBaseLink(connector, actor)) return
    // Más privát KB-ja a hívónak nem létezik.
    throw new WikiAccessError(isPrivateKnowledgeBase(connector) ? 'not_found' : 'forbidden')
  }

  private async handleAccessChange(
    connector: Connector,
    actor: WikiActor,
    agentId: string,
    before: AgentConnectorBinding | null,
    after: AgentConnectorBinding,
    kind: 'linked' | 'changed',
  ) {
    if (before && effectiveWikiAccess(before) === 'write' && effectiveWikiAccess(after) !== 'write') {
      await this.deps.wikis.releaseClaimsForAgent({ agentId, connectorIds: [connector.id] })
    }
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: actor.userId,
        action: 'kb.wiki.access.changed',
        targetType: 'connector',
        targetId: connector.id,
        policyDecision: 'allowed',
        metadata: {
          kind,
          agentId,
          connectorId: connector.id,
          fromAccess: before ? effectiveWikiAccess(before) : null,
          toAccess: effectiveWikiAccess(after),
          fromWriteMode: before?.wikiWriteMode ?? null,
          toWriteMode: after.wikiWriteMode ?? 'approval',
          collectFocusChanged: (before?.wikiCollectFocus ?? null) !== (after.wikiCollectFocus ?? null),
        },
        tenantId: actor.tenantId,
      }),
    )
  }

  private async auditPurge(
    row: { connectorId: string; tenantId: string; ownerUserId: string },
    counts: PrivateKnowledgeBasePurgeCounts,
    who: { actorType: 'human' | 'system'; actorId: string | null; trigger: string },
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(
        { visibility: 'private_to_user' },
        {
          actorType: who.actorType,
          actorId: who.actorId,
          action: 'kb.private.deleted',
          targetType: 'connector',
          targetId: row.connectorId,
          policyDecision: 'deleted',
          metadata: {
            trigger: who.trigger,
            connectorId: row.connectorId,
            ownerUserId: row.ownerUserId,
            ...counts,
          },
          tenantId: row.tenantId,
        },
      ),
    )
  }
}
