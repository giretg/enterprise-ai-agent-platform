'use server'

import { lookup } from 'node:dns/promises'
import { z } from 'zod'
import type { ConnectorType } from '@prisma/client'
import { getAuthContext } from '@/auth/context'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { isSuperadmin } from '@/lib/tenant-policy'
import {
  parseTemplateDescriptor,
  templateDescriptorSchema,
} from '@/domain/connector-template/template-descriptor'
import {
  materializeConnectorConfig,
  selfCheckTemplateDescriptor,
} from '@/domain/connector-template/materializer'
import { materializeGmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import { materializeGoogleDriveConnectorConfig } from '@/domain/connector-template/google-drive-connector-config'
import { connectorConfigSchema } from '@/domain/provisioning/connector-config'
import { tryExtractConnectorConfigFromOpenApiAsync } from '@/domain/provisioning/openapi-config-extractor'
import { SpecSyncService } from '@/domain/connector-self-update/spec-sync'
import { toolsRequiringConnector } from '@/domain/connector-grant/tool-connector-requirements'

function actorOf(user: Awaited<ReturnType<typeof requireTenantRole>>): ProvisioningActor {
  return {
    type: 'user',
    userId: user.user.id,
    role: user.activeTenantRole,
    tenantId: user.activeTenantId,
    canManagePlatformConnectors: isSuperadmin(user.platformRoles),
  }
}

function toFail(e: unknown, fallback: string) {
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

function ensureCustomTemplateActivationHelp(descriptor: { key: string; activationHelp?: string }) {
  if (descriptor.activationHelp?.trim()) return
  throw new ProvisioningError(
    'PROVISIONING_INVALID_INPUT',
    `A custom connector-sablonhoz kötelező activationHelp mező: ${descriptor.key}`,
  )
}

const draftIdSchema = z.object({ draftId: z.string().min(1) })

const createDraftSchema = z.object({
  name: z.string().min(1),
  sourceType: z.enum(['api_doc', 'openapi', 'manual', 'template']),
  sourceRef: z.string().optional(),
  sourceContent: z.string().optional(),
  generatedConfig: connectorConfigSchema,
})

const createFromTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  authMethodKind: z.enum(['api_key', 'bearer', 'basic', 'service_oauth2', 'user_delegated_oauth2']),
  instanceValues: z.record(z.string(), z.string()).default({}),
  secretAliases: z.record(z.string(), z.string()).default({}),
  selectedScopes: z.array(z.string()).optional(),
  selectedEndpoints: z.array(z.string()).optional(),
})

const templateSelfCheckSchema = z.object({
  authMethodKind: z
    .enum(['api_key', 'bearer', 'basic', 'service_oauth2', 'user_delegated_oauth2'])
    .optional(),
  instanceValues: z.record(z.string(), z.string()).optional(),
  secretAliases: z.record(z.string(), z.string()).optional(),
  selectedScopes: z.array(z.string()).optional(),
  selectedEndpoints: z.array(z.string()).optional(),
})

const upsertConnectorTemplateSchema = z.object({
  descriptor: templateDescriptorSchema,
  description: z.string().max(1000).optional(),
  selfCheck: templateSelfCheckSchema.optional(),
  tenantId: z.string().min(1).nullable().optional(),
})

const activateSchema = z.object({
  draftId: z.string().min(1),
  secretAlias: z.string().optional(),
  apiKey: z.string().optional(),
  clientId: z.string().trim().max(300).optional(),
  approverId: z.string().optional(),
  criticality: z.enum(['L1', 'L2', 'L3']).optional(),
  reason: z.string().optional(),
  confirmKeyless: z.boolean().optional(),
  defaultActingUserEmail: z.string().email().optional(),
})

const testWithCredentialsSchema = z.object({
  draftId: z.string().min(1),
  apiKey: z.string().optional(),
  secretAlias: z.string().optional(),
  defaultActingUserEmail: z.string().email().optional(),
})

const fetchApiDocUrlSchema = z.object({
  url: z.string().url().max(2048),
})

export type FetchApiDocFromUrlData = {
  docText: string
  sourceUrl: string
  host: string
  bytes: number
  contentType: string
  truncated: boolean
}

const extendEgressSchema = z.object({
  host: z.string().min(1).max(253),
  sourceType: z.enum(['official', 'vendor_doc']).optional(),
  draftId: z.string().optional(),
})

const updateDraftConfigSchema = z.object({
  draftId: z.string().min(1),
  generatedConfig: connectorConfigSchema,
})

const decommissionSchema = z.object({
  draftId: z.string().min(1),
  criticality: z.enum(['L1', 'L2', 'L3']).optional(),
  approverId: z.string().optional(),
  reason: z.string().max(500).optional(),
})

const decommissionActiveConnectorSchema = z.object({
  connectorId: z.string().min(1),
  criticality: z.enum(['L1', 'L2', 'L3']).optional(),
  approverId: z.string().optional(),
  reason: z.string().max(500).optional(),
})

const deleteDraftSchema = z.object({
  draftId: z.string().min(1),
  reason: z.string().max(500).optional(),
})

const draftFromOpenApiSchema = z.object({
  docText: z.string().min(1),
  providerHint: z.string().optional(),
})

async function syncAssignedConnectorCapabilities(
  agentId: string,
  connectorId: string,
  accessMode: 'read' | 'write',
  connectorType: 'http_api' | 'gmail' | 'google_drive',
) {
  const readTools = toolsRequiringConnector(connectorType, 'read')
  const writeTools = toolsRequiringConnector(connectorType, 'write')
  for (const toolName of readTools) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
  if (accessMode === 'write') {
    for (const toolName of writeTools) {
      await prisma.capability.upsert({
        where: { agentId_toolName: { agentId, toolName } },
        create: { agentId, toolName, allowed: true },
        update: { allowed: true },
      })
    }
    return
  }
  const writeConnectorCount = await prisma.agentConnector.count({
    where: {
      agentId,
      connectorId: { not: connectorId },
      accessMode: 'write',
      connector: { type: connectorType, lifecycleState: 'active' },
    },
  })
  if (writeConnectorCount === 0 && writeTools.length > 0) {
    await prisma.capability.updateMany({
      where: { agentId, toolName: { in: writeTools } },
      data: { allowed: false },
    })
  }
}

async function syncConnectorRemovalCapabilities(agentIds: string[]) {
  for (const agentId of agentIds) {
    for (const type of ['http_api', 'gmail', 'google_drive'] as const) {
      const readTools = toolsRequiringConnector(type, 'read')
      const writeTools = toolsRequiringConnector(type, 'write')
      const [anyActive, writeActive] = await Promise.all([
        prisma.agentConnector.count({
          where: { agentId, connector: { type, lifecycleState: 'active' } },
        }),
        prisma.agentConnector.count({
          where: { agentId, accessMode: 'write', connector: { type, lifecycleState: 'active' } },
        }),
      ])
      if (anyActive === 0 && readTools.length + writeTools.length > 0) {
        await prisma.capability.updateMany({
          where: { agentId, toolName: { in: [...readTools, ...writeTools] } },
          data: { allowed: false },
        })
      } else if (writeActive === 0 && writeTools.length > 0) {
        await prisma.capability.updateMany({
          where: { agentId, toolName: { in: writeTools } },
          data: { allowed: false },
        })
      }
    }
  }
}

export async function listConnectorCatalog() {
  try {
    const user = await requireTenantRole('viewer')
    const catalog = await services.provisioning.listCatalog(actorOf(user))
    return ok(catalog)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a connector-katalógust')
  }
}

export async function listProvisioningDrafts() {
  try {
    const user = await requireTenantRole('viewer')
    const drafts = await services.provisioning.listDrafts(actorOf(user))
    return ok(drafts)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a draftokat')
  }
}

export async function listConnectorTemplatesAction() {
  try {
    const user = await requireTenantRole('viewer')
    const templates = await repositories.connectorTemplates.listVisible({
      tenantId: user.activeTenantId,
    })
    return ok(
      templates.map((template) => ({
        id: template.id,
        key: template.key,
        version: template.version,
        origin: template.origin,
        displayName: template.displayName,
        description: template.description,
        tenantId: template.tenantId,
        status: template.status,
        descriptor: parseTemplateDescriptor(template.descriptor),
      })),
    )
  } catch (e) {
    return toFail(e, 'Nem sikerült lekérni a connector-sablonokat')
  }
}

export async function createConnectorFromTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createFromTemplateSchema.parse(input)
    const template = await repositories.connectorTemplates.findByIdVersion(parsed.templateId)
    if (!template || (template.tenantId !== null && template.tenantId !== user.activeTenantId)) {
      return fail('A sablon nem található.')
    }
    if (template.status !== 'active') {
      return fail('Csak aktív sablonból hozható létre konnektor.')
    }

    const descriptor = parseTemplateDescriptor(template.descriptor)
    const connectorType = (descriptor.connectorType ?? 'http_api') as ConnectorType
    const provenance = {
      templateId: template.id,
      templateKey: template.key,
      templateVersion: template.version,
      templateOrigin: template.origin,
    }
    const materializeInput = {
      authMethodKind: parsed.authMethodKind,
      instanceValues: parsed.instanceValues,
      selectedScopes: parsed.selectedScopes,
      selectedEndpoints: parsed.selectedEndpoints,
    }
    const generatedConfig =
      connectorType === 'gmail'
        ? materializeGmailConnectorConfig(descriptor, materializeInput, parsed.secretAliases, provenance)
        : connectorType === 'google_drive'
          ? materializeGoogleDriveConnectorConfig(
              descriptor,
              materializeInput,
              parsed.secretAliases,
              provenance,
            )
          : materializeConnectorConfig(descriptor, materializeInput, parsed.secretAliases, provenance)

    const res = await services.provisioning.createConnectorDraft(
      {
        name: parsed.name,
        sourceType: 'template',
        sourceRef: `${template.key}@${template.version}`,
        sourceContent: JSON.stringify(template.descriptor),
        generatedConfig,
        connectorType,
      },
      actorOf(user),
    )
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'connector.materialize',
      targetType: 'connector',
      targetId: res.connectorId,
      modelUsed: null,
      inputRef: template.id,
      outputRef: res.draftId,
      policyDecision: 'allowed',
      metadata: {
        templateKey: template.key,
        templateVersion: template.version,
        templateOrigin: template.origin,
      },
      tenantId: user.activeTenantId,
    })
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült sablonból connectort létrehozni')
  }
}

export async function createConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createDraftSchema.parse(input)
    const res = await services.provisioning.createConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a draftot')
  }
}

/** Determinisztikus OpenAPI → config. LLM-es doksi-értelmezés később MCP/skill úton. */
export async function draftConfigFromOpenApi(input: unknown) {
  try {
    await requireTenantRole('admin')
    const parsed = draftFromOpenApiSchema.parse(input)
    const result = await tryExtractConnectorConfigFromOpenApiAsync(
      parsed.docText,
      parsed.providerHint,
    )
    if (!result.ok) {
      return fail(
        'Most csak OpenAPI (JSON/YAML) specifikációból lehet configot kinyerni. Szabad szöveges doksiból később skill/MCP úton.',
      )
    }
    return ok({
      config: result.config,
      requiresSensitivityReview: false,
      extractionMethod: 'openapi' as const,
    })
  } catch (e) {
    return toFail(e, 'Nem sikerült kinyerni a configot az OpenAPI-ból')
  }
}

export async function draftConfigFromApiDoc(input: unknown) {
  return draftConfigFromOpenApi(input)
}

export async function fetchApiDocFromUrl(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { url } = fetchApiDocUrlSchema.parse(input)
    const service = new SpecSyncService({
      resolveHostIps: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
    })
    const downloaded = await service.downloadRawSpec(url)
    if (!downloaded.ok) {
      await repositories.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: null,
        action: 'provisioning.doc.fetch.blocked',
        targetType: 'provisioning_doc_fetch',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'blocked',
        metadata: { reason: downloaded.reason, detail: downloaded.detail },
        tenantId: user.activeTenantId,
      })
      return fail('Nem sikerült letölteni az OpenAPI-leírást erről a linkről.')
    }
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'provisioning.doc.fetch',
      targetType: 'provisioning_doc_fetch',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
        policyDecision: 'allowed',
        metadata: { host: downloaded.host, bytes: downloaded.text.length },
        tenantId: user.activeTenantId,
      })
    return ok({
      docText: downloaded.text,
      sourceUrl: url,
      host: downloaded.host,
      bytes: downloaded.text.length,
      contentType: 'application/json',
      truncated: false,
    } satisfies FetchApiDocFromUrlData)
  } catch (e) {
    return toFail(e, 'Nem sikerült letölteni az API-doksit az URL-ről')
  }
}

export async function extendEgressAllowlist(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { host, sourceType, draftId } = extendEgressSchema.parse(input)
    const res = await services.platformSettings.extendEgressAllowlist(
      user.activeTenantId,
      host,
      user.user.id,
      { sourceType, draftId },
    )
    if (!res.ok) {
      return fail(
        res.reason === 'forbidden_host'
          ? 'A host tiltott (privát IP / localhost / metadata) — nem adható az allowlisthez.'
          : 'Érvénytelen host.',
      )
    }
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'connector.egress_allowlist.extend',
      targetType: 'provisioning_egress',
      targetId: draftId ?? null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { host: res.host, added: res.added },
      tenantId: user.activeTenantId,
    })
    return ok({ added: res.added, host: res.host, hosts: res.hosts })
  } catch (e) {
    return toFail(e, 'Nem sikerült bővíteni az egress-allowlistet')
  }
}

export async function validateConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.validateConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült validálni a draftot')
  }
}

export async function testConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.testConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült lefuttatni a sandbox-tesztet')
  }
}

export async function testConnectorDraftWithCredentials(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = testWithCredentialsSchema.parse(input)
    const res = await services.provisioning.testConnectorDraftWithCredentials(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült lefuttatni a kulcsos tesztet')
  }
}

export async function reviewConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        draftId: z.string().min(1),
        decision: z.enum(['approve', 'changes_requested', 'reject']),
        note: z.string().optional(),
      })
      .parse(input)
    const res = await services.provisioning.reviewConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült rögzíteni a review-döntést')
  }
}

export async function activateConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = activateSchema.parse(input)
    const res = await services.provisioning.activateConnector(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült aktiválni a connectort')
  }
}

/** Validate → sandbox test → approve → activate. One admin button. */
export async function activateConnectorDraftPipeline(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = activateSchema.parse(input)
    const actor = actorOf(user)
    await services.provisioning.validateConnectorDraft({ draftId: parsed.draftId }, actor)
    const tested = await services.provisioning.testConnectorDraft({ draftId: parsed.draftId }, actor)
    if (!tested.ok) {
      return fail(tested.detail ? `SANDBOX_TEST_FAILED: ${tested.detail}` : 'A sandbox-teszt nem sikerült')
    }
    await services.provisioning.reviewConnectorDraft(
      { draftId: parsed.draftId, decision: 'approve' },
      actor,
    )
    const res = await services.provisioning.activateConnector(parsed, actor)
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült aktiválni a connectort')
  }
}

export async function listProvisioningAssignableAgents() {
  try {
    const user = await requireTenantRole('viewer')
    const agents = await repositories.agents.findMany({ tenantId: user.activeTenantId })
    return ok(
      agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name })),
    )
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az agenteket')
  }
}

export async function assignConnectorToAgent(input: {
  connectorId: string
  agentId: string
  accessMode?: 'read' | 'write'
  apiKey?: string
  reason?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        connectorId: z.string().min(1),
        agentId: z.string().min(1),
        accessMode: z.enum(['read', 'write']).default('read'),
        apiKey: z.string().optional(),
      })
      .parse(input)
    const connector = await prisma.connector.findFirst({
      where: { id: parsed.connectorId, tenantId: user.activeTenantId, lifecycleState: 'active' },
    })
    if (!connector) return fail('Csak aktivált, tenanton belüli kapcsolat rendelhető agenthez.')
    await services.provisioning.assignConnectorToAgent(parsed, actorOf(user))
    if (connector.type === 'http_api' || connector.type === 'gmail' || connector.type === 'google_drive') {
      await syncAssignedConnectorCapabilities(
        parsed.agentId,
        parsed.connectorId,
        parsed.accessMode,
        connector.type,
      )
    }
    return ok({ assigned: true })
  } catch (e) {
    return toFail(e, 'A konnektor hozzárendelése nem sikerült')
  }
}

export async function unassignConnectorFromAgent(input: {
  connectorId: string
  agentId: string
  reason?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        connectorId: z.string().min(1),
        agentId: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
      .parse(input)
    const connector = await prisma.connector.findFirst({
      where: { id: parsed.connectorId, tenantId: user.activeTenantId },
    })
    await services.provisioning.unassignConnectorFromAgent(parsed, actorOf(user))
    if (
      connector &&
      (connector.type === 'http_api' || connector.type === 'gmail' || connector.type === 'google_drive')
    ) {
      await syncConnectorRemovalCapabilities([parsed.agentId])
    }
    return ok({ unassigned: true })
  } catch (e) {
    return toFail(e, 'A konnektor leválasztása nem sikerült')
  }
}

export async function updateConnectorDraftConfig(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateDraftConfigSchema.parse(input)
    const res = await services.provisioning.updateConnectorDraftConfig(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült frissíteni a draft configját')
  }
}

export async function reopenConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.reopenConnector(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült visszanyitni a connectort')
  }
}

export async function decommissionConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = decommissionSchema.parse(input)
    const res = await services.provisioning.decommissionConnector(parsed, actorOf(user))
    if (res.affectedAgentIds.length > 0) {
      await syncConnectorRemovalCapabilities(res.affectedAgentIds)
    }
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült megszüntetni a connectort')
  }
}

export async function decommissionActiveConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = decommissionActiveConnectorSchema.parse(input)
    const res = await services.provisioning.decommissionActiveConnector(parsed, actorOf(user))
    if (res.affectedAgentIds.length > 0) {
      await syncConnectorRemovalCapabilities(res.affectedAgentIds)
    }
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült megszüntetni a connectort')
  }
}

export async function deleteConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = deleteDraftSchema.parse(input)
    const res = await services.provisioning.deleteConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült törölni a draftot')
  }
}

export async function deleteArchivedConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = decommissionActiveConnectorSchema.parse(input)
    const res = await services.provisioning.deleteArchivedConnector(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült törölni a konnektort')
  }
}

export async function upsertConnectorTemplateAction(input: unknown) {
  try {
    const parsed = upsertConnectorTemplateSchema.parse(input)
    const descriptor = parseTemplateDescriptor(parsed.descriptor)
    ensureCustomTemplateActivationHelp(descriptor)
    selfCheckTemplateDescriptor(descriptor, parsed.selfCheck)

    const ctx = await getAuthContext()
    let actorId: string
    let tenantId: string | null
    if (ctx && isSuperadmin(ctx.platformRoles)) {
      actorId = ctx.user.id
      tenantId = parsed.tenantId ?? null
    } else {
      const user = await requireTenantRole('admin')
      actorId = user.user.id
      tenantId = user.activeTenantId
    }

    const latest = await repositories.connectorTemplates.findLatestByKey(descriptor.key, tenantId)
    if (latest?.origin === 'builtin') {
      return fail('Builtin connector-sablon nem írható felül. Klónozd másik kulccsal.')
    }
    const version = latest ? latest.version + 1 : 1
    const template = await repositories.connectorTemplates.createVersion({
      key: descriptor.key,
      version,
      origin: 'custom',
      displayName: descriptor.displayName,
      description: parsed.description ?? descriptor.description ?? null,
      tenantId,
      descriptor,
      status: 'active',
      createdById: actorId,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'connector.template.create',
      targetType: 'connector_template',
      targetId: template.id,
      modelUsed: null,
      inputRef: descriptor.key,
      outputRef: `${descriptor.key}@${version}`,
      policyDecision: 'allowed',
      metadata: {
        tenant_id: tenantId,
        templateKey: descriptor.key,
        templateVersion: version,
        origin: 'custom',
      },
      tenantId,
    })

    return ok({
      id: template.id,
      key: template.key,
      version: template.version,
      origin: template.origin,
      displayName: template.displayName,
      description: template.description,
      tenantId: template.tenantId,
      status: template.status,
      descriptor: parseTemplateDescriptor(template.descriptor),
    })
  } catch (e) {
    return toFail(e, 'Nem sikerült menteni a connector-sablont')
  }
}

export async function deprecateConnectorTemplateAction(input: unknown) {
  try {
    const parsed = z.object({ templateId: z.string().min(1) }).parse(input)
    const template = await repositories.connectorTemplates.findByIdVersion(parsed.templateId)
    if (!template) return fail('A sablon nem található.')
    if (template.origin === 'builtin') {
      return fail('Builtin connector-sablon nem deprecated-elhető.')
    }
    const ctx = await getAuthContext()
    if (!(ctx && isSuperadmin(ctx.platformRoles)) && template.tenantId) {
      const user = await requireTenantRole('admin')
      if (template.tenantId !== user.activeTenantId) return fail('A sablon nem található.')
    } else if (!(ctx && isSuperadmin(ctx.platformRoles))) {
      await requireTenantRole('admin')
    }
    await repositories.connectorTemplates.deprecate(template.id)
    await repositories.audit.append({
      actorType: 'human',
      actorId: ctx?.user.id ?? null,
      agentVersion: null,
      action: 'connector.template.deprecate',
      targetType: 'connector_template',
      targetId: template.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { templateKey: template.key, templateVersion: template.version },
      tenantId: template.tenantId,
    })
    return ok({ deprecated: true })
  } catch (e) {
    return toFail(e, 'Nem sikerült deprecated-elni a sablont')
  }
}
