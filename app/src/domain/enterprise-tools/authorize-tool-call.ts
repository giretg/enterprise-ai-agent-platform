import type { AgentDefinition, AgentDefinitionSnapshot } from '@/domain/agent-definition'
import { findHttpApiEndpoint } from '@/domain/connector/http-api-client'
import {
  delegatedScopeDeniedReason,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { TOOL_REQUIREMENTS } from '@/domain/connector-grant/tool-connector-requirements'
import {
  resolveLinkedAccountGrant,
  type LinkedAccountChoice,
} from '@/domain/connector-grant/linked-account'
import {
  TENANT_MAILBOX_DISCONNECTED,
  tenantMailboxOf,
} from '@/domain/connector-grant/tenant-mailbox'
import { effectiveWikiAccess, wikiAccessAllows, isKnowledgeBaseVisibleTo, scopeSnapshotConnectorsToUser } from '@/lib/wiki-access'
import { asUuid } from './tool-error-messages'
import {
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_GET_THREAD_TOOL,
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_SEND_TOOL,
  HTTP_API_GET_ALL_TOOL,
  HTTP_API_GET_TOOL,
  HTTP_API_REQUEST_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_SEARCH_TOOL,
  KB_WIKI_WRITE_TOOL,
  MAIL_CREATE_DRAFT_TOOL,
  MAIL_GET_ATTACHMENT_TOOL,
  MAIL_GET_MESSAGE_TOOL,
  MAIL_GET_THREAD_TOOL,
  MAIL_LIST_ACCOUNTS_TOOL,
  MAIL_MARK_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_SEND_TOOL,
  isEnterpriseMailTool,
  isEnterpriseMailWriteTool,
  capabilityToolsFor,
} from './tool-definitions'
import { listMailAccounts, resolveMailAccounts } from '@/domain/mail/mail'

const KB_READ_TOOLS = [KB_GET_DOCUMENT_TOOL, KB_GET_PAGE_TOOL, KB_LIST_INDEX_TOOL, KB_SEARCH_TOOL]

export type ToolCallPrincipal = {
  userId: string
  tenantId: string
  role: string
  assumed: boolean
}

export type AuthorizeToolCallInput = {
  principal: ToolCallPrincipal
  definition: AgentDefinition
  toolName: string
  args: Record<string, unknown>
}

export type LiveConnectorRow = {
  id: string
  tenantId: string
  type: string
  authMode: string
  lifecycleState: string
  name?: string
  secretAlias?: string | null
  config?: unknown
  /** #942 D13: knowledge_base láthatóság (`shared` | `private_to_user`). */
  visibility?: unknown
  ownerUserId?: string | null
}

export type HttpApiConnectorChoice = {
  connectorId: string
  name?: string
  description?: string | null
}

export type AuthorizeToolCallDenied = {
  allowed: false
  reason: string
  connectorId?: string
  /** Több http_api kötés esetén, ha path alapján nem egyértelmű. */
  connectorChoices?: HttpApiConnectorChoice[]
  /** Több kapcsolt fiók esetén, ha az `account` argumentum hiányzik vagy ismeretlen. */
  accountChoices?: LinkedAccountChoice[]
  /** #1028: megszakadt tenant-postafiók címe a usernek szóló üzenethez. */
  mailboxAddress?: string | null
}

export type AuthorizeToolCallAllowed = {
  allowed: true
  connectorId: string
  connector: LiveConnectorRow
  grantId?: string | null
  tokenRef?: string | null
  grant?: LiveGrantRow | null
  /**
   * #1030: feloldott mail_* fiók handle. Beégetjük a jóváhagyásba / execute-ba,
   * különben account nélkül a HITL „saját postafiók”-ot hazudhat, a execute pedig
   * a mindenkori primary/egyetlen fiókra válthat.
   */
  resolvedMailAccount?: string
}

export type AuthorizeToolCallResult = AuthorizeToolCallAllowed | AuthorizeToolCallDenied

export type LiveGrantRow = {
  id: string
  tokenRef: string
  scopes: unknown
  status: string
  metadata?: unknown
  accountLabel?: string | null
  nickname?: string | null
}

export type AuthorizeToolCallDeps = {
  findConnector: (id: string) => Promise<LiveConnectorRow | null>
  findActiveGrant: (input: {
    tenantId: string
    connectorId: string
    userId: string
  }) => Promise<LiveGrantRow | null>
  findActiveGrants?: (input: {
    tenantId: string
    connectorId: string
    userId: string
  }) => Promise<LiveGrantRow[]>
  /** #1028: tenant-postafiók aktív grantje (a hívó usertől független). */
  findActiveTenantGrant?: (input: { tenantId: string; connectorId: string }) => Promise<LiveGrantRow | null>
  /** #1030: az agent saját postafiókja — a mail_* alapértelmezett fiókja. */
  findPrimaryMailboxConnectorId?: (input: { agentId: string; tenantId: string }) => Promise<string | null>
}

async function loadActiveGrants(
  deps: AuthorizeToolCallDeps,
  input: { tenantId: string; connectorId: string; userId: string },
): Promise<LiveGrantRow[]> {
  if (deps.findActiveGrants) return deps.findActiveGrants(input)
  const one = await deps.findActiveGrant(input)
  return one ? [one] : []
}

function missingConnectorReason(connectorType: string, accessMode: string): string {
  return `missing_${connectorType}_connector_${accessMode}`
}

type SnapshotConnector = AgentDefinitionSnapshot['connectors'][number]

function httpMethodForTool(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === HTTP_API_REQUEST_TOOL) {
    const method = args.method
    return typeof method === 'string' ? method.toUpperCase() : null
  }
  if (toolName === HTTP_API_GET_TOOL || toolName === HTTP_API_GET_ALL_TOOL) return 'GET'
  return null
}

function connectorSnapshotRow(
  definition: AgentDefinition,
  connectorId: string,
): SnapshotConnector | undefined {
  return definition.snapshot.connectors.find((row) => row.connectorId === connectorId)
}

function httpApiSnapshotHasEndpoint(row: SnapshotConnector, method: string, path: string): boolean {
  if (!row.endpoints?.length) return false
  return (
    findHttpApiEndpoint({ endpoints: row.endpoints }, method, path) !== undefined
  )
}

function normalizeConnectorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pickByConnectorName(
  candidates: SnapshotConnector[],
  connectorName: string,
): SnapshotConnector[] {
  const wanted = connectorName.trim().toLowerCase()
  return candidates.filter((row) => row.name?.trim().toLowerCase() === wanted)
}

function connectorChoicesFromCandidates(
  definition: AgentDefinition,
  candidates: SnapshotConnector[],
): HttpApiConnectorChoice[] {
  return candidates.map((row) => {
    const snap = connectorSnapshotRow(definition, row.connectorId)
    return {
      connectorId: row.connectorId,
      name: snap?.name ?? row.name,
      description: snap?.description ?? null,
    }
  })
}

function pickBinding(
  definition: AgentDefinition,
  connectorType: string,
  accessMode: string,
  connectorIdArg: string | undefined,
  connectorNameArg: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): { connectorId: string } | { reason: string; connectorChoices?: HttpApiConnectorChoice[] } {
  const candidates = definition.snapshot.connectors.filter(
    (row) =>
      row.type === connectorType &&
      (accessMode === 'read' ? row.accessMode === 'read' || row.accessMode === 'write' : row.accessMode === 'write'),
  )
  if (connectorIdArg) {
    const hit = candidates.find((row) => row.connectorId === connectorIdArg)
    if (!hit) return { reason: missingConnectorReason(connectorType, accessMode) }
    return { connectorId: hit.connectorId }
  }
  if (connectorNameArg) {
    const byName = pickByConnectorName(candidates, connectorNameArg)
    if (byName.length === 1) return { connectorId: byName[0].connectorId }
    if (byName.length > 1) {
      return {
        reason: 'connector_id_required',
        connectorChoices: connectorChoicesFromCandidates(definition, byName),
      }
    }
    return { reason: missingConnectorReason(connectorType, accessMode) }
  }
  if (candidates.length === 1) return { connectorId: candidates[0].connectorId }
  if (candidates.length === 0) return { reason: missingConnectorReason(connectorType, accessMode) }

  if (connectorType === 'http_api') {
    const path = typeof args.path === 'string' ? args.path : ''
    const method = httpMethodForTool(toolName, args)
    if (path && method) {
      const byEndpoint = candidates.filter((row) => {
        const snap = connectorSnapshotRow(definition, row.connectorId)
        return snap ? httpApiSnapshotHasEndpoint(snap, method, path) : false
      })
      if (byEndpoint.length === 1) return { connectorId: byEndpoint[0].connectorId }
    }
    return {
      reason: 'connector_id_required',
      connectorChoices: connectorChoicesFromCandidates(definition, candidates),
    }
  }

  // #1028: pl. saját Gmail + közös postafiók — a modell a nevek közül választ (connectorName).
  return {
    reason: 'connector_id_required',
    connectorChoices: connectorChoicesFromCandidates(definition, candidates),
  }
}

/**
 * #1030: a mail_* eszköz a saját capabilityjével, vagy a postafiók típusának megfelelő
 * régi eszközével hívható (gmail_* a Google-, http_api_* az AgentMail/M365-postafióknál).
 * Másik eszköz (pl. CRM-célú http_api_request) nem nyit levélküldést.
 */
const MAIL_LEGACY_CAPABILITIES: Record<string, { gmail: string; httpApi: string[] }> = {
  [MAIL_LIST_ACCOUNTS_TOOL]: { gmail: GMAIL_SEARCH_TOOL, httpApi: [HTTP_API_GET_TOOL, HTTP_API_GET_ALL_TOOL] },
  [MAIL_SEARCH_TOOL]: { gmail: GMAIL_SEARCH_TOOL, httpApi: [HTTP_API_GET_TOOL, HTTP_API_GET_ALL_TOOL] },
  [MAIL_GET_MESSAGE_TOOL]: { gmail: GMAIL_GET_MESSAGE_TOOL, httpApi: [HTTP_API_GET_TOOL, HTTP_API_GET_ALL_TOOL] },
  [MAIL_GET_THREAD_TOOL]: { gmail: GMAIL_GET_THREAD_TOOL, httpApi: [HTTP_API_GET_TOOL, HTTP_API_GET_ALL_TOOL] },
  [MAIL_GET_ATTACHMENT_TOOL]: { gmail: GMAIL_GET_MESSAGE_TOOL, httpApi: [HTTP_API_GET_TOOL, HTTP_API_GET_ALL_TOOL] },
  [MAIL_SEND_TOOL]: { gmail: GMAIL_SEND_TOOL, httpApi: [HTTP_API_REQUEST_TOOL] },
  [MAIL_CREATE_DRAFT_TOOL]: { gmail: GMAIL_CREATE_DRAFT_TOOL, httpApi: [HTTP_API_REQUEST_TOOL] },
  [MAIL_MARK_TOOL]: { gmail: GMAIL_MODIFY_LABELS_TOOL, httpApi: [HTTP_API_REQUEST_TOOL] },
}

function mailCapabilityAllowed(
  definition: AgentDefinition,
  toolName: string,
  kind: 'gmail' | 'httpApi' | 'any',
): boolean {
  const legacy = MAIL_LEGACY_CAPABILITIES[toolName]
  const accepted = [
    toolName,
    ...(legacy && kind !== 'httpApi' ? [legacy.gmail] : []),
    ...(legacy && kind !== 'gmail' ? legacy.httpApi : []),
  ]
  return definition.snapshot.capabilities.some((row) => row.allowed && accepted.includes(row.toolName))
}

async function authorizeMailTool(
  deps: AuthorizeToolCallDeps,
  input: AuthorizeToolCallInput,
): Promise<AuthorizeToolCallResult> {
  const write = isEnterpriseMailWriteTool(input.toolName)
  if (!mailCapabilityAllowed(input.definition, input.toolName, 'any')) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }

  const primaryConnectorId = deps.findPrimaryMailboxConnectorId
    ? await deps.findPrimaryMailboxConnectorId({
        agentId: input.definition.agentId,
        tenantId: input.principal.tenantId,
      })
    : null
  const accounts = await listMailAccounts({
    definition: input.definition,
    primaryConnectorId,
    findConnector: deps.findConnector,
    findActiveGrants: (row) => loadActiveGrants(deps, row),
    userId: input.principal.userId,
    tenantId: input.principal.tenantId,
  })
  if (input.toolName === MAIL_LIST_ACCOUNTS_TOOL) {
    if (accounts.length === 0) return { allowed: false, reason: 'missing_mailbox' }
    return authorizeLoadedConnector(deps, input, accounts[0].connectorId, accounts[0].grantId)
  }
  const resolved = resolveMailAccounts(accounts, input.args.account, {
    allAllowed: input.toolName === MAIL_SEARCH_TOOL,
    write,
    primaryConnectorId,
  })
  if (!resolved.ok) {
    return {
      allowed: false,
      reason: resolved.reason,
      ...(resolved.accounts.length > 0 ? { accountChoices: resolved.accounts } : {}),
    }
  }
  const picked = resolved.accounts[0]
  if (!picked) return { allowed: false, reason: 'missing_mailbox' }
  if (!mailCapabilityAllowed(input.definition, input.toolName, picked.kind === 'google' ? 'gmail' : 'httpApi')) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }
  const loaded = await authorizeLoadedConnector(deps, input, picked.connectorId, picked.grantId)
  if (!loaded.allowed) return loaded
  return { ...loaded, resolvedMailAccount: picked.account }
}

async function authorizeLoadedConnector(
  deps: AuthorizeToolCallDeps,
  input: AuthorizeToolCallInput,
  connectorId: string,
  preferredGrantId?: string,
): Promise<AuthorizeToolCallResult> {
  const connector = await deps.findConnector(connectorId)
  if (!connector) return { allowed: false, reason: 'connector_not_active' }
  if (connector.tenantId !== input.principal.tenantId) return { allowed: false, reason: 'tenant_isolation' }
  if (connector.lifecycleState !== 'active') return { allowed: false, reason: 'connector_not_active' }

  const scopeTool = MAIL_LEGACY_CAPABILITIES[input.toolName]?.gmail ?? input.toolName

  if (tenantMailboxOf(connector)) {
    const grant = deps.findActiveTenantGrant
      ? await deps.findActiveTenantGrant({ tenantId: input.principal.tenantId, connectorId: connector.id })
      : null
    if (!grant) {
      return {
        allowed: false,
        reason: TENANT_MAILBOX_DISCONNECTED,
        connectorId: connector.id,
        mailboxAddress: tenantMailboxOf(connector)?.address ?? null,
      }
    }
    if (
      !isDelegatedToolAllowedByScopes({
        connectorType: connector.type,
        toolName: scopeTool,
        args: input.args,
        scopes: parseDelegatedGrantScopes(grant.scopes),
      })
    ) {
      return { allowed: false, reason: delegatedScopeDeniedReason(connector.type), connectorId: connector.id }
    }
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
      grantId: grant.id,
      tokenRef: grant.tokenRef,
      grant,
    }
  }

  const delegated = connector.authMode === 'user_delegated'
  if (!delegated) {
    if (connector.type !== 'http_api' && connector.type !== 'mcp' && connector.type !== 'gmail') {
      return { allowed: false, reason: 'acting_user_required' }
    }
    return { allowed: true, connectorId: connector.id, connector }
  }

  const grants = await loadActiveGrants(deps, {
    tenantId: input.principal.tenantId,
    connectorId: connector.id,
    userId: input.principal.userId,
  })
  const preferred = preferredGrantId ? grants.find((row) => row.id === preferredGrantId) : undefined
  const pickedGrant = preferred
    ? { ok: true as const, grant: preferred }
    : resolveLinkedAccountGrant(
        grants.map((grant) => ({
          ...grant,
          accountLabel: grant.accountLabel ?? null,
          nickname: grant.nickname ?? null,
        })),
        input.args.account,
      )
  if (!pickedGrant.ok) {
    return {
      allowed: false,
      reason: pickedGrant.reason,
      connectorId: connector.id,
      ...(pickedGrant.accounts.length > 0 ? { accountChoices: pickedGrant.accounts } : {}),
    }
  }
  const grant = grants.find((row) => row.id === pickedGrant.grant.id) ?? pickedGrant.grant
  if (
    !isDelegatedToolAllowedByScopes({
      connectorType: connector.type,
      toolName: scopeTool,
      args: input.args,
      scopes: parseDelegatedGrantScopes(grant.scopes),
    })
  ) {
    return { allowed: false, reason: delegatedScopeDeniedReason(connector.type), connectorId: connector.id }
  }
  return {
    allowed: true,
    connectorId: connector.id,
    connector,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
    grant,
  }
}

export async function authorizeToolCall(
  deps: AuthorizeToolCallDeps,
  input: AuthorizeToolCallInput,
): Promise<AuthorizeToolCallResult> {
  if (isEnterpriseMailTool(input.toolName)) {
    return authorizeMailTool(deps, input)
  }

  const requirement = TOOL_REQUIREMENTS[input.toolName]
  if (!requirement) {
    return { allowed: false, reason: 'tool_not_configured' }
  }

  // #943: a wiki-írás a `kb_ingest` képességre is épülhet — a tényleges jog a kötés `wikiAccess`-e.
  const accepted =
    input.toolName === KB_GET_DOCUMENT_TOOL
      ? KB_READ_TOOLS
      : input.toolName === KB_WIKI_WRITE_TOOL
        ? [KB_WIKI_WRITE_TOOL, KB_INGEST_TOOL]
        : capabilityToolsFor(input.toolName)
  const capability = input.definition.snapshot.capabilities.find(
    (row) => accepted.includes(row.toolName) && row.allowed,
  )
  if (!capability) {
    return { allowed: false, reason: 'capability_not_allowed' }
  }

  // #942 D13: a nem a hívónak szóló privát és a `wikiAccess: none` KB-kötés
  // nem létezik a hívó számára; közvetlen hivatkozásra `not_found`.
  const isKb = requirement.connectorType === 'knowledge_base'
  const wikiIntake = input.toolName === KB_INGEST_TOOL && input.args.processingMode === 'wiki'
  const definition = isKb
    ? {
        ...input.definition,
        snapshot: {
          ...input.definition.snapshot,
          connectors: scopeSnapshotConnectorsToUser(input.definition.snapshot.connectors, input.principal.userId),
        },
      }
    : input.definition
  const connectorIdArg = asUuid(input.args.connectorId)
  if (
    isKb &&
    connectorIdArg &&
    !definition.snapshot.connectors.some((row) => row.connectorId === connectorIdArg && row.type === 'knowledge_base')
  ) {
    return { allowed: false, reason: 'not_found' }
  }

  const picked = pickBinding(
    definition,
    requirement.connectorType,
    wikiIntake ? 'read' : requirement.accessMode,
    connectorIdArg,
    normalizeConnectorName(input.args.connectorName),
    input.toolName,
    input.args,
  )
  if ('reason' in picked) {
    return {
      allowed: false,
      reason: input.toolName === KB_GET_DOCUMENT_TOOL && picked.reason === 'missing_knowledge_base_connector_read'
        ? 'not_found' : picked.reason,
      ...(picked.connectorChoices ? { connectorChoices: picked.connectorChoices } : {}),
    }
  }

  const connector = await deps.findConnector(picked.connectorId)
  if (!connector) {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.tenantId !== input.principal.tenantId) {
    return { allowed: false, reason: 'tenant_isolation' }
  }
  if (connector.lifecycleState !== 'active') {
    return { allowed: false, reason: 'connector_not_active' }
  }
  if (connector.type !== requirement.connectorType) {
    return { allowed: false, reason: 'connector_not_active' }
  }

  if (isKb && !isKnowledgeBaseVisibleTo(connector, input.principal.userId)) {
    return { allowed: false, reason: 'not_found' }
  }

  if (wikiIntake) {
    const binding = definition.snapshot.connectors.find((row) => row.connectorId === connector.id)
    if (!binding || !wikiAccessAllows(effectiveWikiAccess(binding), 'submit')) {
      return { allowed: false, reason: 'wiki_submit_not_allowed' }
    }
  }

  if (
    requirement.connectorType === 'knowledge_base' ||
    requirement.connectorType === 'code_sandbox' ||
    requirement.connectorType === 'web_search'
  ) {
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
      grantId: null,
      tokenRef: null,
    }
  }

  // #1028: tenant-postafiók — a token a tenanté, a hívó user grantjeihez nem nyúlunk.
  if (tenantMailboxOf(connector)) {
    const grant = deps.findActiveTenantGrant
      ? await deps.findActiveTenantGrant({ tenantId: input.principal.tenantId, connectorId: connector.id })
      : null
    if (!grant) {
      return {
        allowed: false,
        reason: TENANT_MAILBOX_DISCONNECTED,
        connectorId: connector.id,
        mailboxAddress: tenantMailboxOf(connector)?.address ?? null,
      }
    }
    if (
      !isDelegatedToolAllowedByScopes({
        connectorType: connector.type,
        toolName: input.toolName,
        args: input.args,
        scopes: parseDelegatedGrantScopes(grant.scopes),
      })
    ) {
      return { allowed: false, reason: delegatedScopeDeniedReason(connector.type), connectorId: connector.id }
    }
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
      grantId: grant.id,
      tokenRef: grant.tokenRef,
      grant,
    }
  }

  const delegated = connector.authMode === 'user_delegated'
  if (!delegated && requirement.connectorType !== 'http_api' && requirement.connectorType !== 'mcp') {
    return { allowed: false, reason: 'acting_user_required' }
  }

  if (!delegated) {
    return {
      allowed: true,
      connectorId: connector.id,
      connector,
    }
  }

  const grants = await loadActiveGrants(deps, {
    tenantId: input.principal.tenantId,
    connectorId: connector.id,
    userId: input.principal.userId,
  })
  const pickedGrant = resolveLinkedAccountGrant(
    grants.map((grant) => ({
      ...grant,
      accountLabel: grant.accountLabel ?? null,
      nickname: grant.nickname ?? null,
    })),
    input.args.account,
  )
  if (!pickedGrant.ok) {
    return {
      allowed: false,
      reason: pickedGrant.reason,
      connectorId: connector.id,
      ...(pickedGrant.accounts.length > 0 ? { accountChoices: pickedGrant.accounts } : {}),
    }
  }
  const grant = grants.find((row) => row.id === pickedGrant.grant.id) ?? pickedGrant.grant

  const scopes = parseDelegatedGrantScopes(grant.scopes)
  if (
    !isDelegatedToolAllowedByScopes({
      connectorType: connector.type,
      toolName: input.toolName,
      args: input.args,
      scopes,
    })
  ) {
    return {
      allowed: false,
      reason: delegatedScopeDeniedReason(connector.type),
      connectorId: connector.id,
    }
  }

  return {
    allowed: true,
    connectorId: connector.id,
    connector,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
    grant,
  }
}
