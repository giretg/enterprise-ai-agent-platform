/**
 * WP-8 — Tool Broker authorizáció-koncern (a broker-magból kiemelve).
 *
 * Az `AllowlistAuthorizer` (§6 szerep-sablon → capability-gate → connector-feloldás
 * → tenant-izoláció → grant/scope), az `Authorizer` szerződés és a determinisztikus
 * teszteléshez cserélhető DB-lookupok. A connector-mátrix külön modulban él
 * (`tool-connector-requirements.ts`) — itt csak re-exportáljuk, hogy a delegált
 * OAuth provider-regiszter is számolhasson belőle körkörös import nélkül.
 * A `tool-broker-service.ts` ezeket re-exportálja a visszafelé kompatibilitásért.
 */
import type { AgentRole, ConnectorAccessMode, UserStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { isRunAnalystToolAllowed } from '@/domain/agents/run-analyst-role'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import {
  delegatedScopeDeniedReason,
  hasDelegatedScopeCheck,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
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
import {
  isTulajdoniLapEgyeztetesCoverageOnly,
  resolveTulajdoniWorkspaceAccessMode,
} from '@/lib/tulajdoni-workspace-access'

import { TOOL_REQUIREMENTS } from './tool-connector-requirements'

export { TOOL_REQUIREMENTS, toolsRequiringConnector } from './tool-connector-requirements'

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

    // A Futás-elemző naplókat olvas, ezért a capability-táblában megjelenő
    // adminisztratív/driftelt többletjog sem engedhet e-mail-, web- vagy HTTP-egresst.
    // Ez a runtime-kapu a capability-szerkesztő mellett a második védelmi vonal.
    if (agent?.systemRole === RUN_ANALYST_SYSTEM_ROLE && !isRunAnalystToolAllowed(input.tool)) {
      return { allowed: false, reason: 'system_role_tool_not_allowed' }
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
        const writesHandoff =
          typeof input.args?.kimenet === 'string' && input.args.kimenet.trim().length > 0
        if (source.kind === 'document' && !writesHandoff) return { allowed: true }
      } catch {
        return { allowed: false, reason: 'missing_parse_source' }
      }
      // workspace path, vagy documentId + handoff-írás → connector feloldás
    }
    // Coverage-only (proposal lefedettség): nincs lap-forrás — ne követeljük.
    // A többi egyeztető útvonal a forrás érvényességét a delegációban nézi.
    if (input.tool === 'tulajdoni_lap_egyeztetes') {
      const coverageOnly = isTulajdoniLapEgyeztetesCoverageOnly(input.args)
      if (!coverageOnly) {
        const hasProcessedPath =
          typeof input.args?.feldolgozottLapPath === 'string' &&
          input.args.feldolgozottLapPath.trim().length > 0
        if (!hasProcessedPath) {
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
      }
    }

    const requirement = TOOL_REQUIREMENTS[input.tool]
    if (!requirement) {
      return { allowed: false, reason: 'tool_not_configured' }
    }
    // tulajdoni_lap_egyeztetes: Excel NÉLKÜL is írhat `egyeztetes-eltero.json` /
    // `fold_muveletek.json` fájlokat. A korábbi „JSON-only → read” szabály
    // read-only workspace connectorral is átengedte ezeket az írásokat.
    // Coverage-only ágon tényleg csak olvasunk → maradhat read.
    const accessMode: ConnectorAccessMode =
      input.tool === 'tulajdoni_lap_egyeztetes' || input.tool === 'tulajdoni_lap_parse'
        ? resolveTulajdoniWorkspaceAccessMode(input.tool, input.args)
        : requirement.accessMode
    const requestedConnectorId =
      (input.tool === 'http_api_get' ||
        input.tool === 'http_api_get_all' ||
        input.tool === 'http_api_request' ||
        input.tool === 'mailbox_count') &&
      typeof input.args?.connectorId === 'string'
        ? input.args.connectorId
        : null
    const link = requestedConnectorId
      ? await this.tools.findConnectorForAgentById(
          input.agentId,
          requestedConnectorId,
          requirement.connectorType,
          accessMode,
          effectiveTenantId,
        )
      : await this.tools.findConnectorForAgent(
          input.agentId,
          requirement.connectorType,
          accessMode,
          effectiveTenantId,
        )
    if (!link) {
      return {
        allowed: false,
        reason: requestedConnectorId
          ? `missing_${requirement.connectorType}_connector_${accessMode}_${requestedConnectorId}`
          : `missing_${requirement.connectorType}_connector_${accessMode}`,
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

      // Least privilege scope-kapu — provider-független. Amelyik delegált
      // connector-típushoz nincs scope-értelmezés a regiszterben, ott a grant
      // léte a jel; a scope elégségességét ilyenkor a külső szolgáltató bírálja.
      if (
        hasDelegatedScopeCheck(connector.type) &&
        !isDelegatedToolAllowedByScopes({
          connectorType: connector.type,
          toolName: input.tool,
          ...(input.args ? { args: input.args } : {}),
          scopes: parseDelegatedGrantScopes(grant.scopes),
        })
      ) {
        return { allowed: false, reason: delegatedScopeDeniedReason(connector.type), connector }
      }

      return { allowed: true, connector, grant, actingUserId: input.actingUserId, agentSecretAlias }
    }

    return { allowed: true, connector, agentSecretAlias }
  }
}
