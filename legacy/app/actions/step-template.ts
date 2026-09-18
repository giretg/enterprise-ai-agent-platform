'use server'

/**
 * StepTemplate admin CRUD server-actionök (Governed Flow Builder WP-3, §6).
 * Minden mutáció admin jog + audit. A globális (seed) template-ek read-only-k a
 * tenant-adminnak — az ownership-check a domain-service `requireEditable`-jében dől el.
 */
import { requireTenantRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  listStepTemplatesForAdmin,
  createStepTemplate,
  updateStepTemplate,
  publishStepTemplate,
  retireStepTemplate,
  deleteStepTemplate,
  setStepTemplateEvalSamples,
  certifyStepTemplateVersion,
  StepTemplateError,
} from '@/domain/step-template/step-template-service'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

const fragmentSchema = z.object({
  step: z.record(z.string(), z.unknown()),
  suggestedGate: z.record(z.string(), z.unknown()).nullable().optional(),
})

const evalSampleSchema = z.object({
  sampleInput: z.record(z.string(), z.unknown()).default({}),
  expectations: z.array(z.string()).default([]),
})

function toMessage(e: unknown, fallback: string): string {
  if (e instanceof StepTemplateError) return e.message
  return e instanceof Error ? e.message : fallback
}

async function audit(
  tenantId: string,
  actorId: string,
  action:
    | 'step_template.create'
    | 'step_template.version.create'
    | 'step_template.publish'
    | 'step_template.retire'
    | 'step_template.delete'
    | 'step_template.certify',
  targetId: string | null,
  metadata: Record<string, string>,
) {
  await repositories.audit.append({
    actorType: 'human',
    actorId,
    agentVersion: null,
    action,
    targetType: 'step_template',
    targetId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: null,
    metadata,
    tenantId,
  })
}

export async function listStepTemplatesAdmin() {
  try {
    const user = await requireTenantRole('admin')
    return ok(await listStepTemplatesForAdmin(prisma, user.activeTenantId))
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült betölteni a lépés-sablonokat'))
  }
}

export async function createStepTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        key: z
          .string()
          .min(2)
          .regex(/^[a-z0-9-]+$/, 'A kulcs csak kisbetű, szám és kötőjel lehet.'),
        name: z.string().min(2),
        description: z.string().optional(),
        category: z.string().optional(),
        fragment: fragmentSchema,
      })
      .parse(input)
    const res = await createStepTemplate(prisma, {
      tenantId: user.activeTenantId,
      key: parsed.key,
      name: parsed.name,
      description: parsed.description,
      category: parsed.category,
      fragment: parsed.fragment,
    })
    await audit(user.activeTenantId, user.user.id, 'step_template.create', res.id, { key: parsed.key })
    revalidatePath('/control-plane/step-templates')
    return ok(res)
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült létrehozni a sablont'))
  }
}

export async function updateStepTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        id: z.string().uuid(),
        name: z.string().min(2).optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        fragment: fragmentSchema.optional(),
      })
      .parse(input)
    const res = await updateStepTemplate(prisma, { tenantId: user.activeTenantId, ...parsed })
    if (res.newVersionId) {
      await audit(user.activeTenantId, user.user.id, 'step_template.version.create', parsed.id, {
        versionId: res.newVersionId,
      })
    }
    revalidatePath('/control-plane/step-templates')
    return ok(res)
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült frissíteni a sablont'))
  }
}

export async function publishStepTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { id } = z.object({ id: z.string().uuid() }).parse(input)
    const res = await publishStepTemplate(prisma, id, user.activeTenantId)
    await audit(user.activeTenantId, user.user.id, 'step_template.publish', id, {
      publishedVersionId: res.publishedVersionId,
    })
    revalidatePath('/control-plane/step-templates')
    return ok(res)
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült publikálni a sablont'))
  }
}

export async function retireStepTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { id } = z.object({ id: z.string().uuid() }).parse(input)
    await retireStepTemplate(prisma, id, user.activeTenantId)
    await audit(user.activeTenantId, user.user.id, 'step_template.retire', id, {})
    revalidatePath('/control-plane/step-templates')
    return ok({ id })
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült visszavonni a sablont'))
  }
}

export async function deleteStepTemplateAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { id } = z.object({ id: z.string().uuid() }).parse(input)
    await deleteStepTemplate(prisma, id, user.activeTenantId)
    await audit(user.activeTenantId, user.user.id, 'step_template.delete', id, {})
    revalidatePath('/control-plane/step-templates')
    return ok({ id })
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült törölni a sablont'))
  }
}

export async function setStepTemplateEvalSamplesAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        id: z.string().uuid(),
        versionId: z.string().uuid(),
        evalSamples: z.array(evalSampleSchema),
      })
      .parse(input)
    const res = await setStepTemplateEvalSamples(prisma, {
      tenantId: user.activeTenantId,
      ...parsed,
    })
    revalidatePath('/control-plane/step-templates')
    return ok(res)
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült menteni az eval-mintákat'))
  }
}

export async function certifyStepTemplateVersionAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z.object({ id: z.string().uuid(), versionId: z.string().uuid() }).parse(input)
    const res = await certifyStepTemplateVersion(prisma, {
      tenantId: user.activeTenantId,
      ...parsed,
    })
    await audit(user.activeTenantId, user.user.id, 'step_template.certify', parsed.id, {
      versionId: parsed.versionId,
    })
    revalidatePath('/control-plane/step-templates')
    return ok(res)
  } catch (e) {
    return fail(toMessage(e, 'Nem sikerült certifikálni a verziót'))
  }
}
