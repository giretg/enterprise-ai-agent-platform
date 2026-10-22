/**
 * #942 LLM Wiki 1/6 — ki melyik wikit olvashatja / küldhet bele / írhatja (#941 D1/D2/D4/D13/D14).
 *
 * Tiszta függvények a publikált agent-snapshotra és az élő connector-sorra; a
 * gateway/MCP target graph is behúzhatja (nincs `@/domain/*` import).
 *
 * Fail-closed szabályok:
 * - hiányzó / ismeretlen `wikiAccess` = `read` (a meglévő KB-linkek mai viselkedése);
 * - `write` csak `accessMode: write` linken érvényes, különben `read`;
 * - hiányzó / ismeretlen `wikiWriteMode` = `approval`;
 * - ismeretlen `visibility` = senkinek nem látszik; `private_to_user` csak a tulajdonosnak.
 */

import type { WriteApprovalMode } from './write-approval-modes'

export const WIKI_ACCESS_LEVELS = ['none', 'read', 'submit', 'write'] as const
export type WikiAccessLevel = (typeof WIKI_ACCESS_LEVELS)[number]
export type WikiNeed = 'read' | 'submit' | 'write'

export const KB_VISIBILITIES = ['shared', 'private_to_user'] as const
export type KbVisibility = (typeof KB_VISIBILITIES)[number]

export const KB_CATALOG_CONNECTOR_NAME = 'kb:catalog'
const OWNED_KB_NAME = /^kb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** A snapshot `connectors[]` sorának a wikire vonatkozó része. */
export type WikiSnapshotConnector = {
  connectorId: string
  name?: string
  type: string
  accessMode: 'read' | 'write'
  wikiAccess?: WikiAccessLevel
  wikiWriteMode?: WriteApprovalMode
  wikiCollectFocus?: string
  visibility?: KbVisibility
  ownerUserId?: string
}

export type KbVisibilityRow = {
  visibility?: unknown
  ownerUserId?: string | null
}

export function isWikiAccessLevel(value: unknown): value is WikiAccessLevel {
  return typeof value === 'string' && (WIKI_ACCESS_LEVELS as readonly string[]).includes(value)
}

export function effectiveWikiAccess(row: { accessMode?: unknown; wikiAccess?: unknown }): WikiAccessLevel {
  const raw = isWikiAccessLevel(row.wikiAccess) ? row.wikiAccess : 'read'
  if (raw === 'write' && row.accessMode !== 'write') return 'read'
  return raw
}

export function effectiveWikiWriteMode(row: { wikiWriteMode?: unknown } | null | undefined): WriteApprovalMode {
  return row?.wikiWriteMode === 'direct' ? 'direct' : 'approval'
}

export function wikiAccessAllows(access: WikiAccessLevel, need: WikiNeed): boolean {
  if (need === 'write') return access === 'write'
  if (need === 'submit') return access === 'submit' || access === 'write'
  return access !== 'none'
}

/** D14: privát wikinél új kapcsolat alapból közvetlen írás, közösnél jóváhagyás. */
export function defaultWikiWriteMode(visibility: unknown): WriteApprovalMode {
  return visibility === 'private_to_user' ? 'direct' : 'approval'
}

export function isPrivateKnowledgeBase(row: KbVisibilityRow | null | undefined): boolean {
  return row?.visibility === 'private_to_user'
}

/**
 * D13: privát KB csak a tulajdonosnak létezik. A régi snapshot-soroknak nincs
 * `visibility` mezője — az `undefined`/`null` közösnek számít.
 */
export function isKnowledgeBaseVisibleTo(row: KbVisibilityRow, userId: string): boolean {
  if (row.visibility === undefined || row.visibility === null || row.visibility === 'shared') return true
  if (row.visibility === 'private_to_user') {
    return typeof row.ownerUserId === 'string' && row.ownerUserId.length > 0 && row.ownerUserId === userId
  }
  return false
}

/**
 * A hívó felhasználóra szűkített snapshot: a nem neki szóló privát és a
 * `wikiAccess: none` tudásbázis-kötések kimaradnak — mintha nem is léteznének.
 * Minden más connector érintetlen.
 */
export function scopeSnapshotConnectorsToUser<T extends WikiSnapshotConnector>(
  connectors: readonly T[],
  userId: string,
): T[] {
  return connectors.filter((row) => {
    if (row.type !== 'knowledge_base') return true
    if (!isKnowledgeBaseVisibleTo(row, userId)) return false
    return effectiveWikiAccess(row) !== 'none'
  })
}

export function scopeSnapshotToUser<S extends { connectors: WikiSnapshotConnector[] }>(
  snapshot: S,
  userId: string,
): S {
  const connectors = scopeSnapshotConnectorsToUser(snapshot.connectors, userId)
  if (connectors.length === snapshot.connectors.length) return snapshot
  return { ...snapshot, connectors: connectors as S['connectors'] }
}

export type WikiScope = {
  connectorId: string
  name: string | null
  access: Exclude<WikiAccessLevel, 'none'>
  writeMode: WriteApprovalMode
  collectFocus: string | null
  visibility: KbVisibility
}

export type WikiScopes = {
  readable: WikiScope[]
  submittable: WikiScope[]
  writable: WikiScope[]
}

/** Mely wikiket olvashatja / küldhet bele / írhatja a hívó (snapshot + principal.userId). */
export function resolveWikiScopes(
  snapshot: { connectors: WikiSnapshotConnector[] },
  userId: string,
): WikiScopes {
  const readable: WikiScope[] = []
  for (const row of scopeSnapshotConnectorsToUser(snapshot.connectors, userId)) {
    if (row.type !== 'knowledge_base') continue
    const access = effectiveWikiAccess(row)
    if (access === 'none') continue
    readable.push({
      connectorId: row.connectorId,
      name: row.name ?? null,
      access,
      writeMode: effectiveWikiWriteMode(row),
      collectFocus: row.wikiCollectFocus?.trim() || null,
      visibility: row.visibility === 'private_to_user' ? 'private_to_user' : 'shared',
    })
  }
  return {
    readable,
    submittable: readable.filter((scope) => wikiAccessAllows(scope.access, 'submit')),
    writable: readable.filter((scope) => wikiAccessAllows(scope.access, 'write')),
  }
}

export type LiveKbConnector = {
  id: string
  tenantId: string
  type: string
  lifecycleState?: string
  visibility?: unknown
  ownerUserId?: string | null
}

export type WikiTargetDenied = {
  ok: false
  /** `not_found` nem árulja el, hogy a wiki létezik-e (D13). */
  reason: 'not_found' | 'wiki_write_not_allowed' | 'wiki_submit_not_allowed' | 'wiki_id_required'
}

export type WikiTargetAllowed = {
  ok: true
  wikiId: string | null
  connectorId: string
  scope: WikiScope
}

export type WikiTargetDeps = {
  findWikiById: (wikiId: string) => Promise<{ id: string; connectorId: string } | null>
  findWikiByConnectorId?: (connectorId: string) => Promise<{ id: string } | null>
  findConnector: (connectorId: string) => Promise<LiveKbConnector | null>
}

/**
 * `wikiId` → connector feloldás a kért joggal. `wikiId` nélkül az egyetlen
 * megfelelő wiki a cél; több jelöltnél `wiki_id_required`.
 */
export async function resolveWikiTarget(
  deps: WikiTargetDeps,
  input: {
    snapshot: { connectors: WikiSnapshotConnector[] }
    principal: { userId: string; tenantId: string }
    wikiId?: string | null
    need: WikiNeed
  },
): Promise<WikiTargetAllowed | WikiTargetDenied> {
  const scopes = resolveWikiScopes(input.snapshot, input.principal.userId)
  const pool =
    input.need === 'write' ? scopes.writable : input.need === 'submit' ? scopes.submittable : scopes.readable

  let connectorId: string
  let wikiId: string | null = null
  if (input.wikiId) {
    const wiki = await deps.findWikiById(input.wikiId)
    if (!wiki) return { ok: false, reason: 'not_found' }
    connectorId = wiki.connectorId
    wikiId = wiki.id
  } else {
    if (pool.length === 0) {
      return { ok: false, reason: scopes.readable.length === 0 ? 'not_found' : deniedReason(input.need) }
    }
    if (pool.length > 1) return { ok: false, reason: 'wiki_id_required' }
    connectorId = pool[0].connectorId
  }

  const live = await deps.findConnector(connectorId)
  if (
    !live ||
    live.tenantId !== input.principal.tenantId ||
    live.type !== 'knowledge_base' ||
    (live.lifecycleState !== undefined && live.lifecycleState !== 'active') ||
    !isKnowledgeBaseVisibleTo(live, input.principal.userId)
  ) {
    return { ok: false, reason: 'not_found' }
  }
  const scope = scopes.readable.find((row) => row.connectorId === connectorId)
  if (!scope) return { ok: false, reason: 'not_found' }
  if (!wikiAccessAllows(scope.access, input.need)) return { ok: false, reason: deniedReason(input.need) }
  if (!wikiId && deps.findWikiByConnectorId) {
    wikiId = (await deps.findWikiByConnectorId(connectorId))?.id ?? null
  }
  return { ok: true, wikiId, connectorId, scope }
}

function deniedReason(need: WikiNeed): WikiTargetDenied['reason'] {
  if (need === 'write') return 'wiki_write_not_allowed'
  if (need === 'submit') return 'wiki_submit_not_allowed'
  return 'not_found'
}

/** Az agent saját tudásbázisa `kb:<agentId>` néven él; ebből a tulajdonos agent. */
export function ownerAgentIdForKnowledgeBase(connectorName: string | null | undefined): string | null {
  if (!connectorName) return null
  return OWNED_KB_NAME.exec(connectorName)?.[1]?.toLowerCase() ?? null
}

export type WikiApproverScope =
  /** Privát wiki: a tulajdonos maga (D13/D14). */
  | { kind: 'owner_user'; userId: string }
  /** Agent saját wikije: a tulajdonos agent jóváhagyója (nem az író agenté). */
  | { kind: 'agent_owner'; agentId: string; approverUserId: string | null }
  /** Közös (katalógus / megosztott) wiki: tenant admin, vagy a connector megnevezett jóváhagyója. */
  | { kind: 'tenant_admin'; approverUserId: string | null }

/** D4: a jóváhagyási kártya a wiki gazdájához megy. */
export function resolveWikiApprover(input: {
  connector: { name?: string | null; visibility?: unknown; ownerUserId?: string | null; approverUserId?: string | null }
  ownerAgent?: { id: string; approverUserId?: string | null } | null
}): WikiApproverScope {
  const { connector } = input
  if (isPrivateKnowledgeBase(connector)) {
    if (!connector.ownerUserId) throw new Error('private_kb_owner_missing')
    return { kind: 'owner_user', userId: connector.ownerUserId }
  }
  const ownerAgentId = ownerAgentIdForKnowledgeBase(connector.name)
  if (ownerAgentId && input.ownerAgent && input.ownerAgent.id.toLowerCase() === ownerAgentId) {
    return {
      kind: 'agent_owner',
      agentId: input.ownerAgent.id,
      approverUserId: connector.approverUserId ?? input.ownerAgent.approverUserId ?? null,
    }
  }
  return { kind: 'tenant_admin', approverUserId: connector.approverUserId ?? null }
}

export type WikiDecider = { userId: string; role: string; assumed?: boolean }

/** Ki dönthet egy wiki change-setről. Privátnál admin / superadmin sem (a tartalmat sem láthatja). */
export function canDecideWikiChange(actor: WikiDecider, scope: WikiApproverScope): boolean {
  if (scope.kind === 'owner_user') return actor.userId === scope.userId
  if (scope.approverUserId && actor.userId === scope.approverUserId) return true
  if (actor.assumed || actor.role === 'admin') return true
  if (scope.kind === 'agent_owner' && !scope.approverUserId) return actor.role === 'approver'
  return false
}

/**
 * Privát KB-t csak a tulajdonos kapcsolhat agenthez és állíthatja a jogát;
 * közöset a tenant admin.
 */
export function canManageKnowledgeBaseLink(
  connector: KbVisibilityRow,
  actor: { userId: string; role: string },
): boolean {
  if (isPrivateKnowledgeBase(connector)) {
    return !!connector.ownerUserId && connector.ownerUserId === actor.userId
  }
  if (connector.visibility !== undefined && connector.visibility !== null && connector.visibility !== 'shared') {
    return false
  }
  return actor.role === 'admin'
}

/** In-progress + lejárt foglalás olvasáskor `pending` (háttérjob nélkül, D6). */
export function effectiveInboxStatus(
  row: { wikiStatus: string | null; wikiClaimExpiresAt: Date | null },
  now: Date,
): 'pending' | 'in_progress' | 'processed' | 'skipped' | null {
  const status = row.wikiStatus
  if (status === null) return null
  if (status === 'in_progress') {
    return row.wikiClaimExpiresAt && row.wikiClaimExpiresAt.getTime() > now.getTime() ? 'in_progress' : 'pending'
  }
  if (status === 'pending' || status === 'processed' || status === 'skipped') return status
  return null
}

export const WIKI_CLAIM_TTL_MS = 2 * 60 * 60 * 1000
/** D16: eltávolított tulajdonos privát KB-ja ennyi után törlődik véglegesen. */
export const PRIVATE_KB_ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000
