'use server'

import { z } from 'zod'
import type { ConnectorType } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { isSuperadmin } from '@/lib/tenant-policy'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import { materializeConnectorConfig } from '@/domain/connector-template/materializer'
import { materializeGmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import { materializeGoogleDriveConnectorConfig } from '@/domain/connector-template/google-drive-connector-config'

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

const draftIdSchema = z.object({ draftId: z.string().min(1) })

const createFromTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  authMethodKind: z.enum(['api_key', 'bearer', 'basic', 'service_oauth2', 'user_delegated_oauth2']),
  instanceValues: z.record(z.string(), z.string()).default({}),
  secretAliases: z.record(z.string(), z.string()).default({}),
  selectedScopes: z.array(z.string()).optional(),
  selectedEndpoints: z.array(z.string()).optional(),
})

const activateSchema = z.object({
  draftId: z.string().min(1),
  secretAlias: z.string().optional(),
  apiKey: z.string().optional(),
  confirmKeyless: z.boolean().optional(),
})

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
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült sablonból connectort létrehozni')
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
    const res = await services.provisioning.activateConnector(
      {
        draftId: parsed.draftId,
        secretAlias: parsed.secretAlias,
        apiKey: parsed.apiKey,
        confirmKeyless: parsed.confirmKeyless,
      },
      actor,
    )
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
        connectorId: z.string().uuid(),
        agentId: z.string().uuid(),
        accessMode: z.enum(['read', 'write']).default('read'),
        apiKey: z.string().optional(),
      })
      .parse(input)
    await services.provisioning.assignConnectorToAgent(parsed, actorOf(user))
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
      .object({ connectorId: z.string().uuid(), agentId: z.string().uuid() })
      .parse(input)
    await services.provisioning.unassignConnectorFromAgent(parsed, actorOf(user))
    return ok({ unassigned: true })
  } catch (e) {
    return toFail(e, 'A konnektor leválasztása nem sikerült')
  }
}
