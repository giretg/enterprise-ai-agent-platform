/**
 * WP-8 — Tool Broker authorizáció-koncern (a broker-magból kiemelve).
 *
 * Az `AllowlistAuthorizer` (§6 szerep-sablon → capability-gate → connector-feloldás
 * → tenant-izoláció → grant/scope), a `TOOL_REQUIREMENTS` connector-mátrix, az
 * `Authorizer` szerződés és a determinisztikus teszteléshez cserélhető DB-lookupok.
 * A `tool-broker-service.ts` ezeket re-exportálja a visszafelé kompatibilitásért.
 */
import type {
  AgentRole,
  ConnectorAccessMode,
  ConnectorType,
  UserStatus,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { gmailToolAllowedByScopes } from '@/domain/connector-grant/gmail-scopes'
import {
  isWebSearchScopeEnabled,
  WEB_SEARCH_CONTROLS_KEY,
  WEB_SEARCH_TENANT_CONTROLS_KEY,
} from '@/domain/web-search/web-search-types'
import type {
  AgentRepository,
  ConnectorGrantRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type {
  AuthorizationResult,
  ToolName,
  UserDirectorySearchEntry,
} from './tool-broker-types'
import { resolveTulajdoniLapParseSource } from '@/lib/tulajdoni-lap-source'

export const TOOL_REQUIREMENTS: Partial<Record<
  ToolName,
  { connectorType: ConnectorType; accessMode: ConnectorAccessMode }
>> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_list_index: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_get_page: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
  ticket_create: { connectorType: 'board', accessMode: 'write' },
  agent_ask: { connectorType: 'board', accessMode: 'write' },
  agent_resolve: { connectorType: 'board', accessMode: 'read' },
  agent_catalog: { connectorType: 'board', accessMode: 'read' },
  user_directory: { connectorType: 'board', accessMode: 'read' },
  gmail_search: { connectorType: 'gmail', accessMode: 'read' },
  gmail_get_message: { connectorType: 'gmail', accessMode: 'read' },
  mailbox_count: { connectorType: 'gmail', accessMode: 'read' },
  gmail_create_draft: { connectorType: 'gmail', accessMode: 'write' },
  gmail_send: { connectorType: 'gmail', accessMode: 'write' },
  http_api_get: { connectorType: 'http_api', accessMode: 'read' },
  http_api_request: { connectorType: 'http_api', accessMode: 'write' },
  repo_prepare: { connectorType: 'workspace', accessMode: 'write' },
  repo_open_pull_request: { connectorType: 'workspace', accessMode: 'write' },
  file_read: { connectorType: 'workspace', accessMode: 'read' },
  file_write: { connectorType: 'workspace', accessMode: 'write' },
  create_html: { connectorType: 'workspace', accessMode: 'write' },
  file_edit: { connectorType: 'workspace', accessMode: 'write' },
  file_list: { connectorType: 'workspace', accessMode: 'read' },
  file_glob: { connectorType: 'workspace', accessMode: 'read' },
  file_search: { connectorType: 'workspace', accessMode: 'read' },
  file_delete: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_read_sheet: { connectorType: 'workspace', accessMode: 'read' },
  xlsx_write_cells: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_format_range: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_layout: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_create: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_append_rows: { connectorType: 'workspace', accessMode: 'write' },
  docx_read: { connectorType: 'workspace', accessMode: 'read' },
  docx_create: { connectorType: 'workspace', accessMode: 'write' },
  pdf_read: { connectorType: 'workspace', accessMode: 'read' },
  pdf_create: { connectorType: 'workspace', accessMode: 'write' },
  /** Csak workspace-path ágon (documentId UUID esetén az authorizer korán kilép). */
  tulajdoni_lap_parse: { connectorType: 'workspace', accessMode: 'read' },
  tulajdoni_lap_egyeztetes: { connectorType: 'workspace', accessMode: 'write' },
  reconcile_records: { connectorType: 'workspace', accessMode: 'write' },
  pptx_create: { connectorType: 'workspace', accessMode: 'write' },
  'sandbox_app.create': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.update_artifact': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.preview': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.export': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.list': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.get': { connectorType: 'board', accessMode: 'read' },
  'sandbox.commit': { connectorType: 'board', accessMode: 'write' },
  'sandbox.request_promotion': { connectorType: 'board', accessMode: 'write' },
  'sandbox.snapshot': { connectorType: 'board', accessMode: 'write' },
  web_search: { connectorType: 'web_search', accessMode: 'read' },
}

export interface Authorizer {
  authorize(input: {
    agentId: string
    tool: ToolName
    args?: Record<string, unknown>
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult>
}

const ORCHESTRATOR_DELEGATION_TOOLS: ToolName[] = ['ticket_create', 'web_research_request']

/**
 * Az acting-user státusz-feloldása. Cserepont a determinisztikus teszteléshez
 * (G5 — suspended user), alapból a Postgres `users` táblát kérdezi.
 */
export type ActingUserLookup = (
  userId: string,
) => Promise<{ status: UserStatus } | null>

/**
 * A szerep-sablon (§3.5) tool-less invariánsának feloldása. Cserepont a
 * teszteléshez; alapból a `role_templates` táblát kérdezi (tenant-saját > rendszer).
 * Ha nincs sablon (pl. nem seedelt DB), a hívó a beégetett alapértelmezésre esik
 * vissza — orchestrator akkor is tool-less (sosem fail-open).
 */
export type RoleTemplateLookup = (
  key: AgentRole,
  tenantId: string | null,
) => Promise<{ toolAccessAllowed: boolean } | null>

const prismaRoleTemplateLookup: RoleTemplateLookup = async (key, tenantId) => {
  const templates = await prisma.roleTemplate.findMany({
    where: { key, OR: [{ tenantId }, { tenantId: null }] },
    select: { tenantId: true, toolAccessAllowed: true },
  })
  const tpl =
    templates.find((t) => t.tenantId === tenantId) ?? templates.find((t) => t.tenantId === null)
  return tpl ? { toolAccessAllowed: tpl.toolAccessAllowed } : null
}

/**
 * web_search kill-switch (Feature-spec — WebSearchTool §7.2, WS13). Cserepont a
 * teszteléshez; alapból a `platform_settings` táblát kérdezi.
 */
export type WebSearchEnabledLookup = (tenantId: string | null) => Promise<boolean>
export type WebFetchEnabledLookup = () => Promise<boolean>
export type WebResearchDelegationEnabledLookup = () => Promise<boolean>

export const prismaWebSearchEnabledLookup: WebSearchEnabledLookup = async (tenantId) => {
  const platformRow = await prisma.platformSetting.findUnique({ where: { key: WEB_SEARCH_CONTROLS_KEY } })
  const platformValue = platformRow?.value as { killSwitch?: boolean } | null
  if (!tenantId) {
    return isWebSearchScopeEnabled({
      tenantId: null,
      platformKillSwitch: platformValue?.killSwitch === true,
    })
  }
  const tenantRow = await prisma.platformSetting.findUnique({ where: { key: WEB_SEARCH_TENANT_CONTROLS_KEY } })
  const tenantStore = tenantRow?.value as Record<string, { killSwitch?: boolean }> | null
  const tenantBucket = tenantStore?.[tenantId]
  return isWebSearchScopeEnabled({
    tenantId,
    platformKillSwitch: platformValue?.killSwitch === true,
    tenantKillSwitch: tenantBucket?.killSwitch === true,
  })
}

export const prismaWebFetchEnabledLookup: WebFetchEnabledLookup = async () => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'web_fetch.controls' } })
  const value = row?.value as { enabled?: boolean } | null
  return value?.enabled === true
}

export const prismaWebResearchDelegationEnabledLookup: WebResearchDelegationEnabledLookup = async () => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'web_egress.delegation.enabled' } })
  if (typeof row?.value === 'boolean') return row.value
  const value = row?.value as { enabled?: boolean } | null
  return value?.enabled === true
}

const prismaActingUserLookup: ActingUserLookup = async (userId) =>
  prisma.user.findUnique({ where: { id: userId }, select: { status: true } })

/**
 * user_directory feloldás — a tenant AKTÍV humán felhasználóit adja vissza a
 * hozzájuk rendelt szabad szöveges szereppel (`jobDescription`). Cserepont a
 * determinisztikus teszteléshez; alapból a Postgres `users` táblát kérdezi a hívó
 * tenantjára szűkítve (tenant-izoláció — sosem lát cross-tenant felhasználót).
 */
export type TenantUserDirectoryLookup = (
  tenantId: string | null,
) => Promise<UserDirectorySearchEntry[]>

export const prismaTenantUserDirectoryLookup: TenantUserDirectoryLookup = async (tenantId) => {
  const rows = await prisma.user.findMany({
    where: { tenantId, status: 'active' },
    select: { id: true, name: true, email: true, role: true, jobDescription: true, status: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    jobDescription: u.jobDescription,
    status: u.status,
  }))
}

export class AllowlistAuthorizer implements Authorizer {
  constructor(
    private tools: ToolBrokerRepository,
    private agents: AgentRepository,
    private grants: ConnectorGrantRepository,
    private lookupActingUser: ActingUserLookup = prismaActingUserLookup,
    private lookupRoleTemplate: RoleTemplateLookup = prismaRoleTemplateLookup,
  ) {}

  async authorize(input: {
    agentId: string
    tool: ToolName
    args?: Record<string, unknown>
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult> {
    const agent = await this.agents.findById(input.agentId)
    const effectiveTenantId = input.tenantId ?? agent?.tenantId ?? null
    if (agent?.tenantId && input.tenantId && agent.tenantId !== input.tenantId) {
      return { allowed: false, reason: 'tenant_isolation' }
    }

    let skipCapabilityCheck = false
    if (agent) {
      // §6: a Tool Broker ELSŐKÉNT a szerep-sablon `tool_access_allowed` mezőjét
      // nézi (adat-vezérelt, nem beégetett típus-elágazás). Ha nincs sablon (nem
      // seedelt DB), a beégetett alapértelmezésre esünk vissza — orchestrator akkor
      // is tool-less (defense-in-depth, sosem fail-open).
      const template = await this.lookupRoleTemplate(agent.role, effectiveTenantId)
      const toolAccessAllowed = template ? template.toolAccessAllowed : agent.role !== 'orchestrator'
      if (!toolAccessAllowed) {
        if (ORCHESTRATOR_DELEGATION_TOOLS.includes(input.tool)) {
          // Az orchestratornak nincs Tool Broker capability-sora (§3.5/I4), de
          // az egyetlen engedélyezett outbound művelete a ticket-nyitás.
          skipCapabilityCheck = true
        } else {
          return { allowed: false, reason: 'orchestrator_tool_less' }
        }
      }
    }

    if (!skipCapabilityCheck) {
      const capability = await this.tools.findCapability(input.agentId, input.tool)
      if (!capability?.allowed) {
        return { allowed: false, reason: 'capability_not_allowed' }
      }
    }

    if (input.tool === 'web_research_request') {
      return { allowed: true }
    }

    // memory_propose — agent-memory-persistent-cross-conversation-spec.md §6.3:
    // nincs connector-fogalma (nem KB/board/gmail-szerű integráció), a kapu
    // kizárólag a fenti capability-ellenőrzés (Capability(agentId,'memory_propose')).
    if (input.tool === 'memory_propose') {
      return { allowed: true }
    }

    // document_read — csatolmány / Document rekord; nincs connector.
    // tulajdoni_lap_parse documentId (UUID) ágon ugyanez; workspace path ágon
    // viszont workspace connector kell (pdf_read-hez hasonlóan) — lásd TOOL_REQUIREMENTS.
    if (input.tool === 'document_read') {
      return { allowed: true }
    }
    if (input.tool === 'tulajdoni_lap_parse') {
      try {
        const source = resolveTulajdoniLapParseSource({
          documentId:
            typeof input.args?.documentId === 'string' ? input.args.documentId : undefined,
          path: typeof input.args?.path === 'string' ? input.args.path : undefined,
        })
        if (source.kind === 'document') return { allowed: true }
      } catch {
        return { allowed: false, reason: 'missing_parse_source' }
      }
      // workspace path → fall through connector feloldásra
    }
    // A `tulajdoni_lap_egyeztetes` ÍR is (munkafüzet a munkaterületre), ezért
    // documentId-forrásnál sem kaphat rövidebb utat: mindig a workspace
    // connector írás-jogán megy át. A forrás érvényességét a delegáció nézi.
    if (input.tool === 'tulajdoni_lap_egyeztetes') {
      try {
        resolveTulajdoniLapParseSource({
          documentId:
            typeof input.args?.documentId === 'string' ? input.args.documentId : undefined,
          path: typeof input.args?.path === 'string' ? input.args.path : undefined,
        })
      } catch {
        return { allowed: false, reason: 'missing_parse_source' }
      }
    }

    const requirement = TOOL_REQUIREMENTS[input.tool]
    if (!requirement) {
      return { allowed: false, reason: 'tool_not_configured' }
    }
    const requestedConnectorId =
      (input.tool === 'http_api_get' || input.tool === 'http_api_request' || input.tool === 'mailbox_count') &&
      typeof input.args?.connectorId === 'string'
        ? input.args.connectorId
        : null
    const link = requestedConnectorId
      ? await this.tools.findConnectorForAgentById(
          input.agentId,
          requestedConnectorId,
          requirement.connectorType,
          requirement.accessMode,
          effectiveTenantId,
        )
      : await this.tools.findConnectorForAgent(
          input.agentId,
          requirement.connectorType,
          requirement.accessMode,
          effectiveTenantId,
        )
    if (!link) {
      return {
        allowed: false,
        reason: requestedConnectorId
          ? `missing_${requirement.connectorType}_connector_${requirement.accessMode}_${requestedConnectorId}`
          : `missing_${requirement.connectorType}_connector_${requirement.accessMode}`,
      }
    }
    const { connector, agentSecretAlias } = link

    if (connector.tenantId !== null && connector.tenantId !== effectiveTenantId) {
      return { allowed: false, reason: 'tenant_isolation', connector }
    }

    // Provisioning §4.1 / P3 / PN5: egy draft (lifecycle_state != active) connector
    // a Tool Brokerben SOHA nem oldódik fel — egy fél kész draft nem futtatható élesben.
    if (connector.lifecycleState !== 'active') {
      return { allowed: false, reason: 'connector_not_active', connector }
    }

    if (connector.authMode === 'user_delegated') {
      if (!input.actingUserId) {
        return { allowed: false, reason: 'acting_user_required', connector }
      }

      const user = await this.lookupActingUser(input.actingUserId)
      if (!user || user.status === 'suspended') {
        return { allowed: false, reason: 'acting_user_suspended', connector }
      }

      const grant = await this.grants.findActiveGrant({
        tenantId: connector.tenantId ?? effectiveTenantId,
        connectorId: connector.id,
        userId: input.actingUserId,
      })
      if (!grant) {
        return { allowed: false, reason: 'connector_grant_missing', connector }
      }

      if (
        connector.type === 'gmail' &&
        !gmailToolAllowedByScopes({
          tool: input.tool as Extract<ToolName, `gmail_${string}` | 'mailbox_count'>,
          args: input.args,
          scopes: grant.scopes,
        })
      ) {
        return { allowed: false, reason: 'gmail_scope_not_granted', connector }
      }

      return { allowed: true, connector, grant, actingUserId: input.actingUserId, agentSecretAlias }
    }

    return { allowed: true, connector, agentSecretAlias }
  }
}
