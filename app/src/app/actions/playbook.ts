'use server'

/**
 * Admin-facing server actions a Fázis 2 Playbook Registry-hez
 * (Feature-spec — Playbook §8.1, §9.1, §11.1). A draft létrehozás/version admin jog;
 * publish/reject approver jog (§11.2 four-eyes: a jóváhagyó ≠ készítő — ezt a service
 * kényszeríti ki). A validáció/compile determinisztikus a service-rétegben.
 */
import { requireRole } from '@/auth'
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
import { PLAYBOOK_AUTHOR_TEMPLATE } from '@/domain/playbook/playbook-author-agent'

type AuthedUser = Awaited<ReturnType<typeof requireRole>>
function tenantOf(user: AuthedUser): string {
  return user.tenantId ?? user.id
}

export async function listPlaybooksV2() {
  try {
    const user = await requireRole('viewer')
    const playbooks = await services.playbooksV2.listPlaybooks(tenantOf(user))
    return ok(
      playbooks.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        processType: p.processType,
        status: p.status,
        currentPublishedVersionId: p.currentPublishedVersionId,
        versionCount: p.versions.length,
        updatedAt: p.updatedAt.toISOString(),
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a Playbookokat')
  }
}

export async function getPlaybookV2(input: unknown) {
  try {
    const user = await requireRole('viewer')
    const parsed = playbookV2IdSchema.parse(input)
    const { playbook, versions } = await services.playbooksV2.getPlaybook(tenantOf(user), parsed.id)
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
    const user = await requireRole('admin')
    const parsed = createPlaybookV2Schema.parse(input)
    const playbook = await services.playbooksV2.createPlaybook({
      tenantId: tenantOf(user),
      key: parsed.key,
      name: parsed.name,
      description: parsed.description ?? null,
      processType: parsed.processType,
      ownerUserId: user.id,
      actorUserId: user.id,
    })
    return ok({ id: playbook.id })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a Playbookot')
  }
}

export async function updatePlaybookMetaV2(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = updatePlaybookMetaSchema.parse(input)
    await services.playbooksV2.updatePlaybookMeta({
      tenantId: tenantOf(user),
      playbookId: parsed.playbookId,
      name: parsed.name,
      description: parsed.description ?? null,
      actorUserId: user.id,
    })
    return ok(null)
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a Playbookot')
  }
}

export async function createPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = createPlaybookVersionV2Schema.parse(input)
    const { version, validation } = await services.playbooksV2.createPlaybookVersion({
      tenantId: tenantOf(user),
      playbookId: parsed.playbookId,
      spec: parsed.spec,
      changeSummary: parsed.changeSummary,
      actorUserId: user.id,
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
    const user = await requireRole('admin')
    const parsed = draftPlaybookFromDescriptionSchema.parse(input)

    const agents = await repositories.agents.findMany({ tenantId: user.tenantId ?? null })
    const author = agents.find((a) => a.name === PLAYBOOK_AUTHOR_TEMPLATE.name)
    if (!author) {
      return fail('A Playbook-szerző agent nincs seedelve. Futtasd: npm run db:seed.')
    }

    // Kényelmi capability-szótár: a tenant agentjeinek ténylegesen engedélyezett tool-jai —
    // a szerep requiredCapabilities-e csak ezekből választhat (a validátor ezt kényszeríti ki).
    const capabilitySets = await Promise.all(
      agents.map((a) => repositories.toolBroker.findCapabilitiesForAgent(a.id)),
    )
    const knownCapabilities = [
      ...new Set(
        capabilitySets.flat().filter((c) => c.allowed).map((c) => c.toolName),
      ),
    ]

    const result = await services.playbookAuthorAgent.draftSpec({
      agentId: author.id,
      agentVersion: author.currentVersion,
      agentModelConfig: author.modelConfig,
      tenantId: user.tenantId,
      description: parsed.description,
      knownCapabilities,
      existingSpec: parsed.existingSpec,
      priorValidation: parsed.priorValidation,
    })
    if (!result.ok) {
      return fail(`${result.error}: ${result.detail}`)
    }
    return ok({ spec: result.spec, validation: result.validation })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült Playbook-draftot generálni')
  }
}

export async function updatePlaybookVersionV2(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = updatePlaybookVersionV2Schema.parse(input)
    const { version, validation } = await services.playbooksV2.updateDraftPlaybookVersion({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      spec: parsed.spec,
      changeSummary: parsed.changeSummary,
      actorUserId: user.id,
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
    const user = await requireRole('admin')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const validation = await services.playbooksV2.validatePlaybookVersion({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      actorUserId: user.id,
    })
    return ok(validation)
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült validálni a verziót')
  }
}

export async function submitPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireRole('admin')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const version = await services.playbooksV2.submitForApproval({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      actorUserId: user.id,
    })
    return ok({ status: version.status })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült jóváhagyásra küldeni')
  }
}

export async function publishPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireRole('approver')
    const parsed = playbookVersionV2IdSchema.parse(input)
    const version = await services.playbooksV2.publishPlaybookVersion({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      approverUserId: user.id,
    })
    return ok({ status: version.status })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült publikálni a verziót')
  }
}

export async function rejectPlaybookVersionV2(input: unknown) {
  try {
    const user = await requireRole('approver')
    const parsed = rejectPlaybookVersionV2Schema.parse(input)
    const version = await services.playbooksV2.rejectPlaybookVersion({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      approverUserId: user.id,
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
    const user = await requireRole('admin')
    const parsed = assignPlaybookV2Schema.parse(input)
    const assignment = await services.playbooksV2.assignPlaybook({
      tenantId: tenantOf(user),
      playbookVersionId: parsed.playbookVersionId,
      assignmentType: parsed.assignmentType,
      assignmentKey: parsed.assignmentKey,
      isDefault: parsed.isDefault,
      actorUserId: user.id,
    })
    return ok({ id: assignment.id })
  } catch (e) {
    if (e instanceof PlaybookV2Error) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Nem sikerült hozzárendelni a Playbookot')
  }
}

/** Indítható (published) Playbookok process-type szerint — az operator start űrlaphoz. */
export async function listStartablePlaybooks() {
  try {
    const user = await requireRole('operator')
    return ok(await services.playbooksV2.listStartablePlaybooks(tenantOf(user)))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni az indítható Playbookokat')
  }
}

/** Publikált Playbook-verziók Folyamat-összeállításhoz. */
export async function listPublishedPlaybookVersionsForProcessBuilder() {
  try {
    const user = await requireRole('operator')
    const playbooks = await services.playbooksV2.listPlaybooks(tenantOf(user))
    return ok(
      playbooks.flatMap((playbook) =>
        playbook.versions
          .filter((version) => version.status === 'published')
          .map((version) => {
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
              configSlots: Array.from(configSlots.values()),
              triggerSlots: Array.from(triggerSlots.values()),
            }
          }),
      ),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a publikált Playbook-verziókat')
  }
}
