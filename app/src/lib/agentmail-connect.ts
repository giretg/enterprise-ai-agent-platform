/**
 * AgentMail-postafiók bekötése konnektorként (draft → validálás → teszt → aktiválás,
 * postafiókonként szűk kulcs). Nem server action: csak admin-ellenőrzés után hívható
 * (`app/actions/agentmail.ts`, `app/actions/agent-mailbox.ts`).
 */
import type { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { isSuperadmin } from '@/lib/tenant-policy'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import {
  AGENTMAIL_TEMPLATE_KEY,
  BUILTIN_CONNECTOR_TEMPLATES,
} from '@/domain/connector-template/builtin-templates'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import { materializeConnectorConfig } from '@/domain/connector-template/materializer'
import { prisma } from '@/lib/db'
import {
  agentMailApiBase,
  agentMailConnectorDescription,
  agentMailEgressHost,
  agentMailInboxPathSegment,
  createAgentInboxApiKey,
  inboxIdFromConnectorBaseUrl,
  type AgentMailInbox,
  type AgentMailRegion,
} from '@/lib/agentmail'

export type AdminUser = Awaited<ReturnType<typeof requireTenantRole>>

export function actorOf(user: AdminUser): ProvisioningActor {
  return {
    type: 'user',
    userId: user.user.id,
    role: user.activeTenantRole,
    tenantId: user.activeTenantId,
    canManagePlatformConnectors: isSuperadmin(user.platformRoles),
  }
}

export function agentMailConnectors(tenantId: string) {
  return prisma.connector.findMany({
    where: {
      tenantId,
      type: 'http_api',
      lifecycleState: 'active',
      config: { path: ['provider'], equals: AGENTMAIL_TEMPLATE_KEY },
    },
    select: {
      id: true,
      config: true,
      agentConnectors: { select: { agentId: true, accessMode: true } },
    },
  })
}

export async function auditAgentMail(user: AdminUser, action: string, targetId: string | null, metadata: Record<string, unknown>) {
  await repositories.audit.append({
    actorType: 'human',
    actorId: user.user.id,
    agentVersion: null,
    action,
    targetType: 'connector',
    targetId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: 'allowed',
    metadata,
    tenantId: user.activeTenantId,
  })
}

export async function connectAgentMailInbox(
  user: AdminUser,
  inbox: AgentMailInbox,
  orgKey: string,
  region: AgentMailRegion,
): Promise<string> {
  const tenantId = user.activeTenantId
  const apiBase = agentMailApiBase(region)
  const existing = (await agentMailConnectors(tenantId)).find(
    (c) => inboxIdFromConnectorBaseUrl((c.config as { baseUrl?: unknown } | null)?.baseUrl) === inbox.inboxId,
  )
  if (existing) return existing.id

  const raw = BUILTIN_CONNECTOR_TEMPLATES.find((t) => t.key === AGENTMAIL_TEMPLATE_KEY)!
  const descriptor = parseTemplateDescriptor(raw)
  const config = materializeConnectorConfig(
    descriptor,
    { authMethodKind: 'bearer', instanceValues: { inboxId: agentMailInboxPathSegment(inbox.inboxId) } },
    {},
    { templateKey: descriptor.key, templateVersion: 1, templateOrigin: 'builtin' },
  )
  // A sablon EU bázissal materializál; a választott régió bázisára cseréljük.
  const regionBaseUrl = `${apiBase}/inboxes/${agentMailInboxPathSegment(inbox.inboxId)}`
  const regionConfig = { ...config, baseUrl: regionBaseUrl }

  await services.platformSettings.extendEgressAllowlist(tenantId, agentMailEgressHost(region), user.user.id, {
    sourceType: 'official',
  })

  const actor = actorOf(user)
  const draft = await services.provisioning.createConnectorDraft(
    {
      name: `AgentMail · ${inbox.email}`,
      sourceType: 'template',
      sourceRef: `${descriptor.key}@1`,
      generatedConfig: { ...regionConfig, description: agentMailConnectorDescription(inbox) },
      connectorType: 'http_api',
    },
    actor,
  )
  await services.provisioning.validateConnectorDraft({ draftId: draft.draftId }, actor)
  const tested = await services.provisioning.testConnectorDraft({ draftId: draft.draftId }, actor)
  if (!tested.ok) throw new Error(`Az AgentMail nem érhető el (${tested.detail ?? tested.statusCode ?? '?'}).`)
  await services.provisioning.reviewConnectorDraft({ draftId: draft.draftId, decision: 'approve' }, actor)

  const inboxKey = await createAgentInboxApiKey(orgKey, inbox.inboxId, `platform · ${inbox.email}`, apiBase)
  await services.provisioning.activateConnector({ draftId: draft.draftId, apiKey: inboxKey }, actor)
  await auditAgentMail(user, 'connector.materialize', draft.connectorId, {
    templateKey: descriptor.key,
    templateVersion: 1,
    templateOrigin: 'builtin',
    region,
    inboxEmail: inbox.email,
  })
  return draft.connectorId
}
