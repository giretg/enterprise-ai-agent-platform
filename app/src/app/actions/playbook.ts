'use server'

/**
 * Admin-facing server actions a Fázis 2 Playbook Registry-hez
 * (Feature-spec — Playbook §8.1, §9.1, §11.1). A draft létrehozás/version admin jog;
 * publish/reject approver jog (§11.2 four-eyes: a jóváhagyó ≠ készítő — ezt a service
 * kényszeríti ki). A validáció/compile determinisztikus a service-rétegben.
 */
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { fail, ok } from '@/lib/result'
import {
  createPlaybookV2Schema,
  playbookV2IdSchema,
  createPlaybookVersionV2Schema,
  playbookVersionV2IdSchema,
  rejectPlaybookVersionV2Schema,
  assignPlaybookV2Schema,
} from '@/lib/validators/actions'
import { PlaybookV2Error } from '@/domain/playbook/playbook-v2-service'

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
    const playbooks = await services.playbooksV2.listPlaybooks(tenantOf(user))
    const startable = playbooks
      .filter((p) => p.status === 'published' && p.currentPublishedVersionId)
      .map((p) => {
        const published = p.versions.find((v) => v.id === p.currentPublishedVersionId)
        return {
          playbookId: p.id,
          name: p.name,
          processType: p.processType,
          publishedVersionId: p.currentPublishedVersionId!,
          version: published?.version ?? null,
        }
      })
    return ok(startable)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni az indítható Playbookokat')
  }
}
