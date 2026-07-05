'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { fail, ok } from '@/lib/result'
import { SandboxVersionError } from '@/domain/sandbox-versioning/errors'
import type { SandboxActor, SandboxRole } from '@/domain/sandbox-versioning/sandbox-versioning-service'

/**
 * Server actions a Sandbox verziózás / promóció / graduation Control Plane
 * felülethez (SandboxVersioning-Graduation §4, §9). A go-live jóváhagyás és a
 * graduation-export EMBER-only kemény padló (§6.3/§7.3) — a service kikényszeríti,
 * itt csak a session-alapú aktort adjuk át. A `contentRef` `inline:`/`workspace:`
 * sémájú (a File Editor-előkészített tartalomhoz).
 */

function actorOf(user: Awaited<ReturnType<typeof requireTenantRole>>): SandboxActor {
  return { userId: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole as SandboxRole }
}

function toFail(e: unknown, fallback: string) {
  if (e instanceof SandboxVersionError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

export async function listSandboxProjects() {
  try {
    const user = await requireTenantRole('viewer')
    const projects = await services.sandboxVersioning.listSandboxProjects(
      {},
      actorOf(user),
    )
    return ok(projects)
  } catch (e) {
    return toFail(e, 'Nem sikerült listázni a projekteket')
  }
}

const createProjectSchema = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(2000).optional(),
  sandboxId: z.string().optional(),
})

export async function createSandboxProject(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = createProjectSchema.parse(input)
    const res = await services.sandboxVersioning.createSandboxProject(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a projektet')
  }
}

export async function getSandboxProjectDetail(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const { projectId } = z.object({ projectId: z.string() }).parse(input)
    const actor = actorOf(user)
    const [history, promotions, snapshots] = await Promise.all([
      services.sandboxVersioning.getSandboxHistory({ projectId }, actor),
      services.sandboxVersioning.listPromotions({ projectId }, actor),
      services.sandboxVersioning.listDataSnapshots({ projectId }, actor),
    ])
    return ok({ history, promotions, snapshots })
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni a projektet')
  }
}

const commitSchema = z.object({
  projectId: z.string(),
  changeSummary: z.string().min(1),
  files: z
    .array(z.object({ path: z.string().min(1), contentRef: z.string().min(1) }))
    .min(1),
  createdFromTicketId: z.string().optional(),
})

export async function createSandboxCommit(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = commitSchema.parse(input)
    const res = await services.sandboxVersioning.createSandboxCommit(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült commitolni')
  }
}

export async function diffSandboxCommits(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const data = z
      .object({ projectId: z.string(), fromCommitId: z.string(), toCommitId: z.string() })
      .parse(input)
    const res = await services.sandboxVersioning.diffSandboxCommits(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a diff')
  }
}

export async function rollbackSandboxCode(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z
      .object({ projectId: z.string(), toCommitId: z.string(), reason: z.string().min(1) })
      .parse(input)
    const res = await services.sandboxVersioning.rollbackSandboxCode(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a rollback')
  }
}

export async function requestPromotion(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z.object({ projectId: z.string(), reason: z.string().optional() }).parse(input)
    const res = await services.sandboxVersioning.requestPromotion(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a promóció-kérés')
  }
}

export async function approvePromotion(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z
      .object({
        promotionId: z.string(),
        decision: z.enum(['approve', 'reject']),
        reason: z.string().optional(),
      })
      .parse(input)
    const res = await services.sandboxVersioning.approvePromotion(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a jóváhagyás')
  }
}

export async function createDataSnapshot(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z
      .object({ projectId: z.string(), env: z.enum(['test', 'live']), label: z.string().optional() })
      .parse(input)
    const res = await services.sandboxVersioning.createDataSnapshot(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a snapshot')
  }
}

export async function restoreDataSnapshot(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z
      .object({
        projectId: z.string(),
        snapshotId: z.string(),
        targetEnv: z.enum(['test', 'live']),
        reason: z.string().min(1),
      })
      .parse(input)
    const res = await services.sandboxVersioning.restoreDataSnapshot(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült a restore')
  }
}

export async function requestSandboxExport(input: unknown) {
  try {
    const user = await requireTenantRole('operator')
    const data = z
      .object({
        projectId: z.string(),
        scope: z.enum(['code_only', 'code_and_schema', 'full']),
        sourceCommitId: z.string().optional(),
        sourceSnapshotId: z.string().optional(),
        markResponsibilityTransfer: z.boolean().optional(),
      })
      .parse(input)
    const res = await services.sandboxVersioning.requestExport(data, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült az export')
  }
}

export async function getSandboxExport(input: unknown) {
  try {
    const user = await requireTenantRole('viewer')
    const { exportId } = z.object({ exportId: z.string() }).parse(input)
    const res = await services.sandboxVersioning.getExport({ exportId }, actorOf(user))
    return ok(res)
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az exportot')
  }
}
