'use server'

import { z } from 'zod'
import { requireRole } from '@/auth'
import type { ActiveAuthUser } from '@/auth/types'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { PROVISIONING_ASSISTANT_TEMPLATE } from '@/domain/provisioning/provisioning-assistant'
import { inspectPromptSensitivity } from '@/domain/gateway/sensitivity-router'

/**
 * Server actions a Provisioning Assistant (Connector Onboarding) admin-felülethez
 * (Feature-spec — Provisioning-Assistant §8, F2-P-C). A privilegizált aktusok
 * (review/test/activate/assign) emberi `admin`-t követelnek — a kemény padlót a
 * ProvisioningService is kikényszeríti (CR-MVP-002).
 */

function actorOf(user: ActiveAuthUser): ProvisioningActor {
  return { type: 'user', userId: user.id, role: user.role, tenantId: user.tenantId }
}

/** A ProvisioningError üzenetét ügyfél-barát formában visszaadjuk (kód + üzenet). */
function toFail(e: unknown, fallback: string) {
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

const proposedToolSchema = z.object({
  name: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  access: z.enum(['read', 'write']),
  description: z.string().optional(),
})

const connectorConfigSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().url(),
  egressHosts: z.array(z.string().min(1)).min(1),
  authMode: z.enum(['service', 'user_delegated', 'agent_owned']),
  auth: z.object({
    type: z.enum(['api_key_header', 'bearer_token', 'basic', 'oauth2']),
    headerName: z.string().optional(),
    secretAliasSuggested: z.string().optional(),
  }),
  scopesSuggested: z.array(z.string()).default([]),
  rateLimit: z.object({ rps: z.number().nonnegative(), burst: z.number().nonnegative() }).optional(),
  proposedTools: z.array(proposedToolSchema).default([]),
  provenance: z
    .object({ sourceHash: z.string().optional(), extractedAt: z.string().optional() })
    .optional(),
})

const createDraftSchema = z.object({
  name: z.string().min(1),
  sourceType: z.enum(['api_doc', 'openapi', 'manual']),
  sourceRef: z.string().optional(),
  sourceContent: z.string().optional(),
  generatedConfig: connectorConfigSchema,
})

const draftIdSchema = z.object({ draftId: z.string().min(1) })

const draftFromDocSchema = z.object({
  docText: z.string().min(1),
  providerHint: z.string().optional(),
  sensitivityReviewAccepted: z.boolean().optional(),
})

const reviewSchema = z.object({
  draftId: z.string().min(1),
  decision: z.enum(['approve', 'changes_requested', 'reject']),
  note: z.string().optional(),
})

const activateSchema = z.object({
  draftId: z.string().min(1),
  secretAlias: z.string().optional(),
  apiKey: z.string().optional(),
  approverId: z.string().optional(),
  criticality: z.enum(['L1', 'L2', 'L3']).optional(),
  reason: z.string().optional(),
})

const assignSchema = z.object({
  connectorId: z.string().min(1),
  agentId: z.string().min(1),
  accessMode: z.enum(['read', 'write']),
  apiKey: z.string().optional(),
})

async function syncAssignedConnectorCapabilities(
  agentId: string,
  connectorId: string,
  accessMode: 'read' | 'write',
) {
  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'http_api_get' } },
    create: { agentId, toolName: 'http_api_get', allowed: true },
    update: { allowed: true },
  })

  if (accessMode === 'write') {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName: 'http_api_request' } },
      create: { agentId, toolName: 'http_api_request', allowed: true },
      update: { allowed: true },
    })
    return
  }

  const writeConnectorCount = await prisma.agentConnector.count({
    where: {
      agentId,
      connectorId: { not: connectorId },
      accessMode: 'write',
      connector: { type: 'http_api', lifecycleState: 'active' },
    },
  })
  if (writeConnectorCount === 0) {
    await prisma.capability.updateMany({
      where: { agentId, toolName: 'http_api_request' },
      data: { allowed: false },
    })
  }
}

export async function listProvisioningDrafts() {
  try {
    const user = await requireRole('viewer')
    const drafts = await services.provisioning.listDrafts(actorOf(user))
    return ok(drafts)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a draftokat')
  }
}

export async function listConnectorCatalog() {
  try {
    const user = await requireRole('viewer')
    const catalog = await services.provisioning.listCatalog(actorOf(user))
    return ok(catalog)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a connector-katalógust')
  }
}

export async function listProvisioningAssignableAgents() {
  try {
    await requireRole('viewer')
    const agents = await repositories.agents.findMany()
    return ok(
      agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'hu')),
    )
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az agenteket')
  }
}

/**
 * F2-P-F: doksi → draft-config jelölt. A provisioning-asszisztens agent a doksit
 * ADATKÉNT dolgozza fel és egy ConnectorConfig-jelöltet ad vissza (propose-not-apply).
 * Itt NEM keletkezik draft — az admin a visszaadott configot átnézi a JSON-formban,
 * és onnan hozza létre (createConnectorDraft). A modell kimenete csak adat; a tényleges
 * kapu a determinisztikus validátor a draft létrehozása után.
 */
export async function draftConfigFromApiDoc(input: unknown) {
  try {
    const user = await requireRole('admin')
    const { docText, providerHint, sensitivityReviewAccepted } = draftFromDocSchema.parse(input)

    // A seedelt provisioning-asszisztens agent — audit-attribúció + a Registry modelConfig-je.
    const agents = await repositories.agents.findMany()
    const assistant = agents.find((a) => a.name === PROVISIONING_ASSISTANT_TEMPLATE.name)
    if (!assistant) {
      return fail(
        'A provisioning-asszisztens agent nincs seedelve. Futtasd: npm run db:seed.',
      )
    }

    const messages = services.provisioningAssistant.buildDraftingMessages({
      docText,
      providerHint,
    })
    const sensitivity = inspectPromptSensitivity(messages)
    const forbiddenFindings = sensitivity.findings.filter((f) => f.level === 'forbidden')
    if (forbiddenFindings.length > 0 && !sensitivityReviewAccepted) {
      return ok({
        requiresSensitivityReview: true,
        sensitivity: {
          level: sensitivity.level,
          matchedCategory: sensitivity.matchedCategory,
          findings: forbiddenFindings,
        },
      })
    }

    const result = await services.provisioningAssistant.draftConfigFromDoc({
      agentId: assistant.id,
      agentVersion: assistant.currentVersion,
      agentModelConfig: assistant.modelConfig,
      tenantId: user.tenantId,
      docText,
      providerHint,
      ...(forbiddenFindings.length > 0
        ? {
            sensitivityOverride: {
              reviewedByUserId: user.id,
              allowedForbiddenCategories: [...new Set(forbiddenFindings.map((f) => f.category))],
              reason: 'Provisioning API documentation sensitivity review accepted by admin',
            },
          }
        : {}),
    })
    if (!result.ok) {
      return fail(`${result.error}: ${result.detail}`)
    }
    return ok({ config: result.config, requiresSensitivityReview: false })
  } catch (e) {
    return toFail(e, 'Nem sikerült legenerálni a configot a doksiból')
  }
}

export async function createConnectorDraft(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = createDraftSchema.parse(input)
    const res = await services.provisioning.createConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a draftot')
  }
}

export async function validateConnectorDraft(input: unknown) {
  try {
    const user = await requireRole('viewer')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.validateConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült validálni a draftot')
  }
}

export async function reviewConnectorDraft(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = reviewSchema.parse(input)
    const res = await services.provisioning.reviewConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült rögzíteni a review-döntést')
  }
}

export async function testConnectorDraft(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.testConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült lefuttatni a sandbox-tesztet')
  }
}

export async function activateConnector(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = activateSchema.parse(input)
    const res = await services.provisioning.activateConnector(
      {
        draftId: parsed.draftId,
        secretAlias: parsed.secretAlias,
        apiKey: parsed.apiKey,
        approverId: parsed.approverId,
        criticality: parsed.criticality,
        reason: parsed.reason,
      },
      actorOf(user),
    )
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült aktiválni a connectort')
  }
}

export async function assignConnectorToAgent(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = assignSchema.parse(input)
    const [agent, connector] = await Promise.all([
      repositories.agents.findById(parsed.agentId),
      prisma.connector.findFirst({
        where: {
          id: parsed.connectorId,
          tenantId: user.tenantId,
          lifecycleState: 'active',
        },
      }),
    ])
    if (!agent) return fail('Agent not found')
    if (!connector) return fail('Csak aktivált, tenanton belüli kapcsolat rendelhető agenthez.')

    const res = await services.provisioning.assignConnectorToAgent(
      {
        connectorId: parsed.connectorId,
        agentId: parsed.agentId,
        accessMode: parsed.accessMode,
        apiKey: parsed.apiKey,
      },
      actorOf(user),
    )
    if (connector.type === 'http_api') {
      await syncAssignedConnectorCapabilities(parsed.agentId, parsed.connectorId, parsed.accessMode)
    }
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült hozzárendelni a connectort')
  }
}
