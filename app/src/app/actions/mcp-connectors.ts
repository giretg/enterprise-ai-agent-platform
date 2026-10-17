'use server'

/**
 * MCP-connector admin-folyamat (#395 §6): szerver megadása → ellenőrzés →
 * eszközök besorolása és jóváhagyása → kipróbálás. Agenthez rendelés a meglévő
 * agent–connector képernyőn. A belépési adat sosem kerül a kliensre.
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import {
  buildConnectorSecretRef,
  deleteConnectorApiKey,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'
import { guardedMcpFetch, mcpListTools, McpClientError, type McpRemoteTool } from '@/domain/connector/mcp-client'
import {
  applyMcpToolDecisions,
  diffMcpTools,
  isWriteLikeToolName,
  MCP_SPEC_FORMAT,
  MCP_TOOL_RISKS,
  mcpResultForModel,
  mcpServerHost,
  mcpToolsHash,
  normalizeMcpTools,
  parseMcpCapabilitySet,
  parseMcpConnectorConfig,
  type McpCapabilitySet,
  type McpConnectorConfig,
  type McpToolEntry,
} from '@/domain/connector/mcp-tools'
import { executeMcpTool } from '@/domain/enterprise-tools/handlers/mcp'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { appendAuditInTransaction } from '@/repositories/postgres/audit-repository'

const httpsUrl = z
  .string()
  .trim()
  .url('Adj meg egy teljes címet, pl. https://mcp.example.com/mcp')
  .refine((value) => new URL(value).protocol === 'https:', 'Csak https cím használható.')

const createSchema = z.object({
  name: z.string().trim().min(1, 'Adj nevet a kapcsolatnak.').max(120),
  serverUrl: httpsUrl,
  authMode: z.enum(['service', 'user_delegated']),
  token: z.string().trim().max(10_000).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().trim().max(10_000).optional(),
  scopes: z.string().trim().max(2_000).optional(),
})
const connectorIdSchema = z.object({ connectorId: z.string().uuid() })
const approveSchema = connectorIdSchema.extend({
  versionId: z.string().uuid(),
  decisions: z
    .object({ name: z.string().min(1).max(200), risk: z.enum(MCP_TOOL_RISKS), approved: z.boolean() })
    .array()
    .max(1000),
  confirmReadDowngrade: z.boolean().optional(),
})
const trySchema = connectorIdSchema.extend({
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
})
/** A capability-set `inputSchema`-ja `unknown` — JSON-ként tároljuk. */
const asJson = (value: unknown) => value as Prisma.InputJsonValue

const hostSchema = z.object({ host: z.string().trim().min(1).max(253), allowed: z.boolean() })

/** Emberi nyelvű hibák (§6) — a nyers kód a felhasználónak nem mond semmit. */
function humanMcpError(error: unknown): string {
  if (error instanceof McpClientError) {
    if (error.code === 'egress_blocked') {
      if (error.detail === 'egress_not_allowlisted' || error.detail === 'mcp_domain_not_allowed') {
        return 'Ezt a szolgáltatót még nem engedélyezte a platform-adminisztrátor.'
      }
      if (error.detail === 'scheme_blocked') return 'Csak https cím használható.'
      return 'Ez a cím belső hálózatra mutat, ezért nem engedélyezett.'
    }
    if (error.code === 'unauthorized') return 'A szerver nem fogadta el a belépést — ellenőrizd a tokent vagy a fiókot.'
    if (error.code === 'too_large') return 'A szerver válasza túl nagy.'
    if (error.code === 'redirect_blocked') return 'A szerver másik címre irányít át — add meg a végleges címet.'
    return 'A cím nem érhető el, vagy nem MCP-szerver.'
  }
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Hibás adat.'
  return error instanceof Error ? error.message : 'Ismeretlen hiba.'
}

async function allowedHostsOrFail(serverUrl: string): Promise<{ hosts: string[]; host: string }> {
  const hosts = await services.platformSettings.getMcpAllowedHosts()
  const host = new URL(serverUrl).hostname.toLowerCase()
  if (!hosts.includes(host)) throw new McpClientError('egress_blocked', 'mcp_domain_not_allowed')
  return { hosts, host }
}

type ConnectorRow = NonNullable<Awaited<ReturnType<typeof loadConnector>>>

async function loadConnector(connectorId: string, tenantId: string) {
  return prisma.connector.findFirst({
    where: { id: connectorId, tenantId, type: 'mcp' },
    include: {
      specSource: true,
      activeSpecVersion: true,
      specVersions: { orderBy: { versionNo: 'desc' }, take: 1 },
    },
  })
}

/**
 * A hívó tokenje az ellenőrzéshez: közös fióknál a titoktár, saját fiókos módban
 * az admin SAJÁT grantje (§6/1) — közös fiókra sosem esik vissza (D5).
 */
async function adminAccessToken(connector: ConnectorRow, userId: string): Promise<string | undefined> {
  if (connector.authMode !== 'user_delegated') return undefined
  const grant = await repositories.connectorGrants.findActiveGrant({
    tenantId: connector.tenantId,
    connectorId: connector.id,
    userId,
  })
  if (!grant) throw new Error('Saját fiókos módban előbb lépj be a saját fiókoddal („Belépés” gomb).')
  return services.connectorGrants.resolveAccessToken({
    connector,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
    actingUserId: userId,
    tenantId: connector.tenantId,
  })
}

async function fetchRemoteTools(connector: ConnectorRow, userId: string): Promise<McpRemoteTool[]> {
  const config = parseMcpConnectorConfig(connector.config)
  if (!config) throw new Error('A kapcsolat címe hibás.')
  const { host } = await allowedHostsOrFail(config.serverUrl)
  const accessToken =
    connector.authMode === 'user_delegated'
      ? await adminAccessToken(connector, userId)
      : connector.secretAlias
        ? await (await import('@/domain/connector/connector-secret-store')).loadConnectorApiKeyByRef(connector.secretAlias)
        : undefined
  return mcpListTools({ serverUrl: config.serverUrl, allowedHosts: [host], accessToken })
}

/**
 * D5: az authorization server felderítése (RFC 9728 → RFC 8414) az egress-őr mögött;
 * a metadata-ban szereplő minden hostnak az MCP-allowlistben kell lennie (D10).
 */
async function discoverMcpOAuth(
  serverUrl: string,
  allowedHosts: string[],
  input: { clientId: string; scopes: string[] },
): Promise<NonNullable<McpConnectorConfig['oauth']>> {
  const info = await discoverOAuthServerInfo(serverUrl, {
    fetchFn: guardedMcpFetch({ serverUrl, allowedHosts }),
  })
  const metadata = info.authorizationServerMetadata
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('A szerver nem ad meg bejelentkezési címet (OAuth) — használd a közös céges fiókos módot.')
  }
  for (const url of [metadata.authorization_endpoint, metadata.token_endpoint]) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname.toLowerCase())) {
      throw new Error(
        `A bejelentkezés a(z) ${parsed.hostname} címen történik, amit a platform-adminisztrátor még nem engedélyezett.`,
      )
    }
  }
  const scopes =
    input.scopes.length > 0 ? input.scopes : (info.resourceMetadata?.scopes_supported ?? []).slice(0, 50)
  return {
    authUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    scopes,
    clientId: input.clientId,
    // MCP auth-spec: a token csak erre a szerverre szóljon (RFC 8707).
    resource: serverUrl,
  }
}

function toolView(tool: McpToolEntry) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    approved: tool.approved,
    suggestedRisk: tool.suggestedRisk,
    writeLikeName: isWriteLikeToolName(tool.name),
  }
}

export async function listMcpConnectors() {
  try {
    const ctx = await requireTenantRole('operator')
    const [rows, allowedHosts] = await Promise.all([
      prisma.connector.findMany({
        where: { tenantId: ctx.activeTenantId, type: 'mcp', lifecycleState: { not: 'archived' } },
        include: {
          activeSpecVersion: true,
          specVersions: { where: { status: 'proposed' }, orderBy: { versionNo: 'desc' }, take: 1 },
          grants: { where: { userId: ctx.user.id, status: 'active' }, select: { id: true } },
          agentConnectors: { select: { agent: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      services.platformSettings.getMcpAllowedHosts(),
    ])
    return ok({
      allowedHosts,
      connectors: rows.map((row) => {
        const config = parseMcpConnectorConfig(row.config)
        const active = parseMcpCapabilitySet(row.activeSpecVersion?.capabilitySet)
        const proposedRow = row.specVersions[0]
        const proposed = proposedRow ? parseMcpCapabilitySet(proposedRow.capabilitySet) : null
        return {
          id: row.id,
          name: row.name,
          serverUrl: config?.serverUrl ?? '',
          authMode: row.authMode,
          domainAllowed: config ? allowedHosts.includes(mcpServerHost(config)) : false,
          hasOwnGrant: row.grants.length > 0,
          usedByAgents: row.agentConnectors.map((link) => link.agent.name),
          active: active
            ? { versionId: row.activeSpecVersionId, tools: active.tools.map(toolView) }
            : null,
          proposed:
            proposedRow && proposed
              ? {
                  versionId: proposedRow.id,
                  versionNo: proposedRow.versionNo,
                  tools: proposed.tools.map(toolView),
                  diff: (proposedRow.diffSummary as ReturnType<typeof diffMcpTools> | null) ?? null,
                }
              : null,
        }
      }),
    })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

export async function createMcpConnector(input: unknown) {
  let connectorId: string | null = null
  let savedSecret = false
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = createSchema.parse(input)
    const { hosts, host } = await allowedHostsOrFail(parsed.serverUrl)
    connectorId = randomUUID()

    let config: McpConnectorConfig = { serverUrl: parsed.serverUrl }
    let tools: McpRemoteTool[] | null = null
    let secret: string | null = null
    if (parsed.authMode === 'service') {
      secret = parsed.token || null
      // „Ellenőrzés”: initialize + tools/list a megadott tokennel.
      tools = await mcpListTools({ serverUrl: parsed.serverUrl, allowedHosts: [host], accessToken: secret ?? undefined })
    } else {
      if (!parsed.clientId) {
        throw new Error('Saját fiókos módhoz add meg a szolgáltatónál regisztrált alkalmazás azonosítóját (client ID).')
      }
      secret = parsed.clientSecret || null
      const scopes = (parsed.scopes ?? '').split(/[\s,]+/).filter(Boolean)
      config = { ...config, oauth: await discoverMcpOAuth(parsed.serverUrl, hosts, { clientId: parsed.clientId, scopes }) }
    }
    if (secret) {
      await saveConnectorApiKey(connectorId, secret)
      savedSecret = true
    }
    const capabilitySet: McpCapabilitySet | null = tools
      ? { format: MCP_SPEC_FORMAT, tools: normalizeMcpTools(tools) }
      : null
    const id = connectorId
    await prisma.$transaction(async (tx) => {
      await tx.connector.create({
        data: {
          id,
          type: 'mcp',
          name: parsed.name,
          authMode: parsed.authMode,
          scope: 'single',
          secretAlias: secret ? buildConnectorSecretRef(id) : null,
          config,
          lifecycleState: 'active',
          tenantId: ctx.activeTenantId,
        },
      })
      await tx.connectorSpecSource.create({
        data: {
          tenantId: ctx.activeTenantId,
          connectorId: id,
          specUrl: parsed.serverUrl,
          specFormat: MCP_SPEC_FORMAT,
          urlApprovedById: ctx.user.id,
          urlApprovedAt: new Date(),
          createdById: ctx.user.id,
          ...(tools ? { lastSyncedAt: new Date() } : {}),
        },
      })
      if (tools && capabilitySet) {
        await tx.connectorSpecVersion.create({
          data: {
            tenantId: ctx.activeTenantId,
            connectorId: id,
            versionNo: 1,
            rawSnapshot: tools as object[],
            rawHash: mcpToolsHash(tools),
            capabilitySet: asJson(capabilitySet),
            status: 'proposed',
          },
        })
      }
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'mcp.connector.create',
        targetType: 'connector',
        targetId: id,
        modelUsed: null,
        inputRef: host,
        outputRef: null,
        policyDecision: 'allowed',
        metadata: { connectorId: id, host, authMode: parsed.authMode, toolCount: tools?.length ?? 0 },
        tenantId: ctx.activeTenantId,
      })
    })
    return ok({ connectorId: id, toolCount: tools?.length ?? null })
  } catch (error) {
    if (connectorId && savedSecret) await deleteConnectorApiKey(connectorId).catch(() => {})
    return fail(humanMcpError(error))
  }
}

/** Újraellenőrzés: eltérő `tools/list` → új `proposed` verzió (D4); a régi aktív él tovább. */
export async function syncMcpConnector(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const { connectorId } = connectorIdSchema.parse(input)
    const connector = await loadConnector(connectorId, ctx.activeTenantId)
    if (!connector) return fail('A kapcsolat nem található.')
    const tools = await fetchRemoteTools(connector, ctx.user.id)
    const rawHash = mcpToolsHash(tools)
    const latest = connector.specVersions[0]
    if (latest && latest.rawHash === rawHash) {
      await repositories.audit.append({
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'mcp.tools.sync.no_change',
        targetType: 'connector',
        targetId: connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: null,
        metadata: { connectorId, toolCount: tools.length },
        tenantId: ctx.activeTenantId,
      })
      return ok({ changed: false, toolCount: tools.length })
    }
    const activeTools = parseMcpCapabilitySet(connector.activeSpecVersion?.capabilitySet)?.tools ?? []
    const next = normalizeMcpTools(tools, activeTools)
    const diff = diffMcpTools(activeTools, next)
    await prisma.$transaction(async (tx) => {
      // Egyszerre egy javaslat: a régebbi, még el nem bírált javaslat elavul.
      await tx.connectorSpecVersion.updateMany({
        where: { connectorId, status: 'proposed' },
        data: { status: 'superseded' },
      })
      await tx.connectorSpecVersion.create({
        data: {
          tenantId: ctx.activeTenantId,
          connectorId,
          versionNo: (latest?.versionNo ?? 0) + 1,
          rawSnapshot: tools as object[],
          rawHash,
          capabilitySet: asJson({ format: MCP_SPEC_FORMAT, tools: next }),
          status: 'proposed',
          diffFromVersionId: connector.activeSpecVersionId,
          diffSummary: diff,
        },
      })
      await tx.connectorSpecSource.update({ where: { connectorId }, data: { lastSyncedAt: new Date() } })
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'mcp.tools.sync.proposed',
        targetType: 'connector',
        targetId: connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: rawHash,
        policyDecision: null,
        metadata: {
          connectorId,
          added: diff.added.length,
          removed: diff.removed.length,
          schemaChanged: diff.schemaChanged.length,
          descriptionChanged: diff.descriptionChanged.length,
        },
        tenantId: ctx.activeTenantId,
      })
    })
    return ok({ changed: true, toolCount: tools.length, diff })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

/**
 * Eszközök besorolása és jóváhagyása (D2). Javasolt verzió → aktív lesz; az aktív
 * verzión a besorolás helyben módosítható. Írásra utaló név `read`-re sorolása
 * külön megerősítést kér, és auditálódik.
 */
export async function approveMcpTools(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = approveSchema.parse(input)
    const connector = await loadConnector(parsed.connectorId, ctx.activeTenantId)
    if (!connector) return fail('A kapcsolat nem található.')
    const version = await prisma.connectorSpecVersion.findFirst({
      where: { id: parsed.versionId, connectorId: connector.id },
    })
    const set = version ? parseMcpCapabilitySet(version.capabilitySet) : null
    if (!version || !set) return fail('A verzió nem található.')
    const isActive = connector.activeSpecVersionId === version.id
    if (!isActive && version.status !== 'proposed') return fail('Ez a verzió már nem hagyható jóvá.')
    const tools = applyMcpToolDecisions(set.tools, parsed.decisions)
    const downgraded = tools.filter((tool) => tool.approved && tool.risk === 'read' && isWriteLikeToolName(tool.name))
    if (downgraded.length > 0 && !parsed.confirmReadDowngrade) {
      return fail(
        `Írásra utaló nevű eszközt soroltál olvasónak (${downgraded.map((tool) => tool.name).join(', ')}). Ezek jóváhagyás nélkül futnak — erősítsd meg, ha biztos vagy benne.`,
      )
    }
    await prisma.$transaction(async (tx) => {
      if (!isActive && connector.activeSpecVersionId) {
        await tx.connectorSpecVersion.update({
          where: { id: connector.activeSpecVersionId },
          data: { status: 'superseded' },
        })
      }
      await tx.connectorSpecVersion.update({
        where: { id: version.id },
        data: {
          capabilitySet: asJson({ format: MCP_SPEC_FORMAT, tools }),
          status: 'approved',
          approvedById: ctx.user.id,
          approvedAt: new Date(),
        },
      })
      if (!isActive) {
        await tx.connector.update({ where: { id: connector.id }, data: { activeSpecVersionId: version.id } })
      }
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'mcp.tools.approve',
        targetType: 'connector',
        targetId: connector.id,
        modelUsed: null,
        inputRef: version.id,
        outputRef: null,
        policyDecision: 'allowed',
        metadata: {
          connectorId: connector.id,
          versionNo: version.versionNo,
          approvedTools: tools.filter((tool) => tool.approved).map((tool) => `${tool.name}:${tool.risk}`),
          readDowngradeConfirmed: downgraded.map((tool) => tool.name),
        },
        tenantId: ctx.activeTenantId,
      })
    })
    return ok({ approved: tools.filter((tool) => tool.approved).length })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

/** §6/3: egy olvasónak javasolt/besorolt eszköz valódi futtatása, mielőtt agent hozzáférne. */
export async function tryMcpTool(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = trySchema.parse(input)
    const connector = await loadConnector(parsed.connectorId, ctx.activeTenantId)
    if (!connector) return fail('A kapcsolat nem található.')
    const latest = parseMcpCapabilitySet(connector.specVersions[0]?.capabilitySet)
    const tool = latest?.tools.find((entry) => entry.name === parsed.tool)
    if (!tool) return fail('Ez az eszköz nem szerepel a szerver listájában.')
    if (tool.suggestedRisk !== 'read' && !(tool.approved && tool.risk === 'read')) {
      return fail('Kipróbálni csak olvasó eszközt lehet — ez módosíthat adatot.')
    }
    const config = parseMcpConnectorConfig(connector.config)
    if (!config) return fail('A kapcsolat címe hibás.')
    const { hosts } = await allowedHostsOrFail(config.serverUrl)
    const result = await executeMcpTool({
      connector,
      accessToken: await adminAccessToken(connector, ctx.user.id),
      tool: tool.name,
      arguments: parsed.arguments ?? {},
      allowedHosts: hosts,
    })
    await repositories.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'mcp.tool.try',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: tool.name,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { connectorId: connector.id, mcpTool: tool.name, isError: Boolean(result.isError) },
      tenantId: ctx.activeTenantId,
    })
    return ok(mcpResultForModel(result))
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

export async function archiveMcpConnector(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const { connectorId } = connectorIdSchema.parse(input)
    const connector = await loadConnector(connectorId, ctx.activeTenantId)
    if (!connector) return fail('A kapcsolat nem található.')
    await prisma.$transaction(async (tx) => {
      await tx.connector.update({ where: { id: connectorId }, data: { lifecycleState: 'archived' } })
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'mcp.connector.archive',
        targetType: 'connector',
        targetId: connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'allowed',
        metadata: { connectorId },
        tenantId: ctx.activeTenantId,
      })
    })
    return ok({ archived: true })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

// ── D8: platform-admin MCP-domain allowlist ─────────────────────────────────

export async function getMcpAllowedHosts() {
  try {
    await requirePlatformRole('platform_operator')
    return ok({ hosts: await services.platformSettings.getMcpAllowedHosts() })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}

export async function setMcpHostAllowed(input: unknown) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = hostSchema.parse(input)
    const result = await services.platformSettings.setMcpHostAllowed(parsed.host, parsed.allowed, ctx.user.id)
    if (!result.ok) {
      return fail(
        result.reason === 'forbidden_host'
          ? 'Ez a cím belső hálózatra vagy tiltott szolgáltatásra mutat.'
          : 'Adj meg egy domaint, pl. mcp.example.com (csillag nélkül).',
      )
    }
    await repositories.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: parsed.allowed ? 'platform.mcp_host.allow' : 'platform.mcp_host.revoke',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: result.host,
      outputRef: null,
      policyDecision: parsed.allowed ? 'allowed' : 'denied',
      metadata: { host: result.host },
      tenantId: null,
    })
    return ok({ hosts: result.hosts })
  } catch (error) {
    return fail(humanMcpError(error))
  }
}
