'use server'

/**
 * Admin-facing server actions a Fázis 2 Playbook Registry-hez
 * (Feature-spec — Playbook §8.1, §9.1, §11.1). A draft létrehozás/version admin jog;
 * publish/reject approver jog (§11.2 four-eyes: a jóváhagyó ≠ készítő — ezt a service
 * kényszeríti ki). A validáció/compile determinisztikus a service-rétegben.
 */
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import {
  createPlaybookV2Schema,
  playbookV2IdSchema,
  createPlaybookVersionV2Schema,
  updatePlaybookVersionV2Schema,
  updatePlaybookMetaSchema,
  playbookVersionV2IdSchema,
  rejectPlaybookVersionV2Schema,
  assignPlaybookV2Schema,
  draftPlaybookFromDescriptionSchema,
} from '@/lib/validators/actions'
import { PlaybookV2Error } from '@/domain/playbook/playbook-v2-service'
import { parsePlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import { readTenantLanguage } from '@/lib/tenant-language'
import { PlaybookCompiler, type CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { PlaybookSimulator } from '@/domain/playbook/playbook-simulator'
import { diffPlaybookSpecs } from '@/domain/playbook/playbook-diff'
import { exportPlaybookPack, importPlaybookPack } from '@/domain/playbook/playbook-pack'
import { evaluatePlaybookAdvance } from '@/lib/playbook-v2/runtime'
import { prisma } from '@/lib/db'
import { listPublishedStepTemplates } from '@/domain/step-template/step-template-catalog'
import { createStepTemplate } from '@/domain/step-template/step-template-service'
import { PLAYBOOK_AUTHOR_TEMPLATE } from '@/domain/playbook/playbook-author-agent'
import { PLAYBOOK_CAPABILITY_NAMES } from '@/lib/tool-capability-catalog'
import type { PlaybookV2, PlaybookVersionV2 } from '@prisma/client'
import { errorPolicySchema } from '@/lib/playbook-v2/spec'
import { z } from 'zod'

export type ProcessBuilderPlaybookVersionView = {
  playbookId: string
  playbookName: string
  processType: string
  playbookVersionId: string
  version: number
  agentRoles: { key: string; requiredCapabilities: string[] }[]
  humanRoles: { key: string; requiredPermissions: string[] }[]
  configSlots: { name: string; type: string; required: boolean; description: string | null }[]
  triggerSlots: { name: string; type: string; required: boolean; description: string | null }[]
}

function toProcessBuilderPlaybookVersionView(
  playbook: Pick<PlaybookV2, 'id' | 'name' | 'processType'>,
  version: Pick<PlaybookVersionV2, 'id' | 'version' | 'spec'>,
): ProcessBuilderPlaybookVersionView {
  const spec = parsePlaybookSpecV2(version.spec)
  const configSlots = new Map<
    string,
    { name: string; type: string; required: boolean; description: string | null }
  >()
  const triggerSlots = new Map<
    string,
    { name: string; type: string; required: boolean; description: string | null }
  >()

  for (const step of spec.steps) {
    for (const slot of step.inputSlots ?? []) {
      const target = slot.source === 'config' ? configSlots : triggerSlots
      if (!target.has(slot.name)) {
        target.set(slot.name, {
          name: slot.name,
          type: slot.type,
          required: slot.required,
          description: slot.description ?? null,
        })
      }
    }
  }

  return {
    playbookId: playbook.id,
    playbookName: playbook.name,
    processType: playbook.processType,
    playbookVersionId: version.id,
    version: version.version,
    agentRoles: spec.roles
      .filter((role) => role.type === 'agent_role')
      .map((role) => ({
        key: role.key,
        requiredCapabilities: role.requiredCapabilities ?? [],
      })),
    humanRoles: spec.roles
      .filter((role) => role.type === 'human_role')
      .map((role) => ({
        key: role.key,
        requiredPermissions: role.requiredPermissions ?? [],
      })),
    configSlots: Array.from(configSlots.values()),
    triggerSlots: Array.from(triggerSlots.values()),
  }
}

export async function listPlaybooksV2() {
  try {
    const user = await requireTenantRole('viewer')
    const playbooks = await services.playbooksV2.listPlaybooks(user.activeTenantId, {
      includeVersions: 'none',
      limit: 50,
    })
    return ok(
      playbooks.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        processType: p.processType,
        status: p.status,
        currentPublishedVersionId: p.currentPublishedVersionId,
        versionCount: p.versionCount ?? p.versions.length,
        updatedAt: p.updatedAt.toISOString(),
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a Playbookokat')
  }
}

export async function getPlaybookV2(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = playbookV2IdSchema.parse(input)
    const { playbook, versions } = await services.playbooksV2.getPlaybook(user.activeTenantId, parsed.id)
    return ok({
      playbook: {
        id: playbook.id,
        key: playbook.key,
        name: playbook.name,
        description: playbook.description,
        processType: playbook.processType,
        status: playbook.status,
        currentPublishedVersionId: playbook.currentPublishedVersionId,
      },
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        changeSummary: v.changeSummary,
        contentHash: v.contentHash,
        validationResult: v.validationResult,
        spec: v.spec,
        layout: v.layout,
        createdById: v.createdById,
        approvedById: v.approvedById,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        createdAt: v.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a Playbookot')
  }
}

export async function createPlaybookV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createPlaybookV2Schema.parse(input)
    const playbook = await services.playbooksV2.createPlaybook({
      tenantId: user.activeTenantId,
      key: parsed.key,
      name: parsed.name,
      description: parsed.description ?? null,
      processType: parsed.processType,
      ownerUserId: user.user.id,
      actorUserId: user.user.id,
    })
    return ok({ id: playbook.id })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a Playbookot')
  }
}

export async function updatePlaybookMetaV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updatePlaybookMetaSchema.parse(input)
    await services.playbooksV2.updatePlaybookMeta({
      tenantId: user.activeTenantId,
      playbookId: parsed.playbookId,
      name: parsed.name,
      description: parsed.description ?? null,
      actorUserId: user.user.id,
    })
    return ok(null)
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a Playbookot')
  }
}

export async function createPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createPlaybookVersionV2Schema.parse(input)
    const { version, validation } = await services.playbooksV2.createPlaybookVersion({
      tenantId: user.activeTenantId,
      playbookId: parsed.playbookId,
      spec: parsed.spec,
      changeSummary: parsed.changeSummary,
      layout: parsed.layout,
      actorUserId: user.user.id,
    })
    return ok({ versionId: version.id, version: version.version, validation })
  } catch (e) {
    if (e instanceof PlaybookV2Error) {
      return fail(`${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ''}`)
    }
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a verziót')
  }
}

/**
 * Playbook-szerző agent (Feature-spec — Playbook-Role-Agent-Binding §5.A, §6, WP-10).
 * NL leírás → validált (vagy hibás, de mindig visszacsatolt) Playbook-spec draft.
 * PROPOSE-NOT-APPLY: ez az action NEM ír a DB-be. A visszaadott spec-et a hívó a
 * meglévő `createPlaybookVersionV2`/`updatePlaybookVersionV2` action-nel menti draftként —
 * a szerző-agent sosem publikál.
 */
export async function draftPlaybookFromDescription(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = draftPlaybookFromDescriptionSchema.parse(input)

    const agents = await repositories.agents.findMany({ tenantId: user.activeTenantId })
    // A Playbook Author globális (tenantId=null) agent — ha a tenant-szűrt listában nincs,
    // külön keressük, mert a findMany exact-match szűr tenantId-ra.
    const author =
      agents.find((a) => a.name === PLAYBOOK_AUTHOR_TEMPLATE.name) ??
      (await repositories.agents.findMany()).find((a) => a.name === PLAYBOOK_AUTHOR_TEMPLATE.name)
    if (!author) {
      return fail('A Playbook-szerző agent nincs seedelve. Futtasd: npm run db:seed.')
    }

    // Kényelmi capability-szótár: a katalógus szerinti Playbook capability-k + a tenant
    // agentjein ténylegesen látott extra capability-k. A Playbook requiredCapabilities
    // bővebb, mint az agent-szerkesztő normál Tool Broker katalógusa, mert szerep-specifikus
    // zárt capability-stringeket is tartalmazhat.
    const capabilitySets = await Promise.all(
      agents.map((a) => repositories.toolBroker.findCapabilitiesForAgent(a.id)),
    )
    const knownCapabilities = [
      ...new Set(
        [
          ...PLAYBOOK_CAPABILITY_NAMES,
          ...capabilitySets.flat().filter((c) => c.allowed).map((c) => c.toolName),
        ],
      ),
    ]
    const permissions = await repositories.rolePermissions.findAll()
    const knownPermissions = permissions.map((p) => p.permissionKey)

    const tenant = await repositories.tenants.findById(user.activeTenantId!)
    const outputLanguage = readTenantLanguage(tenant?.settings)

    const agentInput = {
      agentId: author.id,
      agentVersion: author.currentVersion,
      agentModelConfig: author.modelConfig,
      tenantId: user.activeTenantId,
      knownCapabilities,
      knownPermissions,
      outputLanguage,
    }

    // Első generálás
    let result = await services.playbookAuthorAgent.draftSpec({
      ...agentInput,
      description: parsed.description,
      existingSpec: parsed.existingSpec,
      priorValidation: parsed.priorValidation,
    })
    if (!result.ok) {
      return fail(`${result.error}: ${result.detail}`)
    }

    // Auto-fix loop: legfeljebb 3 körben javítja a validációs hibákat
    const AUTO_FIX_ROUNDS = 3
    let fixRounds = 0
    while (result.validation.errors.length > 0 && fixRounds < AUTO_FIX_ROUNDS) {
      fixRounds++
      const fix = await services.playbookAuthorAgent.draftSpec({
        ...agentInput,
        description: '',
        existingSpec: result.spec,
        priorValidation: result.validation,
      })
      if (!fix.ok) break
      result = fix
    }

    const autoFixFailed = fixRounds === AUTO_FIX_ROUNDS && result.validation.errors.length > 0
    return ok({ spec: result.spec, validation: result.validation, fixRounds, autoFixFailed })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült Playbook-draftot generálni')
  }
}

export async function updatePlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updatePlaybookVersionV2Schema.parse(input)
    const { version, validation } = await services.playbooksV2.updateDraftPlaybookVersion({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      spec: parsed.spec,
      changeSummary: parsed.changeSummary,
      layout: parsed.layout,
      actorUserId: user.user.id,
    })
    return ok({ versionId: version.id, version: version.version, validation })
  } catch (e) {
    if (e instanceof PlaybookV2Error) {
      return fail(`${e.message}${e.details ? ` — ${JSON.stringify(e.details)}` : ''}`)
    }
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a verziót')
  }
}

export async function validatePlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const validation = await services.playbooksV2.validatePlaybookVersion({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      actorUserId: user.user.id,
    })
    return ok(validation)
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült validálni a verziót')
  }
}

export async function submitPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const version = await services.playbooksV2.submitForApproval({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      actorUserId: user.user.id,
    })
    return ok({ status: version.status })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült jóváhagyásra küldeni')
  }
}

export async function publishPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const version = await services.playbooksV2.publishPlaybookVersion({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      approverUserId: user.user.id,
    })
    return ok({ status: version.status })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült publikálni a verziót')
  }
}

export async function rejectPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = rejectPlaybookVersionV2Schema.parse(input)
    const version = await services.playbooksV2.rejectPlaybookVersion({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      approverUserId: user.user.id,
      reason: parsed.reason,
    })
    return ok({ status: version.status })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült elutasítani a verziót')
  }
}

export async function assignPlaybookV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = assignPlaybookV2Schema.parse(input)
    const assignment = await services.playbooksV2.assignPlaybook({
      tenantId: user.activeTenantId,
      playbookVersionId: parsed.playbookVersionId,
      assignmentType: parsed.assignmentType,
      assignmentKey: parsed.assignmentKey,
      isDefault: parsed.isDefault,
      actorUserId: user.user.id,
    })
    return ok({ id: assignment.id })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült hozzárendelni a Playbookot')
  }
}

/** StepTemplate katalógus a Canvas palettájához (published globális + tenant, WP-3). */
export async function listStepTemplates() {
  try {
    const user = await requireTenantRole('admin')
    const items = await listPublishedStepTemplates(prisma, user.activeTenantId)
    return ok(items)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a lépés-sablonokat')
  }
}

/** Indítható (published) Playbookok process-type szerint — az operator start űrlaphoz. */
export async function listStartablePlaybooks() {
  try {
    const user = await requireTenantRole('operator')
    return ok(await services.playbooksV2.listStartablePlaybooks(user.activeTenantId))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni az indítható Playbookokat')
  }
}

/** Publikált Playbook-verziók Folyamat-összeállításhoz. */
export async function listPublishedPlaybookVersionsForProcessBuilder() {
  try {
    const user = await requireTenantRole('operator')
    const playbooks = await services.playbooksV2.listPlaybooks(user.activeTenantId, {
      includeVersions: 'all',
      unbounded: true,
    })
    return ok(
      playbooks.flatMap((playbook) =>
        playbook.versions
          .filter((version) => version.status === 'published')
          .map((version) => toProcessBuilderPlaybookVersionView(playbook, version)),
      ),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a publikált Playbook-verziókat')
  }
}

/**
 * PIN-elt Playbook-verziók Folyamat-szerkesztéshez — bármely státusz (pl. retired),
 * mert a Folyamat a létrehozáskor rögzített verzióra hivatkozik.
 */
export async function listPlaybookVersionsForProcessDefinitionEditing(playbookVersionIds: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = z.array(z.string().uuid()).parse(playbookVersionIds)
    const tenantId = user.activeTenantId
    const uniqueIds = [...new Set(parsed)]
    const views: ProcessBuilderPlaybookVersionView[] = []

    for (const id of uniqueIds) {
      const version = await repositories.playbooksV2.findVersion(tenantId, id)
      if (!version) continue
      const playbook = await repositories.playbooksV2.findPlaybook(tenantId, version.playbookId)
      if (!playbook) continue
      views.push(toProcessBuilderPlaybookVersionView(playbook, version))
    }

    return ok(views)
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : 'Nem sikerült betölteni a Folyamathoz PIN-elt Playbook-verziókat',
    )
  }
}

// --- Governed Flow Builder: WP-4 Simulation / WP-5 Diff / WP-6 Pack ----------

const compilerSingleton = new PlaybookCompiler()
const simulatorSingleton = new PlaybookSimulator()

/** A verzió compiled specje (pin-elt), vagy friss fordítás, ha még nincs. */
function compiledOf(version: { spec: unknown; compiledSpec: unknown; id: string }): CompiledSpec {
  if (version.compiledSpec && typeof version.compiledSpec === 'object') {
    return version.compiledSpec as CompiledSpec
  }
  return compilerSingleton.compile(parsePlaybookSpecV2(version.spec), { playbookVersionId: version.id })
}

/**
 * WP-4 — szimbolikus dry-run egy Playbook-verzión. A `roleBindings` / `roleCapabilities`
 * vagy a hívótól jön, vagy — ha `processDefinitionId` van megadva — egy már létező
 * Folyamat kötéseiből töltődik be (annak `roleBindings`-e + a kötött agentek tényleges
 * capability-i a tool brokeren át). Üresen a hiányzó-role/capability findingokat mutatja.
 * NEM ír éles rendszerbe, nem hív LLM-et (D4).
 */
export async function simulatePlaybookVersionV2(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = z
      .object({
        playbookVersionId: z.string().uuid(),
        processDefinitionId: z.string().uuid().optional(),
        sampleInput: z.record(z.string(), z.unknown()).optional(),
        roleBindings: z.record(z.string(), z.string().nullable()).optional(),
        roleCapabilities: z.record(z.string(), z.array(z.string())).optional(),
      })
      .parse(input)
    const version = await repositories.playbooksV2.findVersion(user.activeTenantId, parsed.playbookVersionId)
    if (!version) return fail('A Playbook-verzió nem található.')
    const spec = parsePlaybookSpecV2(version.spec)

    let roleBindings = parsed.roleBindings ?? {}
    let roleCapabilities = parsed.roleCapabilities ?? {}
    if (parsed.processDefinitionId) {
      const processDefinition = await repositories.processDefinitions.findById(
        user.activeTenantId,
        parsed.processDefinitionId,
      )
      if (!processDefinition) return fail('A kiválasztott Folyamat nem található.')
      if (processDefinition.playbookVersionId !== parsed.playbookVersionId) {
        return fail('A kiválasztott Folyamat egy másik Playbook-verzióra van PIN-elve.')
      }
      roleBindings = { ...(processDefinition.roleBindings as Record<string, string | null>), ...roleBindings }
      const derivedCapabilities: Record<string, string[]> = {}
      for (const [roleKey, agentId] of Object.entries(roleBindings)) {
        if (!agentId) continue
        const capabilities = await repositories.toolBroker.findCapabilitiesForAgent(agentId)
        derivedCapabilities[roleKey] = capabilities.filter((c) => c.allowed).map((c) => c.toolName)
      }
      roleCapabilities = { ...derivedCapabilities, ...roleCapabilities }
    }

    const report = simulatorSingleton.simulate({
      spec,
      compiled: compiledOf(version),
      roleBindings,
      roleCapabilities,
      sampleInput: parsed.sampleInput ?? {},
    })
    return ok(report)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a szimuláció')
  }
}

/** WP-8 — pure branch-preview: a Canvas/Simulation ugyanazt az ágat adja, mint a runtime. */
export async function previewPlaybookAdvanceV2(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = z
      .object({
        playbookVersionId: z.string().uuid(),
        stepId: z.string().min(1),
        samplePayload: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(input)
    const version = await repositories.playbooksV2.findVersion(user.activeTenantId, parsed.playbookVersionId)
    if (!version) return fail('A Playbook-verzió nem található.')
    return ok(evaluatePlaybookAdvance(compiledOf(version), parsed.stepId, parsed.samplePayload ?? {}))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a branch-előnézet')
  }
}

/** WP-5 — risk-weighted verzió-diff két verzió spec-je között (layout-független). */
export async function diffPlaybookVersionsV2(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = z
      .object({ baseVersionId: z.string().uuid(), targetVersionId: z.string().uuid() })
      .parse(input)
    const tenantId = user.activeTenantId
    const base = await repositories.playbooksV2.findVersion(tenantId, parsed.baseVersionId)
    const target = await repositories.playbooksV2.findVersion(tenantId, parsed.targetVersionId)
    if (!base || !target) return fail('Az egyik verzió nem található.')
    const diff = diffPlaybookSpecs(parsePlaybookSpecV2(base.spec), parsePlaybookSpecV2(target.spec))
    return ok({
      diff,
      base: { version: base.version, contentHash: base.contentHash },
      target: { version: target.version, contentHash: target.contentHash },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a verzió-diff')
  }
}

/** WP-6 — egy Playbook publikált (vagy legfrissebb) verziójának pack-export (csak template). */
export async function exportPlaybookPackV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = playbookV2IdSchema.parse(input)
    const { playbook, versions } = await services.playbooksV2.getPlaybook(user.activeTenantId, parsed.id)
    const chosen =
      versions.find((v) => v.id === playbook.currentPublishedVersionId) ??
      versions.find((v) => v.status === 'published') ??
      versions[0]
    if (!chosen) return fail('A Playbookhoz nincs verzió.')
    const pack = exportPlaybookPack({
      playbooks: [{ key: playbook.key, name: playbook.name, spec: parsePlaybookSpecV2(chosen.spec) }],
      metadata: { title: playbook.name, author: user.user.id, description: playbook.description ?? undefined },
    })
    return ok(pack)
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült a pack-export')
  }
}

/**
 * WP-6 — pack-import ELŐNÉZET (validate → map). SOHA nem élesít automatikusan (D9):
 * ez csak a validációs eredményt adja vissza; a tényleges létrehozás külön, jóváhagyott lépés.
 */
export async function importPlaybookPackPreviewV2(input: unknown) {
  try {
    await requireTenantRole('admin')
    const parsed = z.object({ pack: z.unknown() }).parse(input)
    return ok(importPlaybookPack(parsed.pack))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a pack-import előnézet')
  }
}

/**
 * WP-6 — pack-import APPLY (validate → map → approve → apply). A jóváhagyott packből
 * DRAFT Playbook(oka)t + verziót és tenant-scoped DRAFT StepTemplate-eket hoz létre.
 * SOHA nem publikál/élesít (D9): a publish/approval a meglévő külön lánc. A tenant-
 * specifikus értékek (secret, connector-grant, role-binding) NEM a pack részei — ezek
 * import után kitöltendő konfigurációként jelennek meg (a connector-template-eket kézzel
 * kell a connector-katalógusba importálni). A név/kulcs ütközést a mapping oldja fel.
 */
export async function importPlaybookPackApplyV2(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        pack: z.unknown(),
        playbookMappings: z
          .array(z.object({ sourceKey: z.string(), targetKey: z.string().min(2), targetName: z.string().min(1) }))
          .optional(),
        stepTemplateMappings: z
          .array(z.object({ sourceKey: z.string(), targetKey: z.string().min(2), targetName: z.string().min(1) }))
          .optional(),
      })
      .parse(input)

    const imported = importPlaybookPack(parsed.pack)
    if (!imported.valid) {
      return fail(`A pack nem érvényes: ${imported.errors.join(' ')}`)
    }

    const tenantId = user.activeTenantId
    const pbMap = new Map((parsed.playbookMappings ?? []).map((m) => [m.sourceKey, m]))
    const stMap = new Map((parsed.stepTemplateMappings ?? []).map((m) => [m.sourceKey, m]))

    const createdPlaybooks: Array<{ key: string; playbookId: string; versionId: string }> = []
    const createdStepTemplates: Array<{ key: string; id: string }> = []
    const itemErrors: string[] = []

    for (const p of imported.playbooks) {
      const mapping = pbMap.get(p.key)
      const key = mapping?.targetKey ?? p.key
      const name = mapping?.targetName ?? p.name
      try {
        const spec = parsePlaybookSpecV2(p.spec)
        const playbook = await services.playbooksV2.createPlaybook({
          tenantId,
          key,
          name,
          description: `Pack import: ${imported.metadata?.title ?? ''}`.trim(),
          processType: spec.processType,
          actorUserId: user.user.id,
        })
        const { version } = await services.playbooksV2.createPlaybookVersion({
          tenantId,
          playbookId: playbook.id,
          spec,
          changeSummary: `Pack import (${imported.metadata?.title ?? 'pack'})`,
          actorUserId: user.user.id,
        })
        createdPlaybooks.push({ key, playbookId: playbook.id, versionId: version.id })
      } catch (e) {
        itemErrors.push(`Playbook '${key}': ${e instanceof Error ? e.message : 'ismeretlen hiba'}`)
      }
    }

    for (const st of imported.stepTemplates) {
      const mapping = stMap.get(st.key)
      const key = mapping?.targetKey ?? st.key
      const name = mapping?.targetName ?? st.name
      try {
        const res = await createStepTemplate(prisma, { tenantId, key, name, fragment: st.fragment })
        createdStepTemplates.push({ key, id: res.id })
      } catch (e) {
        itemErrors.push(`Sablon '${key}': ${e instanceof Error ? e.message : 'ismeretlen hiba'}`)
      }
    }

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'playbook.pack.import',
      targetType: 'playbook_pack',
      targetId: null,
      modelUsed: null,
      inputRef: imported.metadata?.title ?? null,
      outputRef: null,
      policyDecision: 'imported_as_draft',
      metadata: {
        playbooks: String(createdPlaybooks.length),
        stepTemplates: String(createdStepTemplates.length),
        errors: String(itemErrors.length),
      },
      tenantId,
    })

    return ok({
      createdPlaybooks,
      createdStepTemplates,
      itemErrors,
      // Connector-template-ek NEM importálódnak automatikusan — manuális follow-up.
      connectorTemplatesPending: imported.connectorTemplates.length,
      warnings: imported.warnings,
    })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült a pack-import alkalmazása')
  }
}

// --- Hibapolicy spec §4.2/WP-4 — tenant-default hibaág admin-beállítása -------------------

export async function getTenantDefaultErrorPolicyAction() {
  try {
    const user = await requireTenantRole('viewer')
    const policy = await services.platformSettings.getTenantDefaultErrorPolicy(user.activeTenantId)
    return ok(policy ?? {})
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült lekérdezni a tenant hibapolicy-t')
  }
}

export async function setTenantDefaultErrorPolicyAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    if (!user.activeTenantId) {
      return fail('Platform-szintű (tenant nélküli) kontextusban nem állítható be tenant-default hibapolicy.')
    }
    const parsed = errorPolicySchema.parse(input)
    const policy = await services.platformSettings.setTenantDefaultErrorPolicy(
      user.activeTenantId,
      parsed,
      user.user.id,
    )
    return ok(policy)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült beállítani a tenant hibapolicy-t')
  }
}
