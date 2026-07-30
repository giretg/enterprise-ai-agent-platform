'use server'

import { z } from 'zod'
import { requirePlatformRole, requireTenantPermission, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { PROVISIONING_ASSISTANT_TEMPLATE } from '@/domain/provisioning/provisioning-assistant'
import { formatProvisioningAssistantError } from '@/domain/provisioning/provisioning-assistant-errors'
import { connectorConfigSchema } from '@/domain/provisioning/connector-config'
import {
  materializeConnectorConfig,
  selfCheckTemplateDescriptor,
} from '@/domain/connector-template/materializer'
import { materializeGmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import {
  parseTemplateDescriptor,
  templateDescriptorSchema,
} from '@/domain/connector-template/template-descriptor'
import { WEB_EGRESS_ROLE_TEMPLATE } from '@/domain/agents/web-egress-role'
import {
  ensureTenantWebEgressAgent,
  findTenantWebEgressAgent,
} from '@/domain/agent-access/web-egress-materialization'
import {
  inspectPromptSensitivity,
  reviewableSensitivityFindings,
  type SensitivityFinding,
} from '@/domain/gateway/sensitivity-router'

/**
 * Server actions a Provisioning Assistant (Connector Onboarding) admin-felülethez
 * (Feature-spec — Provisioning-Assistant §8, F2-P-C). A privilegizált aktusok
 * (review/test/activate/assign) emberi `admin`-t követelnek — a kemény padlót a
 * ProvisioningService is kikényszeríti (CR-MVP-002).
 */

function actorOf(user: Awaited<ReturnType<typeof requireTenantRole>>): ProvisioningActor {
  return { type: 'user', userId: user.user.id, role: user.activeTenantRole, tenantId: user.activeTenantId }
}

/** A ProvisioningError üzenetét ügyfél-barát formában visszaadjuk (kód + üzenet). */
function toFail(e: unknown, fallback: string) {
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

function ensureCustomTemplateActivationHelp(descriptor: {
  key: string
  activationHelp?: string
}) {
  if (descriptor.activationHelp?.trim()) return
  throw new ProvisioningError(
    'PROVISIONING_INVALID_INPUT',
    `A custom connector-sablonhoz kötelező activationHelp mező: ${descriptor.key}`,
  )
}

// A draft-config sémáját a domain-rétegből vesszük át (connector-config.ts), hogy az
// action- és a domain-réteg SOHA ne csússzon szét. Korábban itt egy szűkített másolat
// élt, amely a Zod strip-elése miatt NÉMÁN eldobta az `auth.tokenUrl` / `auth.clientId`
// / `auth.scope` mezőket — így ezeket draft-szerkesztéskor nem lehetett menteni, és az
// oauth2 connector futásidőben "tokenUrl must be an absolute http(s) URL"-lel bukott.

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
  tenantScoped: z.boolean().optional(),
  selfCheck: templateSelfCheckSchema.optional(),
})

const deprecateConnectorTemplateSchema = z.object({
  templateId: z.string().min(1),
})

const draftIdSchema = z.object({ draftId: z.string().min(1) })

const draftFromDocSchema = z.object({
  docText: z.string().min(1),
  providerHint: z.string().optional(),
  sensitivityReviewAccepted: z.boolean().optional(),
})

const discoverSchema = z.object({
  connectorName: z.string().min(1).max(120),
  knownDomain: z.string().max(253).optional(),
  sensitivityReviewAccepted: z.boolean().optional(),
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

/**
 * A felfedezéshez használt Web-Egress példány (#142).
 *
 * A Web-Egress mostantól TENANTONKÉNT materializált, normál tenant-agent: a tenant
 * SAJÁT web_search connectorán és kulcsán megy ki a forgalom, tehát a tenant példányát
 * kell választani. A platform-szintű (`tenantId = null`) példány csak visszaesés a még
 * nem migrált telepítéseken — a materializáció (`ensureTenantWebEgressAgent`) idempotens,
 * ezért itt is megpróbáljuk pótolni.
 *
 * Ez NEM `address` grant: a „discover" az admin panel-actionjén fut, jogosultsággal
 * védve — a gráf az AD-HOC utat köti, nem az admin kormányzási műveletet.
 */
async function resolveProvisioningEgressAgent(tenantId: string | null, actorUserId: string) {
  if (tenantId) {
    const tenantInstance = await findTenantWebEgressAgent(tenantId)
    if (tenantInstance?.status === 'active') return tenantInstance
    try {
      const materialized = await ensureTenantWebEgressAgent({ tenantId, approvedById: actorUserId })
      if (materialized.status === 'active') return materialized
    } catch {
      // Fail-soft: a platform-szintű visszaesésre megyünk tovább (lásd alább).
    }
  }
  const agents = await repositories.agents.findMany()
  const egressCandidates = agents.filter(
    (a) => a.name === WEB_EGRESS_ROLE_TEMPLATE.name && a.status === 'active',
  )
  return egressCandidates.find((a) => a.tenantId === null) ?? egressCandidates[0] ?? null
}

const extendEgressSchema = z.object({
  host: z.string().min(1).max(253),
  sourceType: z.enum(['official', 'vendor_doc']).optional(),
  draftId: z.string().optional(),
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
  /** oauth2 / oauth2_delegated: nem-titkos OAuth client_id → config.auth.clientId. */
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

const assignSchema = z.object({
  connectorId: z.string().min(1),
  agentId: z.string().min(1),
  accessMode: z.enum(['read', 'write']),
  apiKey: z.string().optional(),
})

const unassignSchema = z.object({
  connectorId: z.string().min(1),
  agentId: z.string().min(1),
  reason: z.string().max(500).optional(),
})

async function syncAssignedConnectorCapabilities(
  agentId: string,
  connectorId: string,
  accessMode: 'read' | 'write',
  connectorType: 'http_api' | 'gmail',
) {
  if (connectorType === 'gmail') {
    const readTools = ['gmail_search', 'gmail_get_message', 'mailbox_count'] as const
    const writeTools = ['gmail_create_draft', 'gmail_send'] as const
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
        connector: { type: 'gmail', lifecycleState: 'active' },
      },
    })
    if (writeConnectorCount === 0) {
      await prisma.capability.updateMany({
        where: { agentId, toolName: { in: [...writeTools] } },
        data: { allowed: false },
      })
    }
    return
  }

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'http_api_get' } },
    create: { agentId, toolName: 'http_api_get', allowed: true },
    update: { allowed: true },
  })
  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'http_api_get_all' } },
    create: { agentId, toolName: 'http_api_get_all', allowed: true },
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

/**
 * Egy connector megszüntetése/leszerelése után az érintett agentek http_api capability-jeit
 * újraszámoljuk: ha egy agentnek nem maradt AKTÍV http_api connectora → http_api_get letiltva;
 * ha nem maradt write hozzáférésű aktív http_api connectora → http_api_request letiltva.
 * A megszüntetés ekkor már levette az agent_connectors kötést, ezért a count tükrözi a valóságot.
 */
async function syncConnectorRemovalCapabilities(agentIds: string[]) {
  const GMAIL_READ_TOOLS = ['gmail_search', 'gmail_get_message', 'mailbox_count'] as const
  const GMAIL_WRITE_TOOLS = ['gmail_create_draft', 'gmail_send'] as const

  for (const agentId of agentIds) {
    const [httpAnyActive, httpWriteActive, gmailAnyActive, gmailWriteActive] = await Promise.all([
      prisma.agentConnector.count({
        where: { agentId, connector: { type: 'http_api', lifecycleState: 'active' } },
      }),
      prisma.agentConnector.count({
        where: {
          agentId,
          accessMode: 'write',
          connector: { type: 'http_api', lifecycleState: 'active' },
        },
      }),
      prisma.agentConnector.count({
        where: { agentId, connector: { type: 'gmail', lifecycleState: 'active' } },
      }),
      prisma.agentConnector.count({
        where: {
          agentId,
          accessMode: 'write',
          connector: { type: 'gmail', lifecycleState: 'active' },
        },
      }),
    ])
    if (httpAnyActive === 0) {
      await prisma.capability.updateMany({
        where: { agentId, toolName: { in: ['http_api_get', 'http_api_get_all'] } },
        data: { allowed: false },
      })
    }
    if (httpWriteActive === 0) {
      await prisma.capability.updateMany({
        where: { agentId, toolName: 'http_api_request' },
        data: { allowed: false },
      })
    }
    if (gmailAnyActive === 0) {
      await prisma.capability.updateMany({
        where: { agentId, toolName: { in: [...GMAIL_READ_TOOLS, ...GMAIL_WRITE_TOOLS] } },
        data: { allowed: false },
      })
    } else if (gmailWriteActive === 0) {
      await prisma.capability.updateMany({
        where: { agentId, toolName: { in: [...GMAIL_WRITE_TOOLS] } },
        data: { allowed: false },
      })
    }
  }
}

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

export async function listProvisioningDrafts() {
  try {
    const user = await requireTenantRole('viewer')
    const drafts = await services.provisioning.listDrafts(actorOf(user))
    return ok(drafts)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a draftokat')
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

export async function listProvisioningAssignableAgents() {
  try {
    const user = await requireTenantRole('viewer')
    // Csak az aktív tenant agentjei — a bekötés (assignConnectorToAgent) is
    // `activeTenantId`-re szűr, így a lista és a bind konzisztens. A superadmin a
    // többi tenant agentjeit tenant-váltással éri el, nem összefésült listával.
    const agents = await repositories.agents.findMany({ tenantId: user.activeTenantId })
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
    const user = await requireTenantRole('admin')
    const { docText, providerHint, sensitivityReviewAccepted } = draftFromDocSchema.parse(input)

    // A seedelt provisioning-asszisztens agent — audit-attribúció + a Registry modelConfig-je.
    const agents = await repositories.agents.findMany()
    const assistant = agents.find((a) => a.name === PROVISIONING_ASSISTANT_TEMPLATE.name)
    if (!assistant) {
      return fail(
        'A provisioning-asszisztens agent nincs seedelve. Futtasd: npm run db:seed.',
      )
    }

    const result = await services.provisioningAssistant.draftConfigFromDoc({
      agentId: assistant.id,
      agentVersion: assistant.currentVersion,
      agentModelConfig: assistant.modelConfig,
      tenantId: user.activeTenantId,
      docText,
      providerHint,
      allowSensitiveExternalModel: assistant.allowSensitiveExternalModel,
      sensitivityReviewAccepted,
      reviewedByUserId: sensitivityReviewAccepted ? user.user.id : undefined,
    })
    if (!result.ok && result.error === 'SENSITIVITY_REVIEW_REQUIRED') {
      return ok({
        requiresSensitivityReview: true,
        sensitivity: {
          level: result.level,
          matchedCategory: result.matchedCategory,
          findings: result.findings,
        },
      })
    }
    if (!result.ok) {
      return fail(formatProvisioningAssistantError(result.error, result.detail, 'doc'))
    }
    return ok({
      config: result.config,
      requiresSensitivityReview: false,
      extractionMethod: result.extractionMethod ?? 'llm',
    })
  } catch (e) {
    return toFail(e, 'Nem sikerült legenerálni a configot a doksiból')
  }
}

/**
 * API-doksi letöltése admin által megadott URL-ről (web_fetch). A tartalom a UI-ban
 * jóváhagyásra kerül; a generálás a meglévő `draftConfigFromApiDoc` úton folytatódik.
 * Admin-only; az URL explicit allowlist- és allowedSourceUrls-ként szerepel.
 */
export async function fetchApiDocFromUrl(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { url } = fetchApiDocUrlSchema.parse(input)

    const egressAgent = await resolveProvisioningEgressAgent(user.activeTenantId, user.user.id)
    if (!egressAgent) {
      return fail(
        'A web-egress role agent nincs seedelve. Futtasd: npm run db:seed, majd kapcsold be a web_fetch platform-toolt.',
      )
    }

    const result = await services.provisioningAssistant.fetchApiDocFromUrl({
      url,
      egressRoleAgentId: egressAgent.id,
      tenantId: user.activeTenantId,
    })

    if (!result.ok) {
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
        metadata: { reason: result.error, detail: result.detail },
      })
      return fail(formatProvisioningAssistantError(result.error, result.detail, 'fetch'))
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
      metadata: {
        urlHash: result.urlHash,
        host: result.host,
        sourceType: result.sourceType,
        contentHash: result.contentHash,
        bytes: result.bytes,
        contentType: result.contentType,
        truncated: result.truncated,
      },
    })

    return ok({
      docText: result.text,
      sourceUrl: result.sourceUrl,
      host: result.host,
      bytes: result.bytes,
      contentType: result.contentType,
      truncated: result.truncated,
    } satisfies FetchApiDocFromUrlData)
  } catch (e) {
    return toFail(e, 'Nem sikerült letölteni az API-doksit az URL-ről')
  }
}

/**
 * Kapcsolat felfedezése névből (WebFetch-Egress §5, §12.1). Admin-only. A web-egress role
 * agent a weben megkeresi és letölti a spec doksiját, és ebből ConnectorConfig-jelöltet ad
 * vissza (propose-not-apply). NEM hoz létre draftot — az admin a visszaadott configot
 * átnézi és a meglévő createConnectorDraft-tal rakja le. A tényleges kapu a determinisztikus
 * validátor + emberi aktiválás (§3, §4). A felfedezés flag alapból KI (`web_discovery`).
 */
export async function discoverConnectorFromName(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { connectorName, knownDomain, sensitivityReviewAccepted } = discoverSchema.parse(input)

    // A seedelt web-egress role agent — audit-attribúció + a Registry modelConfig-je + a
    // web.fetch/discover capability-k hordozója. Ha nincs, a felfedezés nem elérhető.
    //
    // #142 — a Web-Egress TENANTONKÉNT materializált: a felfedezés a tenant SAJÁT
    // példányán és search-connectorán fut, így a webes forgalom a tenant kulcsán és
    // házirendjén megy ki. A platform-szintű példány csak visszaesés a még nem migrált
    // telepítéseken.
    const egressAgent = await resolveProvisioningEgressAgent(user.activeTenantId, user.user.id)
    if (!egressAgent) {
      return fail(
        'A web-egress role agent nincs seedelve. Futtasd: npm run db:seed (a felfedezés flag mögött).',
      )
    }

    // Érzékenységi kapu a connector-névre (mint a docText-re a kézi úton).
    const sensitivity = inspectPromptSensitivity([{ role: 'user', content: connectorName }])
    const sensitivityBypassEnabled = egressAgent.allowSensitiveExternalModel
    const reviewFindings = reviewableSensitivityFindings(sensitivity.findings, {
      allowSensitiveExternalModel: sensitivityBypassEnabled,
      sensitivityReviewAccepted,
    })
    if (reviewFindings.length > 0) {
      return ok({
        requiresSensitivityReview: true,
        sensitivity: {
          level: sensitivity.level,
          matchedCategory: sensitivity.matchedCategory,
          findings: reviewFindings,
        },
      })
    }

    const result = await services.provisioningAssistant.discoverConfigFromName({
      connectorName,
      knownDomain: knownDomain ?? null,
      egressRoleAgentId: egressAgent.id,
      egressRoleAgentVersion: egressAgent.currentVersion,
      agentModelConfig: egressAgent.modelConfig,
      tenantId: user.activeTenantId,
      allowSensitiveExternalModel: sensitivityBypassEnabled,
      sensitivityReviewAccepted,
      reviewedByUserId: sensitivityReviewAccepted ? user.user.id : undefined,
    })
    if (!result.ok && result.error === 'SENSITIVITY_REVIEW_REQUIRED') {
      return ok({
        requiresSensitivityReview: true,
        sensitivity: {
          level: result.level,
          matchedCategory: result.matchedCategory,
          findings: result.findings,
        },
      })
    }
    // §11.1/§11.2 felfedezés-kimenet audit — actor = web-egress role agent, hash-only (§11.3).
    if (!result.ok) {
      await repositories.audit.append({
        actorType: 'agent',
        actorId: egressAgent.id,
        agentVersion: egressAgent.currentVersion,
        action: 'provisioning.discover.blocked',
        targetType: 'provisioning_discovery',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'blocked',
        metadata: { reason: result.error },
      })
      return fail(formatProvisioningAssistantError(result.error, result.detail, 'discover'))
    }
    await repositories.audit.append({
      actorType: 'agent',
      actorId: egressAgent.id,
      agentVersion: egressAgent.currentVersion,
      action: 'provisioning.discover.draft',
      targetType: 'provisioning_discovery',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        queryHash: result.provenance.queryHash,
        sources: result.provenance.sources.map((s) => ({
          urlHash: s.urlHash,
          contentHash: s.contentHash,
          host: s.host,
          sourceType: s.sourceType,
        })),
      },
    })
    return ok({ config: result.config, provenance: result.provenance, requiresSensitivityReview: false })
  } catch (e) {
    return toFail(e, 'Nem sikerült felfedezni a kapcsolatot')
  }
}

/**
 * Új egress-host hozzáadása a tenant allowlistjéhez (WebFetch-Egress §9, §12.2). Admin-only,
 * KÜLÖN auditált aktus (`connector.egress_allowlist.extend`) — a felfedezés a hostot csak
 * JAVASOLJA (validátor `warned`), az admin explicit adja hozzá, és csak utána aktiválhat.
 * SSRF-tiltott hostot a service elutasít (defense-in-depth).
 */
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
          ? 'A host tiltott (privát IP / localhost / metadata / exfil-sink) — nem adható az allowlisthez.'
          : 'Érvénytelen host.',
      )
    }
    return ok({ added: res.added, host: res.host, hosts: res.hosts })
  } catch (e) {
    return toFail(e, 'Nem sikerült bővíteni az egress-allowlistet')
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
      return fail('Connector template not found')
    }
    if (template.status !== 'active') {
      return fail('Csak aktív connector-sablonból hozható létre draft.')
    }

    const descriptor = parseTemplateDescriptor(template.descriptor)
    const connectorType = descriptor.connectorType ?? 'http_api'
    const generatedConfig =
      connectorType === 'gmail'
        ? materializeGmailConnectorConfig(
            descriptor,
            {
              authMethodKind: parsed.authMethodKind,
              instanceValues: parsed.instanceValues,
              selectedScopes: parsed.selectedScopes,
              selectedEndpoints: parsed.selectedEndpoints,
            },
            parsed.secretAliases,
            {
              templateId: template.id,
              templateKey: template.key,
              templateVersion: template.version,
              templateOrigin: template.origin,
            },
          )
        : materializeConnectorConfig(
            descriptor,
            {
              authMethodKind: parsed.authMethodKind,
              instanceValues: parsed.instanceValues,
              selectedScopes: parsed.selectedScopes,
              selectedEndpoints: parsed.selectedEndpoints,
            },
            parsed.secretAliases,
            {
              templateId: template.id,
              templateKey: template.key,
              templateVersion: template.version,
              templateOrigin: template.origin,
            },
          )

    const secretAliasSuggested =
      connectorType === 'gmail'
        ? (parsed.secretAliases.clientSecret?.trim() || 'google-workspace-oauth-client-secret')
        : null

    const res = await services.provisioning.createConnectorDraft(
      {
        name: parsed.name,
        sourceType: 'template',
        sourceRef: `${template.key}@${template.version}`,
        sourceContent: JSON.stringify(template.descriptor),
        generatedConfig,
        connectorType,
        secretAliasSuggested,
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
    })

    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült sablonból connectort létrehozni')
  }
}

export async function upsertConnectorTemplateAction(input: unknown) {
  try {
    const parsed = upsertConnectorTemplateSchema.parse(input)
    const descriptor = parseTemplateDescriptor(parsed.descriptor)
    ensureCustomTemplateActivationHelp(descriptor)

    selfCheckTemplateDescriptor(descriptor, parsed.selfCheck)

    // §13/6: globális (platform-fallback) sablont CSAK platform-szerep írhat;
    // tenant-scope sablont a tenant-admin, az AKTÍV tenant kontextusában.
    const isGlobal = parsed.tenantScoped === false
    let actorId: string
    let tenantId: string | null
    if (isGlobal) {
      actorId = (await requirePlatformRole('superadmin')).user.id
      tenantId = null
    } else {
      const ctx = await requireTenantPermission('connector_template:manage')
      actorId = ctx.user.id
      tenantId = ctx.activeTenantId
    }

    const latest = await repositories.connectorTemplates.findLatestByKey(descriptor.key, tenantId ?? null)
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
    const parsed = deprecateConnectorTemplateSchema.parse(input)
    const template = await repositories.connectorTemplates.findByIdVersion(parsed.templateId)
    if (!template) return fail('Connector template not found')
    if (template.origin === 'builtin') {
      return fail('Builtin connector-sablon nem deprecálható ezen a felületen.')
    }

    // §13/6: globális sablon → platform-szerep; tenant-sablon → tenant-admin az
    // AKTÍV tenant kontextusában (cross-tenant célpont "not found").
    let actorId: string
    if (template.tenantId === null) {
      actorId = (await requirePlatformRole('superadmin')).user.id
    } else {
      const ctx = await requireTenantPermission('connector_template:manage')
      if (template.tenantId !== ctx.activeTenantId) return fail('Connector template not found')
      actorId = ctx.user.id
    }

    await repositories.connectorTemplates.deprecate(template.id)
    await repositories.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'connector.template.deprecate',
      targetType: 'connector_template',
      targetId: template.id,
      modelUsed: null,
      inputRef: template.key,
      outputRef: `${template.key}@${template.version}`,
      policyDecision: 'allowed',
      metadata: {
        tenant_id: template.tenantId,
        templateKey: template.key,
        templateVersion: template.version,
      },
      tenantId: template.tenantId,
    })

    return ok({ id: template.id, status: 'deprecated' })
  } catch (e) {
    return toFail(e, 'Nem sikerült deprecálni a connector-sablont')
  }
}

export async function validateConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = draftIdSchema.parse(input)
    const res = await services.provisioning.validateConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült validálni a draftot')
  }
}

export async function reviewConnectorDraft(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = reviewSchema.parse(input)
    const res = await services.provisioning.reviewConnectorDraft(parsed, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült rögzíteni a review-döntést')
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
    const res = await services.provisioning.testConnectorDraftWithCredentials(
      parsed,
      actorOf(user),
    )
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült lefuttatni a kulcsos tesztet')
  }
}

export async function activateConnector(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = activateSchema.parse(input)
    const res = await services.provisioning.activateConnector(
      {
        draftId: parsed.draftId,
        secretAlias: parsed.secretAlias,
        apiKey: parsed.apiKey,
        clientId: parsed.clientId,
        approverId: parsed.approverId,
        criticality: parsed.criticality,
        reason: parsed.reason,
        confirmKeyless: parsed.confirmKeyless,
        defaultActingUserEmail: parsed.defaultActingUserEmail,
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
    const user = await requireTenantRole('admin')
    const parsed = assignSchema.parse(input)
    const [agent, connector] = await Promise.all([
      repositories.agents.findById(parsed.agentId, user.activeTenantId),
      prisma.connector.findFirst({
        where: {
          id: parsed.connectorId,
          tenantId: user.activeTenantId,
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
    if (connector.type === 'http_api' || connector.type === 'gmail') {
      await syncAssignedConnectorCapabilities(
        parsed.agentId,
        parsed.connectorId,
        parsed.accessMode,
        connector.type,
      )
    }
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült hozzárendelni a connectort')
  }
}

export async function unassignConnectorFromAgent(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = unassignSchema.parse(input)
    const [agent, connector] = await Promise.all([
      repositories.agents.findById(parsed.agentId, user.activeTenantId),
      prisma.connector.findFirst({
        where: {
          id: parsed.connectorId,
          tenantId: user.activeTenantId,
          lifecycleState: 'active',
        },
      }),
    ])
    if (!agent) return fail('Agent not found')
    if (!connector) return fail('Csak aktivált, tenanton belüli kapcsolat választható le agentről.')

    const res = await services.provisioning.unassignConnectorFromAgent(
      {
        connectorId: parsed.connectorId,
        agentId: parsed.agentId,
        reason: parsed.reason,
      },
      actorOf(user),
    )
    if (connector.type === 'http_api' || connector.type === 'gmail') {
      await syncConnectorRemovalCapabilities([parsed.agentId])
    }
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült leválasztani a connectort')
  }
}

/**
 * Draft/validated connector config-jának javító szerkesztése (admin-only). A módosítás
 * resetteli a gate-et (validáció/review/sandbox), így a javított config újra végigmegy a
 * teljes kapun. Aktív connectorra előbb `reopenConnector` kell.
 */
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

/**
 * Aktív connector visszanyitása draftba, hogy javítható legyen (admin-only). A connector
 * offline lesz (Tool Broker deny), a gate resetelődik; a javítás után újra kell aktiválni.
 */
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

/**
 * Aktív connector auditált megszüntetése (admin-only): agent-kötések levétele, user-grantek
 * visszavonása, secret-ref törlés, lifecycle=archived. Dual-control bank-preset / L2–L3 esetén.
 * A megszüntetés után az érintett agentek http_api capability-jeit újraszámoljuk.
 */
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

/**
 * Aktív connector leszerelése connectorId alapján (admin-only) — draft nélküli legacy/seed
 * connectorokhoz is. Ugyanaz a leszerelési út, mint a provisioning draft megszüntetésnél.
 */
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

/**
 * SOSEM aktivált draft végleges törlése (admin-only) — botched draftok takarításához.
 * Aktív connectorra tilos (arra `decommissionConnector` jár).
 */
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
