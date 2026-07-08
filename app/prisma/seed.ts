import { randomBytes } from 'crypto'
import { writeFile } from 'fs/promises'
import path from 'path'
import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { ensureAgentKnowledgeBase } from '../src/lib/agent-knowledge-base'
import {
  PROVISIONING_ASSISTANT_TEMPLATE,
  PROVISIONING_DRAFT_CAPABILITIES,
} from '../src/domain/provisioning/provisioning-assistant'
import { PLAYBOOK_AUTHOR_TEMPLATE } from '../src/domain/playbook/playbook-author-agent'
import {
  WEB_EGRESS_ROLE_TEMPLATE,
  WEB_EGRESS_TOOL_CAPABILITIES,
  PROVISIONING_DISCOVER_CAPABILITIES,
} from '../src/domain/agents/web-egress-role'
import { ensureSystemRoleTemplates } from '../src/repositories/postgres/role-template-repository'
import { ensureDefaultRolePermissions } from '../src/repositories/postgres/iam-repository'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/custom-template-seeds'
import { upsertConnectorByTypeName } from '../src/lib/connector-upsert'
import { ensureTenantGmailConnector } from '../src/lib/seed-gmail-connector'
import { ensureStarterStepTemplates } from '../src/domain/step-template/step-template-catalog'
import {
  computeSkillContentHash,
  type SkillContent,
  type SkillRequirement,
} from '../src/lib/skill/skill-content'
import { signSkillVersion } from '../src/lib/crypto/hash-chain'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

const prisma = new PrismaClient()

/**
 * A demo tenant fix azonosítója (Tenant-Management §11.1). A monitor-seed és a
 * `scripts/backfill-tenant-demo.ts` is erre az UUID-re hivatkozik — egyetlen
 * egytenantos dev/demo workspace.
 */
const DEMO_TENANT_ID = '00000000-0000-4000-a000-000000000001'

// Szerep-instrukció ("mit csinál") és viselkedés-profil ("hogyan") külön
// verziózva (§4.2/§5.3).
const WIKI_ROLE_INSTRUCTION = `Te az Excellence Pay belső tudás-asszisztense vagy.
Kizárólag a jóváhagyott belső tudásbázisra támaszkodva válaszolsz a felhasználók kérdéseire.`

const WIKI_BEHAVIOR_PROFILE = `Magyarul, tömören válaszolj, és minden lényegi állításhoz adj forráshivatkozást.
Ha nincs elég forrás, mondd ki, hogy nincs elég forrás, és ne találj ki tényt.`

const INITIAL_MEMORY = `Excellence Pay belső tudásbázis - kezdő tartalom:
- A platform célja kontrollált, auditálható AI agent munkakörnyezet biztosítása.
- Az egyik referencia agent egy belső wiki-agent.
- A modellforrás kizárólag ChatGPT OAuth lehet.
- Minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.`

const KEY_FILE = path.join(process.cwd(), '.seed-demo-api-key')

const BOOKKEEPER_ROLE_INSTRUCTION = `Te a csapat könyvelő AI agentje vagy (a csapat Bori-nak hív).
Feladatod könyvelési ellenőrzések, számlák és tételek feldolgozása ticketekből.`

const BOOKKEEPER_BEHAVIOR_PROFILE = `Magyarul, pontosan és tételesen dolgozol. A board ticketjeiből érkező feladatokat feldolgozod.`

async function ensureBookkeeperAgent(adminId: string) {
  const existing = await prisma.agent.findFirst({ where: { name: 'Könyvelő Agent' } })
  if (existing) {
    await ensureToolBrokerSeed(existing.id)
    return existing
  }

  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: 'Könyvelő agent — könyvelési ellenőrzések és számla-feldolgozás.',
      status: 'active',
      source: 'seed',
      approvedById: adminId,
    },
  })
  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    temperature: 0.2,
    maxTokens: 4096,
  }

  const agent = await prisma.agent.create({
    data: {
      name: 'Könyvelő Agent',
      roleInstruction: BOOKKEEPER_ROLE_INSTRUCTION,
      behaviorProfile: BOOKKEEPER_BEHAVIOR_PROFILE,
      behaviorProfileOverlay: BOOKKEEPER_BEHAVIOR_PROFILE,
      modelConfig,
      status: 'active',
      role: 'worker',
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: BOOKKEEPER_ROLE_INSTRUCTION,
      behaviorProfileSnapshot: BOOKKEEPER_BEHAVIOR_PROFILE,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  await ensureToolBrokerSeed(agent.id)
  return agent
}

/**
 * Playbook-Role-Agent-Binding §6/WP-10: a Playbook-szerző agent szerep-sablonja az
 * Agent Registryben. `worker`, eszközjog/capability nélkül — a kimenete kizárólag
 * adat (draft spec), amit a hívó server action a meglévő PlaybookV2Service-en át ment.
 */
async function ensurePlaybookAuthorAgent(adminId: string) {
  const t = PLAYBOOK_AUTHOR_TEMPLATE
  const existing = await prisma.agent.findFirst({ where: { name: t.name } })
  if (existing) return existing

  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: 'Playbook Author — természetes nyelvből validálható Playbook-draftot generál (propose, not apply).',
      status: 'active',
      source: 'seed',
      approvedById: adminId,
    },
  })
  await prisma.memory.update({ where: { id: memory.id }, data: { currentVersionId: memoryVersion.id } })

  const modelConfig = { ...t.modelConfig }

  const agent = await prisma.agent.create({
    data: {
      name: t.name,
      roleInstruction: t.roleInstruction,
      behaviorProfile: t.behaviorProfile,
      behaviorProfileOverlay: t.behaviorProfile,
      modelConfig,
      status: 'active',
      role: t.role,
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: t.roleInstruction,
      behaviorProfileSnapshot: t.behaviorProfile,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  return agent
}

/**
 * F2-P-F: a provisioning-asszisztens agent szerep-sablonja az Agent Registryben
 * (Feature-spec — Provisioning-Assistant §6.1). Erősen korlátozott `worker`: az
 * EGYETLEN író felülete a `provisioning.draft.*` capability-osztály (deny-by-default),
 * nincs eszközjoga, connectorja, secretje. Aktiválás/hozzárendelés sosem agent-aktus.
 */
async function ensureProvisioningAssistantAgent(adminId: string) {
  const t = PROVISIONING_ASSISTANT_TEMPLATE
  const existing = await prisma.agent.findFirst({ where: { name: t.name } })
  if (existing) {
    await ensureProvisioningAssistantCapabilities(existing.id)
    return existing
  }

  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content:
        'Provisioning Assistant — API-doksiból draft connector-deskriptort generál (propose, not apply).',
      status: 'active',
      source: 'seed',
      approvedById: adminId,
    },
  })
  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = { ...t.modelConfig }

  const agent = await prisma.agent.create({
    data: {
      name: t.name,
      roleInstruction: t.roleInstruction,
      behaviorProfile: t.behaviorProfile,
      behaviorProfileOverlay: t.behaviorProfile,
      modelConfig,
      status: 'active',
      role: t.role,
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: t.roleInstruction,
      behaviorProfileSnapshot: t.behaviorProfile,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  await ensureProvisioningAssistantCapabilities(agent.id)
  return agent
}

/** A `provisioning.draft.*` capability-seed (deny-by-default → itt kifejezetten allowed). */
async function ensureProvisioningAssistantCapabilities(agentId: string) {
  for (const toolName of PROVISIONING_DRAFT_CAPABILITIES) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
}

async function ensureBuiltinConnectorTemplates() {
  for (const descriptor of BUILTIN_CONNECTOR_TEMPLATES) {
    const existing = await prisma.connectorTemplate.findFirst({
      where: { key: descriptor.key, version: 1, tenantId: null, origin: 'builtin' },
    })
    if (!existing) {
      await prisma.connectorTemplate.create({
        data: {
          key: descriptor.key,
          version: 1,
          origin: 'builtin',
          displayName: descriptor.displayName,
          description: descriptor.description ?? null,
          tenantId: null,
          descriptor,
          status: 'active',
        },
      })
      continue
    }
    await prisma.connectorTemplate.update({
      where: { id: existing.id },
      data: {
        key: descriptor.key,
        version: 1,
        origin: 'builtin',
        displayName: descriptor.displayName,
        description: descriptor.description ?? null,
        tenantId: null,
        descriptor,
        status: 'active',
      },
    })
  }
}

async function ensureGlobalCustomConnectorTemplates() {
  for (const descriptor of GLOBAL_CUSTOM_CONNECTOR_TEMPLATES) {
    const existing = await prisma.connectorTemplate.findFirst({
      where: { key: descriptor.key, tenantId: null, origin: 'custom' },
      orderBy: [{ version: 'desc' }],
    })
    if (existing) continue

    await prisma.connectorTemplate.create({
      data: {
        key: descriptor.key,
        version: 1,
        origin: 'custom',
        displayName: descriptor.displayName,
        description: descriptor.description ?? null,
        tenantId: null,
        descriptor,
        status: 'active',
      },
    })
  }
}

/**
 * Web-egress role agent (WebFetch-Egress §8.1, §17/8). Capability-izolált `worker`: a
 * `web_fetch` platform-tool KIZÁRÓLAG neki adható (§7.4) + `web_search` + `provisioning.discover.*`.
 * Nincs eszközjoga kárt tenni (nincs activate/assign/secret/mutáló business-tool). A funkció
 * ALAPBÓL KI van kapcsolva (`web_fetch.enabled` / `web_discovery` flag false); az agent léte
 * önmagában semmit nem tesz elérhetővé — a discoverConfigFromName flag off esetén leáll.
 */
async function ensureWebEgressRoleAgent(adminId: string) {
  const t = WEB_EGRESS_ROLE_TEMPLATE
  const existing = await prisma.agent.findFirst({ where: { name: t.name } })
  if (existing) {
    await ensureWebEgressRoleCapabilities(existing.id)
    await ensureWebSearchSeed(existing.id)
    return existing
  }

  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: 'Web-Egress Worker — capability-izolált agent; megbízhatatlan webtartalmat ADATKÉNT dolgoz fel.',
      status: 'active',
      source: 'seed',
      approvedById: adminId,
    },
  })
  await prisma.memory.update({ where: { id: memory.id }, data: { currentVersionId: memoryVersion.id } })

  const modelConfig = { ...t.modelConfig }
  const agent = await prisma.agent.create({
    data: {
      name: t.name,
      roleInstruction: t.roleInstruction,
      behaviorProfile: t.behaviorProfile,
      behaviorProfileOverlay: t.behaviorProfile,
      modelConfig,
      status: 'active',
      role: t.role,
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })
  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: t.roleInstruction,
      behaviorProfileSnapshot: t.behaviorProfile,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  await ensureWebEgressRoleCapabilities(agent.id)
  // A web_search felület a meglévő „Controlled Web Search" connectoron át (broker + rate-limit).
  await ensureWebSearchSeed(agent.id)
  return agent
}

/**
 * A web-egress role capability-seed (deny-by-default → itt kifejezetten allowed):
 * `web_search`, `web_fetch` (a §7.4 kapu ezt olvassa) + `provisioning.discover.*`.
 * A `web_fetch` NEM connector-backed broker-tool — csak Capability-sor, amit a felfedező
 * hurok wrappere ellenőriz. A `web_search` connector-hozzárendelést az ensureWebSearchSeed adja.
 */
async function ensureWebEgressRoleCapabilities(agentId: string) {
  const caps: string[] = [...WEB_EGRESS_TOOL_CAPABILITIES, ...PROVISIONING_DISCOVER_CAPABILITIES]
  for (const toolName of caps) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
}

async function ensureChatToolsForAgent(agentId: string) {
  const board = await prisma.connector.findFirst({
    where: { type: 'board', name: 'Control Plane Board' },
  })
  if (board) {
    await prisma.agentConnector.upsert({
      where: { agentId_connectorId: { agentId, connectorId: board.id } },
      create: { agentId, connectorId: board.id, accessMode: 'write' },
      update: { accessMode: 'write' },
    })
  }

  for (const toolName of ['ticket_create', 'agent_ask', 'agent_resolve', 'agent_catalog', 'user_directory']) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
}

async function linkGmailConnectorIfAvailable(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { tenantId: true },
  })
  if (!agent) return

  const gmail = await prisma.connector.findFirst({
    where: {
      type: 'gmail',
      lifecycleState: 'active',
      ...(agent.tenantId
        ? { OR: [{ tenantId: agent.tenantId }, { tenantId: null }] }
        : { tenantId: null }),
    },
    orderBy: [{ tenantId: 'desc' }],
  })
  if (!gmail) return

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: gmail.id } },
    create: { agentId, connectorId: gmail.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })
}

async function ensureToolBrokerSeed(agentId: string) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
  await ensureAgentKnowledgeBase(agent, prisma)

  const board = await upsertConnectorByTypeName(prisma, {
    create: {
      type: 'board',
      name: 'Control Plane Board',
      scope: 'global',
      secretAlias: 'secret://control-plane-board/service-token',
      version: 1,
      config: { ticketStateMachine: true },
    },
    update: {
      config: { ticketStateMachine: true },
    },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: board.id } },
    create: { agentId, connectorId: board.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'board_write' } },
    create: { agentId, toolName: 'board_write', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'ticket_create' } },
    create: { agentId, toolName: 'ticket_create', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'agent_ask' } },
    create: { agentId, toolName: 'agent_ask', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'agent_resolve' } },
    create: { agentId, toolName: 'agent_resolve', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'agent_catalog' } },
    create: { agentId, toolName: 'agent_catalog', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'user_directory' } },
    create: { agentId, toolName: 'user_directory', allowed: true },
    update: { allowed: true },
  })

  for (const toolName of ['gmail_search', 'gmail_get_message', 'mailbox_count', 'gmail_create_draft', 'gmail_send']) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  await linkGmailConnectorIfAvailable(agentId)

  const workspace = await upsertConnectorByTypeName(prisma, {
    create: {
      type: 'workspace',
      name: 'Agent Workspace',
      authMode: 'agent_owned',
      scope: 'global',
      secretAlias: 'platform/gcs-service-account',
      version: 1,
      config: {
        bucket: process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod',
        retentionDays: 30,
      },
    },
    update: {
      authMode: 'agent_owned',
      config: {
        bucket: process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod',
        retentionDays: 30,
      },
    },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: workspace.id } },
    create: { agentId, connectorId: workspace.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })

  for (const toolName of [
    'repo_prepare',
    'repo_open_pull_request',
    'file_read',
    'file_write',
    'file_edit',
    'file_list',
    'file_glob',
    'file_search',
    'file_delete',
    'xlsx_read_sheet',
    'xlsx_write_cells',
    'xlsx_format_range',
    'xlsx_layout',
    'xlsx_create',
    'xlsx_append_rows',
    'docx_read',
    'pdf_read',
    'pdf_create',
    'pptx_create',
  ]) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  // ── Provider CRM (POSnavigator) — generikus http_api connector ──────────────
  const providerCrmConfig = {
    baseUrl: process.env.PROVIDER_CRM_BASE_URL ?? 'https://posnavigator.eu/api/v1',
    auth: { scheme: 'header', header: 'X-Api-Key' },
    description:
      'POSnavigator fizetési szolgáltató mini-CRM. Bankok (fizetési szolgáltatók) CRM-adatai: ' +
      'kapcsolattartók, megállapodások, szerződések, eseménynapló. Minden :bankId/:contactId/:agreementId/:contractId ' +
      'egy 24 hex karakteres MongoDB ObjectId. CRM státuszok: NEW, CONTACTED, MEETING_SCHEDULED, NEGOTIATING, ACTIVE, ON_HOLD, CLOSED_LOST.',
    endpoints: [
      { method: 'GET', path: '/banks', description: 'Banklista CRM összefoglalóval (crm_status, kapcsolat/megállapodás/szerződés számok)' },
      { method: 'GET', path: '/banks/:bankId/crm', description: 'Teljes CRM nézet: bank, contacts, agreements, contracts, utolsó 200 esemény' },
      { method: 'PATCH', path: '/banks/:bankId/crm', description: 'Bank CRM mezők részleges frissítése: crm_status, crm_summary (max 4000), crm_next_action_at (ISO 8601 vagy null)' },
      { method: 'POST', path: '/banks/:bankId/contacts', description: 'Új kapcsolat: name kötelező, email VAGY phone legalább egy; opc. role_title, is_primary, notes' },
      { method: 'PATCH', path: '/banks/:bankId/contacts/:contactId', description: 'Kapcsolat módosítása (részleges)' },
      { method: 'DELETE', path: '/banks/:bankId/contacts/:contactId', description: 'Kapcsolat törlése' },
      { method: 'POST', path: '/banks/:bankId/agreements', description: 'Megállapodás: agreement_type (LEAD_GENERATING|MARKETING|OTHER), title, status (DRAFT|ACTIVE|PAUSED|ENDED)' },
      { method: 'PATCH', path: '/banks/:bankId/agreements/:agreementId', description: 'Megállapodás módosítása' },
      { method: 'DELETE', path: '/banks/:bankId/agreements/:agreementId', description: 'Megállapodás törlése' },
      { method: 'POST', path: '/banks/:bankId/contracts', description: 'Szerződés: title, status (DRAFT|SENT|SIGNED|ACTIVE|EXPIRED|TERMINATED); opc. contract_number (bankon belül egyedi)' },
      { method: 'PATCH', path: '/banks/:bankId/contracts/:contractId', description: 'Szerződés módosítása' },
      { method: 'DELETE', path: '/banks/:bankId/contracts/:contractId', description: 'Szerződés törlése' },
      { method: 'POST', path: '/banks/:bankId/events', description: 'Esemény hozzáfűzése (append-only): event_type, summary, actor_type (USER|API|SYSTEM); opc. actor_id, payload' },
    ],
    restrictToEndpoints: true,
  }

  const providerCrm = await upsertConnectorByTypeName(prisma, {
    create: {
      type: 'http_api',
      name: 'Provider CRM (POSnavigator)',
      authMode: 'service',
      scope: 'global',
      // Az API-kulcs a környezeti változóból oldódik fel — nyers kulcs SOHA nem a DB-ben.
      secretAlias: 'env:PROVIDER_CRM_API_KEY',
      version: 1,
      config: providerCrmConfig,
    },
    update: { config: providerCrmConfig, secretAlias: 'env:PROVIDER_CRM_API_KEY' },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: providerCrm.id } },
    create: { agentId, connectorId: providerCrm.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })

  for (const toolName of ['http_api_get', 'http_api_request']) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
}

// ── Key Management / HSM Officer Asszisztens ─────────────────────────────────

const HSM_ROLE_INSTRUCTION = `Te a Key Management / HSM Officer Asszisztens vagy — Ipoteka Bank kriptográfiai kulcskezelési folyamatainak emberi-kontroll melletti támogatója.

## Szereped

Feladatod az Ipoteka Bank kriptográfiai kulcskezelési folyamatait hibamentesen, szabályosan és auditálhatóan támogatni — elsősorban a Thales payShield 10K HSM-en végzett kulcsceremóniáknál:
- LMK generálás és betöltés
- ZMK/ZPK kulcscsere (pl. Visa/Mastercard kommunikációhoz)
- Kulcs-átadás harmadik félnek
- Kulcs-dekomisszió
- Custodian átadás-átvétel

Ismered a bank teljes kulcskezelési szabályrendszerét, a ceremónia-lépéseket és a payShield konzol-/host-parancsokat. Végigvezeted a Security Officer-eket és a key custodian-okat a műveleteken, gondoskodsz a kettős kontrollról (dual control) és a feladatkör-szétválasztásról (separation of duties), és minden lépést auditálható nyomvonalként dokumentálsz.

**Nem vagy autonóm operátor.** Vezetsz, ellenőrzel és dokumentálsz — de minden HSM-műveletet és kulcsaktiválást ember hajt végre és hagy jóvá.

## Hatókör — PCI hivatkozások

- **PCI DSS v4.0.1 — Requirement 3.6.x**: kriptográfiai kulcsok védelme a tárolt számlaadat (CHD) titkosításához (kulcs-erősség, biztonságos tárolás, kulcs-hozzáférés minimalizálása).
- **PCI DSS v4.0.1 — Requirement 3.7.x**: kulcs-életciklus eljárások — generálás, elosztás, tárolás, csere/rotáció, retirement/lecserélés, gyanús kompromittálás kezelése, kettős kontroll és split knowledge (3.7.6), kulcs-custodian nyilatkozatok (3.7.8).
- **PCI PIN Security — Requirement 18, 28, 29**: kulcskezelés szimmetrikus/aszimmetrikus technikákkal, kulcs-custodian és kulcs-administrátor szerepkörök, dual control / split knowledge a PIN-kulcsokra.

## Kit támogatsz

- **Bank Cybersecurity Department** — kulcskezelési folyamat tulajdonosa
- **Key Custodians + Backup Key Custodians** (min. 2+2)
- **Authorization Officers (AO) + Deputy AO**
- **Security Officer(s)** — ceremónia levezetése, jegyzőkönyv aláírása

## Képességeid

### Ceremónia-levezetés (vezérelt + dokumentáló)
A key-ceremony skill alapján végigvezetsz egy ceremónián:
- Előellenőrzés (résztvevők, szerepkörök, dual control, secure room access, eszköz-állapot)
- Lépésről lépésre a payShield parancsok (pl. VR, FC, GK, CO, DC, LK, LO)
- Minden lépésnél emberi végrehajtás + eredmény rögzítése
- Záró ellenőrzés (boríték-sorszámok, aláírások), majd evidence-jegyzőkönyv generálása

Támogatott ceremónia-típusok:
- lmk_generation (LMK generálás + betöltés): VR → FC → GK → CO → FC → DC → CO → LK → LO
- key_rotation (ZMK/ZPK csere): VR/VK → leltár-azonosítás → GC/GK → FC/export → aktiválás → DK
- key_transfer (komponens-átadás 3. félnek)
- key_decommission (kulcs-megszüntetés)
- custodian_handover (custodian átadás-átvétel)

### Auditálható evidence-generálás
A ceremónia végén előállítasz egy emberi és gépi olvasható jegyzőkönyvet (Markdown + JSON), amely megfelel a Keymanagement requirements v8.docx melléklet-sablonjainak (App. 3, 5, 6, 9, 10, 15) és aláírásra/archiválásra kész.

### Leltár- és lejárat-figyelés
Összevetad a kulcs-leltárt és a kriptográfiai leltárt (Ipoteka_Cryptographic_Inventory_Register) a policy kulcs-lejárati / rotációs szabályaival, és jelzed a közelgő esedékességeket.

### Forrásolt szabály-Q&A
Megválaszolod a kulcskezelési kérdéseket kizárólag forrásolt módon a policy, requirements v8, HSM-manuálok alapján. Forrás nélkül nem adsz ki állítást.

## Tilalmak

- Nem hajtasz végre és nem adsz ki automatikusan HSM-parancsot.
- Nem hozol kulcs-kompromittálási / visszavonási döntést — azt ember hozza meg.
- Nem rögzítesz és nem kérsz be PIN-t, teljes kulcsértéket vagy komponens-titkot.
- Nem léped át a dual control / split knowledge / SoD szabályokat, akkor sem, ha „gyorsabb lenne".
- Nem módosítasz policy-t vagy leltárt emberi jóváhagyás nélkül.`

const HSM_BEHAVIOR_PROFILE = `## Vezérelvek (minden kényelmi szempontot felülírnak)

1. **Emberi kontroll megmarad.** Minden HSM-parancsnál: (a) megmutatod a pontos parancsot és várt eredményt, (b) megvárod az emberi végrehajtást, (c) rögzíted a tényleges eredményt (pl. KCV/check value), (d) ember erősíti meg, hogy egyezik.
2. **Dual control & split knowledge soha nem sérülhet.** Egyetlen személy sem férhet hozzá teljes kulcshoz/LMK-hoz. Minden ceremónia előtt ellenőrzöd: legalább 2 különböző key custodian + AO jelen van-e, és senki nem tölt be ütköző szerepet (SoD).
3. **Evidence-first.** Az értéked nemcsak a levezetés, hanem az auditálható jegyzőkönyv automatikus előállítása: ki, mikor, mit, milyen paranccsal, milyen eredménnyel (KCV, eszköz-sorozatszám, boríték-sorszám, aláírások helye).
4. **Least privilege & teljes naplózás.** Csak olvasási/leíró hozzáférést igénylsz a szükséges rendszerekhez; minden műveleted naplózott.
5. **Nincs titkos anyag a nyomvonalban.** Soha nem rögzítesz PIN-t, teljes kulcsértéket vagy komponenst — kizárólag azonosítókat, KCV/check value-t, sorszámokat, időbélyeget és résztvevőket.
6. **Ha nem vagy biztos, megállsz.** Bizonytalan lépésnél nem találgatsz: a forrás-dokumentumra hivatkozol és emberi döntést kérsz.

## Munkamenet (alap-workflow)

1. **Indítás** — a felhasználó megnevezi a ceremónia típusát (vagy kérdez).
2. **Előellenőrzés (pre-flight)** — résztvevők és szerepkörök, dual control, secure room, eszköz-state. Ha bármi hiányzik → STOP, jelzed mi hiányzik.
3. **Levezetés** — lépésenként: parancs → emberi végrehajtás → eredmény rögzítése → emberi megerősítés. Eltérésnél STOP és eszkaláció.
4. **Lezárás** — boríték-sorszámok, aláírás-helyek, eszköz-sorozatszám rögzítése.
5. **Evidence** — Markdown+JSON jegyzőkönyv generálása, majd leltár-frissítési javaslat (emberi jóváhagyással).

## Lépésenkénti sablon

Minden HSM-lépésnél ezt a sablont kövesd:
\`\`\`
LÉPÉS n/N — <leírás>
Parancs:        <payShield parancs, pl. GK>
Várt eredmény:  <pl. "Device write complete, check: XXXX YY">
→ Kérlek hajtsd végre a HSM-en, majd add meg a tényleges check value-t / eredményt.
\`\`\`

## Hangnem

Magyarul, tömören, lépésre törően. Ceremónia közben rövid, ellenőrzőlista-szerű utasítások. Ha valamivel nem értesz egyet (pl. SoD-kockázat), felvállalod és megindokolod — nem mondasz igent csak a kedvesség kedvéért.`

const HSM_INITIAL_MEMORY = `# Key Management / HSM Officer Asszisztens — tudásbázis

## Intézmény és hatókör
- Megbízó: Ipoteka Bank, Bank Cybersecurity Department
- HSM: Thales payShield 10K (v1.7a firmware)
- Compliance: PCI DSS v4.0.1, PCI PIN Security v3.1, PCI 3DS Core v1.0

## PCI kulcskövetelmények összefoglaló

### PCI DSS 3.6 / 3.7 (kulcs-életciklus)
- 3.6.1: Kulcs-hozzáférés minimalizálása; KEK >= DEK erősség; KEK elkülönítve tárolva
- 3.7.1: Erős kulcs-generálás
- 3.7.2: Biztonságos elosztás — csak felhatalmazott custodianoknak
- 3.7.3: Biztonságos tárolás (HSM-ben; titkos kulcs soha nem forráskódban)
- 3.7.4: Kulcscsere a kriptoperiódus végén (ceremony: key_rotation)
- 3.7.5: Kulcs retirement / replacement / destruction (ceremony: key_decommission)
- 3.7.6: Manuális cleartext kulcsműveletnél: split knowledge ÉS dual control kötelező
- 3.7.7: Jogosulatlan kulcscsere megelőzése (boríték-sorszám ellenőrzés)
- 3.7.8: Custodian formális írásos nyilatkozat (ceremony: custodian_handover)

### PCI PIN Security v3.1
- Req 18: Jogosulatlan csere/visszaélés megelőzése; tamper-jeleket mutató csomag nem használható
- Req 19: Egy kulcs = egy cél; nem osztható meg production és test között
- Req 28: Minden kulcs-adminisztrációs műveletre dokumentált eljárás
- Req 29: HSM csak akkor helyezhető üzembe, ha kompromittálás kizárható (VR ellenőrzés)

## Ceremónia-playbookok

### lmk_generation — LMK generálás és betöltés
Kötelező szerepek: min. 2 Key Custodian + 1 Authorization Officer + 1 Security Officer
Lépések: VR (eszköz-ellenőrzés) → FC (smartcard formázás) → GK (3 LMK komponens generálás) → CO (AO kártyák) → FC (deputy kártyák) → DC (deputy komponens-duplikátum) → CO (deputy AO) → LK (LMK betöltés) → LO (key change storage)
Rögzítendő: serial_number, base_release, card_user_id, component_kcv, lmk_id, lmk_kcv
PCI: 3.6.1, 3.7.1, 3.7.6, PIN Req 18, PIN Req 29

### key_rotation — ZMK/ZPK kulcsrotáció / -csere
Kötelező szerepek: min. 2 KC + 1 AO + 1 SO
Lépések: VR/VK (eszköz + LMK állapot) → leltár-azonosítás (old KCV) → GC/GK (új kulcs generálás) → FC/export (komponensek kártyákra) → aktiválás → DK (régi kulcs törlés)
Rögzítendő: serial_number, old_key_ref, old_key_kcv, new_key_kcv, key_type, new_key_ref
PCI: 3.7.4, 3.6.1, 3.7.6, PIN Req 18, PIN Req 29

### key_transfer — Kulcs-komponens átadás 3. félnek
Kötelező szerepek: min. 2 KC + 1 AO + 1 SO + külső fél képviselője
Pre-flight: Célrendszer és fogadó fél azonosítva; kulcscsere-protokoll meghatározva; tamper-evident borítékok serializálva
Lépések: LMK-állapot → komponens exportálás → boríték-lezárás → átadás-dokumentálás → leltár-frissítés
Biztonsági korlát: SOHA nem adható át a teljes kulcs egyetlen csatornán — split knowledge kötelező

### key_decommission — Kulcs megszüntetés
Kötelező: SO + legalább 1 KC
Lépések: Leltárból azonosítás → DK parancs (HSM-ből törlés) → komponens-megsemmisítés (boríték fizikai megsemmisítés) → leltár lezárás
Rögzítendő: old_key_ref, old_key_kcv, destruction_method, destruction_witness

### custodian_handover — Custodian átadás-átvétel
Célja: Key Custodian pozíció biztonságos átadása új személynek, PCI DSS 3.7.8 nyilatkozattal
Lépések: kinevezési dokumentáció ellenőrzése → komponens-átadás (tamper-evident borítékban) → nyilatkozat aláírása → roster frissítés

## Pre-flight kötelező ellenőrzőlista (minden ceremóniához)
- [ ] Min. 2 különböző Key Custodian + AO + SO jelen, érvényes kinevezéssel
- [ ] Senki nem tölt be ütköző szerepet (SoD — pl. KC1 ≠ AO)
- [ ] Secure room access napló kitöltve
- [ ] HSM secure state-be kapcsolva (két fizikai kulcs)
- [ ] VR parancs futtatva: firmware/serial egyezik vendor-adattal, tamper OK
- [ ] Elegendő üres smartcard + serializált tamper-evident boríték rendelkezésre áll
Ha bármi hiányzik → NE indítsd a ceremóniát!

## Eszközök és erőforrások
- Kulcs-leltár: inventory/Key inventory_Ipoteka_to_continue.xlsx (Ref.Num, Key name, type, exp., strength, KCV, creation date, storage, usage)
- Kripto-leltár: Ipoteka_Cryptographic_Inventory_Register_v1.1.xlsx (CIR-001…, PCI scope mapping)
- Strukturált séma: inventory/model/key_inventory.schema.json + key_inventory.json
- Policy: knowledge/policy/Key_Management_Policy_Main-01.docx
- Követelmények: knowledge/policy/Keymanagement requirements v8.docx (21 melléklet)
- HSM-manuálok: Thales payShield 10K Security Operations V1.7a, Console Guide V1.7a
- Sablonok: templates/ (Commissioning_10K.docx, Hand-Take-over.docx, AO/KC-appointment.docx)

## Ismert SoD-konfliktusok a jelenlegi custodian rosterben
⚠️ A roster 2 MAGAS súlyosságú SoD-konfliktust tartalmaz — ezeket a ceremónia előtt kötelező ellenőrizni és feloldani. Lásd: inventory/model/custodian_roster.json + prototype/roster_check.py

## Evidence-sablon (minden ceremónia zárásakor)
Kötelező mezők: ceremony_type, ceremony_id, date, location, hsm_serial, participants[]{name, role, signature_place}, steps[]{n, command, executed_by, timestamp, result_kcv, note}, envelopes[]{ref, custodian}, closeout_notes
Tilos mezők: PIN, teljes kulcsérték, komponens-titok`

const HSM_KEY_CEREMONY_RECIPE_CONTENT = {
  name: 'key-ceremony',
  version: 1,
  ticket_type: 'interaction',
  description:
    'Kulcsceremónia végigvezetése a Thales payShield 10K HSM-en. Kettős kontroll és split knowledge kikényszerítése, lépésenkénti emberi végrehajtás, auditálható evidence-generálás.',
  parameters: ['ticket_id', 'ceremony_type', 'agent_version'],
  trigger_keywords: [
    'kulcsceremónia',
    'LMK generálás',
    'kulcscsere',
    'key rotation',
    'ZMK',
    'ZPK',
    'custodian átadás',
    'key transfer',
    'dekomisszió',
    'HSM',
  ],
  instructions: [
    'Azonosítsd a ceremónia típusát a ticket payloadból (lmk_generation / key_rotation / key_transfer / key_decommission / custodian_handover).',
    'Töltsd be a kapcsolódó playbook configot (ceremony_type alapján).',
    'Futtasd a pre-flight ellenőrzést: kérdezz rá a résztvevőkre (min. 2 KC + AO + SO), ellenőrizd a SoD-ot, secure room hozzáférést és az eszköz-állapotot. Ha bármi hiányzik → STOP.',
    'Vezess végig lépésenkénti levezetést a sablon alapján: LÉPÉS n/N — parancs — várt eredmény — emberi megerősítés. Minden lépésnél várd meg a tényleges eredményt (KCV/check value).',
    'Rögzítsd minden lépésnél: parancs, végrehajtó személy, időbélyeg, eredmény (KCV), megjegyzés. Eltérésnél STOP és eszkaláció a Security Officer felé.',
    'Hajtsd végre a lezárást: boríték-sorszámok, eszköz-sorozatszám, dátum, helyszín, aláírás-helyek kijelölése.',
    'Generálj auditálható evidence-dokumentumot (Markdown + JSON) a kötelező mezőkkel: ceremony_type, ceremony_id, date, location, hsm_serial, participants, steps, envelopes, closeout_notes. SOHA ne rögzíts PIN-t vagy teljes kulcsértéket.',
    'Javasolj leltár-frissítést az új kulcs felvételéhez (Ref.Num, Key name, type, strength, KCV, creation date, storage, usage) — csak emberi jóváhagyással írható be.',
    'Írd vissza az eredményt a board_write eszközzel: { ceremony_id, ceremony_type, status, evidence_ref, inventory_update_proposal }.',
  ],
  tools: ['kb_search', 'board_write', 'file_read', 'file_write', 'xlsx_read_sheet'],
  output_schema: {
    ceremony_id: 'string (UUID)',
    ceremony_type: 'enum[lmk_generation, key_rotation, key_transfer, key_decommission, custodian_handover]',
    status: 'enum[completed, aborted, awaiting_human]',
    evidence_ref: 'string (file path)',
    inventory_update_proposal: 'object | null',
  },
  safety_constraints: [
    'SOHA ne adj ki HSM-parancsot automatikusan.',
    'SOHA ne rögzíts PIN-t, teljes kulcsértéket vagy komponens-titkot.',
    'Dual control / split knowledge / SoD soha nem sérülhet.',
    'Eltérésnél STOP + eszkaláció, ne folytasd.',
  ],
}

async function ensureHSMOfficerAgent(adminId: string) {
  const existing = await prisma.agent.findFirst({
    where: { name: 'Key Management / HSM Officer Asszisztens' },
  })
  if (existing) {
    console.log('  HSM Officer Agent already exists — skipping')
    await ensureToolBrokerSeed(existing.id)
    await ensureChatToolsForAgent(existing.id)
    await ensureWebSearchSeed(existing.id)
    return existing
  }

  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: HSM_INITIAL_MEMORY,
      status: 'active',
      source: 'seed',
      approvedById: adminId,
    },
  })
  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    temperature: 0.1,
    maxTokens: 8192,
  }

  const agent = await prisma.agent.create({
    data: {
      name: 'Key Management / HSM Officer Asszisztens',
      roleInstruction: HSM_ROLE_INSTRUCTION,
      behaviorProfile: HSM_BEHAVIOR_PROFILE,
      behaviorProfileOverlay: HSM_BEHAVIOR_PROFILE,
      modelConfig,
      status: 'active',
      role: 'worker',
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: HSM_ROLE_INSTRUCTION,
      behaviorProfileSnapshot: HSM_BEHAVIOR_PROFILE,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  // Policy resources
  const pciPolicy = await prisma.resource.create({
    data: {
      type: 'policy',
      name: 'Key Management Policy — Ipoteka Bank',
      scope: 'single',
      version: 1,
      dataRef: '01_Key_Management_HSM_Officer/knowledge/policy/Key_Management_Policy_Main-01.docx',
    },
  })
  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: pciPolicy.id, accessMode: 'read' },
  })

  const pciRequirements = await prisma.resource.create({
    data: {
      type: 'policy',
      name: 'Keymanagement requirements v8 — Ipoteka Bank',
      scope: 'single',
      version: 1,
      dataRef: '01_Key_Management_HSM_Officer/knowledge/policy/Keymanagement requirements v8.docx',
    },
  })
  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: pciRequirements.id, accessMode: 'read' },
  })

  const pciDssStandard = await prisma.resource.create({
    data: {
      type: 'dataset',
      name: 'KEY_MGMT_REQUIREMENTS_EXTRACT.md — PCI kivonatok',
      scope: 'single',
      version: 1,
      dataRef: '01_Key_Management_HSM_Officer/knowledge/standards/KEY_MGMT_REQUIREMENTS_EXTRACT.md',
    },
  })
  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: pciDssStandard.id, accessMode: 'read' },
  })

  const keyInventory = await prisma.resource.create({
    data: {
      type: 'dataset',
      name: 'Key inventory — Ipoteka (élő leltár)',
      scope: 'single',
      version: 1,
      dataRef: '01_Key_Management_HSM_Officer/inventory/Key inventory_Ipoteka_to_continue.xlsx',
    },
  })
  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: keyInventory.id, accessMode: 'read' },
  })

  const cryptoInventory = await prisma.resource.create({
    data: {
      type: 'dataset',
      name: 'Ipoteka Cryptographic Inventory Register v1.1',
      scope: 'single',
      version: 1,
      dataRef:
        '01_Key_Management_HSM_Officer/inventory/Ipoteka_Cryptographic_Inventory_Register_v1.1.xlsx',
    },
  })
  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: cryptoInventory.id, accessMode: 'read' },
  })

  // Key-ceremony recipe
  let hsmRecipe = await prisma.recipe.findFirst({ where: { name: 'key-ceremony' } })
  if (!hsmRecipe) {
    hsmRecipe = await prisma.recipe.create({
      data: {
        name: 'key-ceremony',
        ticketType: 'interaction',
        scope: 'single',
        versions: {
          create: {
            version: 1,
            content: HSM_KEY_CEREMONY_RECIPE_CONTENT,
            status: 'active',
            approvedById: adminId,
          },
        },
      },
    })
  }

  const activeRecipeVersion = await prisma.recipeVersion.findFirst({
    where: { recipeId: hsmRecipe.id, status: 'active' },
    orderBy: { version: 'desc' },
  })

  if (activeRecipeVersion) {
    await prisma.agentVersion.updateMany({
      where: { agentId: agent.id, version: 1, recipeVersionId: null },
      data: { recipeVersionId: activeRecipeVersion.id },
    })
  }

  await ensureToolBrokerSeed(agent.id)
  await ensureChatToolsForAgent(agent.id)

  // Extra capabilities: xlsx + docx olvasás az inventory és sablonokhoz
  for (const toolName of [
    'xlsx_read_sheet',
    'xlsx_write_cells',
    'xlsx_format_range',
    'xlsx_layout',
    'xlsx_create',
    'xlsx_append_rows',
    'pptx_create',
    'docx_read',
    'pdf_read',
    'file_read',
    'file_write',
    'file_list',
  ]) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId: agent.id, toolName } },
      create: { agentId: agent.id, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  await ensureWebSearchSeed(agent.id)

  console.log('  HSM Officer Agent:', agent.id)
  return agent
}

/**
 * F2-WS-A: kontrollált webes keresés — platform-managed `agent_owned` connector
 * banking_strict preset-tel (Feature-spec — WebSearchTool §3.1-§3.2, D-WS-2/D-WS-4).
 * Csak hivatalos/szabályozói/scheme domainek allowlistelve; `allowGeneralWeb=false`,
 * `logRawQuery=false` (csak hash kerül auditba). Orchestrator SOHA nem kaphat
 * capability sort — ezt csak worker agentekhez kötjük.
 */
async function ensureWebSearchSeed(agentId: string) {
  const config = {
    provider: 'stub',
    allowedDomains: [
      '*.gov.hu',
      '*.mnb.hu',
      'mnb.hu',
      '*.europa.eu',
      '*.visa.com',
      '*.mastercard.com',
      'docs.stripe.com',
    ],
    deniedDomains: ['pastebin.com', '*.onion'],
    defaultLocale: 'hu-HU',
    defaultRegion: 'HU',
    defaultMaxResults: 5,
    hardMaxResults: 10,
    maxQueryLength: 500,
    maxQueriesPerTicket: 10,
    maxQueriesPerAgentDay: 100,
    allowGeneralWeb: false,
    safeSearch: 'strict',
    logRawQuery: false,
    retentionDays: 90,
    requireHumanApprovalForSensitiveQuery: false,
  }

  const connector = await upsertConnectorByTypeName(prisma, {
    create: {
      type: 'web_search',
      name: 'Controlled Web Search (banking_strict)',
      authMode: 'agent_owned',
      scope: 'global',
      tenantId: null,
      secretAlias: 'platform/web-search-provider-key',
      version: 1,
      config,
      lifecycleState: 'active',
    },
    update: { config, tenantId: null },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: connector.id } },
    create: { agentId, connectorId: connector.id, accessMode: 'read' },
    update: { accessMode: 'read' },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'web_search' } },
    create: { agentId, toolName: 'web_search', allowed: true },
    update: { allowed: true },
  })
}

const WIKI_PLAYBOOK_SPEC = [
  {
    ticket_type: 'interaction',
    role: 'worker',
    required_gates: [
      {
        gate: 'human_approval',
        blocks: [{ from: 'in_progress', to: 'done' }],
        unless_payload: { field: 'confidence', equals: 'high' },
      },
    ],
  },
]

const WIKI_RECIPE_CONTENT = {
  name: 'wiki-answer',
  version: 1,
  ticket_type: 'interaction',
  description: 'Belső tudásbázisból citált, magyar nyelvű választ ad.',
  parameters: ['ticket_id', 'agent_version'],
  instructions: [
    'Olvasd be a kérdést a ticket payloadból.',
    'Keress a tudásbázisban a kb_search eszközzel (max 6 találat).',
    'KIZÁRÓLAG a megtalált forrásokra támaszkodva válaszolj, magyarul, tömören.',
    'MINDEN állítás mellé tedd a forráshivatkozást (docId + szakasz).',
    'Ha a források nem fedik le a kérdést, mondd ki: "nincs elég forrás", és NE találj ki tényt.',
    'Írd vissza az eredményt a board_write eszközzel: { answer, sources[], rationale }.',
    'Ha a válasz kifelé menő vagy bizonytalan, a ticketet hagyd awaiting_human állapotban.',
  ],
  tools: ['kb_search', 'board_write'],
  output_schema: {
    answer: 'string',
    sources: '[{ docId: string, sectionRef: string }]',
    rationale: 'string',
    confidence: 'enum[high, medium, low]',
  },
}

async function ensureWikiPlaybook(approverId: string) {
  let playbook = await prisma.playbook.findFirst({ where: { name: 'wiki-interaction' } })
  if (!playbook) {
    playbook = await prisma.playbook.create({
      data: {
        name: 'wiki-interaction',
        processType: 'wiki_qa',
        versions: {
          create: {
            version: 1,
            spec: WIKI_PLAYBOOK_SPEC,
            status: 'active',
            approvedById: approverId,
          },
        },
      },
    })
  }

  const activeVersion = await prisma.playbookVersion.findFirst({
    where: { playbookId: playbook.id, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!activeVersion) {
    const version = await prisma.playbookVersion.create({
      data: {
        playbookId: playbook.id,
        version: 1,
        spec: WIKI_PLAYBOOK_SPEC,
        status: 'active',
        approvedById: approverId,
      },
    })
    return version
  }
  return activeVersion
}

// wiki-answer recipe (§6) — aktív v1, az agent aktuális verziójához kötve (reprodukálhatóság).
async function ensureWikiRecipe(agentId: string, approverId: string) {
  let recipe = await prisma.recipe.findFirst({ where: { name: 'wiki-answer' } })
  if (!recipe) {
    recipe = await prisma.recipe.create({
      data: {
        name: 'wiki-answer',
        ticketType: 'interaction',
        scope: 'single',
        versions: {
          create: {
            version: 1,
            content: WIKI_RECIPE_CONTENT,
            status: 'active',
            approvedById: approverId,
          },
        },
      },
    })
  }

  const activeVersion = await prisma.recipeVersion.findFirst({
    where: { recipeId: recipe.id, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!activeVersion) return

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) return

  await prisma.agentVersion.updateMany({
    where: { agentId, version: agent.currentVersion, recipeVersionId: null },
    data: { recipeVersionId: activeVersion.id },
  })
}

/**
 * Skill-katalógus demo seed (skill-catalog-spec.md, WP-1). Két GLOBAL T0/T1
 * skill aktív, aláírt verzióval — a katalógus és a hozzárendelés UI-hoz.
 * Idempotens (név alapján). A verzió aláírása a runtime signSkillVersion-nel
 * egyezik (reprodukálhatóság, D12).
 */
async function ensureDemoSkills(approverId: string) {
  const demos: Array<{
    name: string
    description: string
    riskTier: 't0' | 't1'
    content: SkillContent
    requires: SkillRequirement[]
  }> = [
    {
      name: 'reconciliation-checklist',
      description:
        'Bankszámla-egyeztetés lépésről lépésre: kivonat betöltése, tételpárosítás, eltérés-jelentés. Instrukció-only (T0).',
      riskTier: 't0',
      content: {
        instructions: [
          '# Cél\nAdott időszakra egyeztesd a banki kivonatot a főkönyvi tételekkel, és jelezd az eltéréseket.',
          '## Lépések\n1. Töltsd be a kivonatot és a főkönyvi kivonatot.\n2. Párosítsd a tételeket dátum + összeg alapján.\n3. A nem párosított tételeket listázd külön, indoklással.\n4. Készíts rövid egyeztetési összefoglalót.',
        ],
        triggerKeywords: ['egyeztetés', 'reconciliation', 'kivonat'],
        parameters: [],
      },
      requires: [],
    },
    {
      name: 'kb-answer-helper',
      description:
        'Tudásbázis-alapú válaszadás: a jóváhagyott KB-ból keres és idézettel válaszol. Tool-igény: kb_search (T1).',
      riskTier: 't1',
      content: {
        instructions: [
          '# Cél\nKérdésre kizárólag a jóváhagyott tudásbázis alapján válaszolj, forrás-megjelöléssel.',
          '## Munkamenet\n1. Fogalmazd át a kérdést keresési kulcsszavakká.\n2. Keress a tudásbázisban (kb_search).\n3. Csak a talált forrásokra támaszkodva válaszolj; ha nincs elég információ, mondd ki.',
        ],
        triggerKeywords: ['tudásbázis', 'kb', 'válasz'],
        parameters: [],
      },
      requires: [{ toolName: 'kb_search', reason: 'Tudásbázis-keresés a válaszhoz' }],
    },
  ]

  for (const demo of demos) {
    const existing = await prisma.skill.findFirst({
      where: { name: demo.name, tenantId: null },
    })
    if (existing) continue

    const contentHash = computeSkillContentHash(demo.content, demo.requires)
    const skill = await prisma.skill.create({
      data: {
        name: demo.name,
        description: demo.description,
        catalogScope: 'global',
        tenantId: null,
        sourceType: 'authored',
        provenance: { origin: 'authored', format: 'seed' },
        license: null,
        riskTier: demo.riskTier,
        versions: {
          create: {
            version: 1,
            content: demo.content as unknown as object,
            requires: demo.requires as unknown as object,
            contentHash,
            status: 'active',
            approvedById: approverId,
          },
        },
      },
      include: { versions: true },
    })

    const version = skill.versions[0]
    const signature = signSkillVersion({
      skillVersionId: version.id,
      contentHash,
      approverId,
    })
    await prisma.skillVersion.update({
      where: { id: version.id },
      data: { signature },
    })
  }
}

// Friss demó API-kulcs az agentnek + lokális fájlba írás (acceptance + kézi teszt).
async function ensureDemoApiKey(agentId: string) {
  const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
  await prisma.agentApiKey.create({
    data: {
      agentId,
      keyHash: await bcrypt.hash(rawKey, 10),
      scopes: ['ticket:read', 'ticket:create', 'tool:invoke'],
      status: 'active',
    },
  })
  await writeFile(KEY_FILE, rawKey, 'utf8')
  console.log('  Demo API key (dev only): saved to .seed-demo-api-key')
}

/**
 * Tenant-Management §11.1 dev seed: a `demo` tenant + tenant-admin/tag membershipek
 * + egy dev-superadmin platform-membership. Idempotens (upsert). A `getAuthContext`
 * ezekből a membershipekből oldja fel az aktív tenantot, a tenant-switcher pedig
 * innen kapja a választható tenantokat.
 */
async function ensureDemoTenant(
  admin: { id: string },
  approver: { id: string },
  operator: { id: string },
) {
  await prisma.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {},
    create: {
      id: DEMO_TENANT_ID,
      slug: 'demo',
      displayName: 'Demo (Excellence Pay)',
      legalName: 'Excellence Pay',
      status: 'active',
      domainAllowlist: [],
      settings: {},
      createdById: admin.id,
    },
  })

  const demoGmail = await ensureTenantGmailConnector(prisma, DEMO_TENANT_ID)
  console.log('  Demo Gmail connector (provisioned template):', demoGmail.id)

  const memberships: Array<{ userId: string; role: 'admin' | 'approver' | 'operator' }> = [
    { userId: admin.id, role: 'admin' },
    { userId: approver.id, role: 'approver' },
    { userId: operator.id, role: 'operator' },
  ]
  for (const m of memberships) {
    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: DEMO_TENANT_ID, userId: m.userId } },
      update: {},
      create: {
        tenantId: DEMO_TENANT_ID,
        userId: m.userId,
        role: m.role,
        status: 'active',
        isDefault: true,
        activatedAt: new Date(),
      },
    })
  }

  // Dev-superadmin: a platform-felület tesztelhetőségéhez (NEM automatikus admin→superadmin).
  await prisma.platformMembership.upsert({
    where: { userId_role: { userId: admin.id, role: 'superadmin' } },
    update: { status: 'active' },
    create: { userId: admin.id, role: 'superadmin', status: 'active' },
  })

  console.log('Seed: demo tenant + membershipek + dev-superadmin kész')
}

async function main() {
  // §3.5: a két beépített rendszer-szintű szerep-sablon (worker | orchestrator).
  await ensureSystemRoleTemplates(prisma)

  // IAM/RBAC §3.3: deklaratív permission-mátrix — deny-by-default a hiányzó kulcsra.
  await ensureDefaultRolePermissions()

  // A `status` alapértéke pending (deny-by-default, IAM/RBAC spec N-IAM-2/3) —
  // a bootstrap-felhasználókat explicit `active`-ra állítjuk, különben senki nem tudna belépni.
  const admin = await prisma.user.upsert({
    where: { externalAuthId: 'seed-admin' },
    create: {
      externalAuthId: 'seed-admin',
      email: 'admin@excellence.ai',
      name: 'Platform Admin',
      role: 'admin',
      status: 'active',
      activatedAt: new Date(),
    },
    update: {},
  })

  const approver = await prisma.user.upsert({
    where: { externalAuthId: 'seed-approver' },
    create: {
      externalAuthId: 'seed-approver',
      email: 'approver@excellence.ai',
      name: 'Kovács Anna',
      role: 'approver',
      status: 'active',
      activatedAt: new Date(),
    },
    update: {},
  })

  const operator = await prisma.user.upsert({
    where: { externalAuthId: 'seed-operator' },
    create: {
      externalAuthId: 'seed-operator',
      email: 'operator@excellence.ai',
      name: 'Nagy Péter',
      role: 'operator',
      status: 'active',
      activatedAt: new Date(),
    },
    update: {},
  })

  void admin
  void approver
  void operator

  // Tenant-Management §11.1: demo tenant + membershipek + dev-superadmin.
  await ensureDemoTenant(admin, approver, operator)

  // Minta proaktív monitor (Feature-spec — Proactive Monitor, PM-A DoD).
  // LLM-mentes deadline-figyelő: a 24 órán belül esedékes, le nem zárt due_by
  // ticketekre nyit monitor_alert tickettet a boardon. escalateAgentId=null →
  // nulla token; a 2. lépcső csak ticket-nyitás.
  const existingMonitor = await prisma.monitorDefinition.findFirst({
    where: { title: 'Határidő-figyelő (24h)' },
  })
  if (!existingMonitor) {
    await prisma.monitorDefinition.create({
      data: {
        tenantId: DEMO_TENANT_ID,
        kind: 'deadline',
        title: 'Határidő-figyelő (24h)',
        description: 'Közelgő (24h-n belüli), le nem zárt határidős ticketek figyelése.',
        intervalSeconds: 3600,
        nextSweepAt: new Date(),
        collectorConfig: { windowHours: 24 },
        filterConfig: { field: 'severity', cmp: '>=', value: 50 },
        cooldownSeconds: 86_400,
        dedupKeyTemplate: 'deadline:{ticketId}',
        openTicketType: 'monitor_alert',
        createdById: admin.id,
      },
    })
    console.log('Seed: minta deadline-monitor létrehozva')
  }

  const existingAgent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
  if (existingAgent) {
    console.log('Seed already applied (Wiki Agent exists) — demó API-kulcs frissítése')
    await ensureToolBrokerSeed(existingAgent.id)
    await ensureBookkeeperAgent(admin.id)
    await ensureHSMOfficerAgent(admin.id)
    const provisioningAssistant = await ensureProvisioningAssistantAgent(admin.id)
    const webEgressAgent = await ensureWebEgressRoleAgent(admin.id)
    const playbookAuthorAgent = await ensurePlaybookAuthorAgent(admin.id)
    const allAgents = await prisma.agent.findMany({ select: { id: true } })
    for (const row of allAgents) {
      // A provisioning-asszisztens, a web-egress role és a Playbook-szerző agent
      // least-privilege: NEM kapnak chat/board eszközjogot (§6.1/§8.1/WP-10), csak a
      // szűk capability-osztályukat (a Playbook-szerzőnek egyáltalán nincs is).
      if (row.id === provisioningAssistant.id || row.id === webEgressAgent.id || row.id === playbookAuthorAgent.id) continue
      await ensureChatToolsForAgent(row.id)
    }
    await ensureWikiRecipe(existingAgent.id, admin.id)
    await ensureWikiPlaybook(admin.id)
    await ensureDemoApiKey(existingAgent.id)
    await ensureBuiltinConnectorTemplates()
    await ensureGlobalCustomConnectorTemplates()
    await ensureDemoSkills(admin.id)
    return
  }

  const memory = await prisma.memory.create({ data: {} })

  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: INITIAL_MEMORY,
      status: 'active',
      source: 'seed',
      approvedById: admin.id,
    },
  })

  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = {
    provider: 'chatgpt-oauth',
    model: 'chatgpt-oauth-default',
    temperature: 0.2,
    maxTokens: 4096,
  }

  const agent = await prisma.agent.create({
    data: {
      name: 'Wiki Agent',
      roleInstruction: WIKI_ROLE_INSTRUCTION,
      behaviorProfile: WIKI_BEHAVIOR_PROFILE,
      behaviorProfileOverlay: WIKI_BEHAVIOR_PROFILE,
      modelConfig,
      status: 'active',
      role: 'worker',
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: WIKI_ROLE_INSTRUCTION,
      behaviorProfileSnapshot: WIKI_BEHAVIOR_PROFILE,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  const policy = await prisma.resource.create({
    data: {
      type: 'policy',
      name: 'Excellence Pay belső tudásbázis',
      scope: 'global',
      version: 1,
      dataRef: 'knowledge/excellence-pay-internal-v1.md',
    },
  })

  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: policy.id, accessMode: 'read' },
  })

  await ensureToolBrokerSeed(agent.id)
  await ensureBookkeeperAgent(admin.id)
  await ensureHSMOfficerAgent(admin.id)
  await ensureProvisioningAssistantAgent(admin.id)
  await ensureWebEgressRoleAgent(admin.id)
  await ensurePlaybookAuthorAgent(admin.id)
  await ensureWikiRecipe(agent.id, admin.id)
  await ensureWikiPlaybook(admin.id)
  await ensureDemoSkills(admin.id)
  await ensureDemoApiKey(agent.id)
  await ensureBuiltinConnectorTemplates()
  await ensureGlobalCustomConnectorTemplates()
  await ensureStarterStepTemplates(prisma)

  console.log('Seed complete')
  console.log('  Wiki Agent:', agent.id)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
