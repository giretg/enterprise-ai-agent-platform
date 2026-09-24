'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { fail, ok, type ActionResult } from '@/lib/result'
import type { ProjectListItem, MemoryView } from '@/domain/project-work/project-work-service'

const projectKeySchema = z.string().min(1).max(120)
const filePathSchema = z.string().min(1).max(500)

const listFilesSchema = z.object({ projectKey: projectKeySchema })
const readFileSchema = z.object({ projectKey: projectKeySchema, path: filePathSchema })
const saveFileSchema = z.object({
  projectKey: projectKeySchema,
  path: filePathSchema,
  content: z.string().max(200_000),
})
const deleteFileSchema = z.object({ projectKey: projectKeySchema, path: filePathSchema })

const agentIdSchema = z.object({ agentId: z.string().uuid() })
const listMemorySchema = agentIdSchema.extend({ projectKey: projectKeySchema })
const saveMemorySchema = agentIdSchema.extend({
  projectKey: projectKeySchema,
  kind: z.enum(['decision', 'open_task', 'finding', 'constraint', 'artifact', 'handoff_summary']),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8_000),
  artifactPath: z.string().trim().max(500).optional(),
  replaceId: z.string().uuid().optional(),
})

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  key: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
})

export type WorkFileListItem = { path: string; byteSize: number; updatedAt: string }

function mapActionError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError && error.code === 'INSUFFICIENT_ROLE') {
    return fail('approver_not_authorized')
  }
  if (error instanceof TenantAuthError) return fail(error.code)
  if (error instanceof z.ZodError) return fail('invalid_args')
  return fail('schema_mismatch')
}

async function scopedAgent(agentId: string, tenantId: string) {
  return repositories.agents.findById(agentId, tenantId)
}

export async function listWorkProjectsAction(): Promise<ActionResult<{ projects: ProjectListItem[] }>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const projects = await services.projectWork.service.listProjects(ctx.activeTenantId)
    return ok({ projects })
  } catch (error) {
    return mapActionError(error)
  }
}

export async function createWorkProjectAction(
  input: z.infer<typeof createProjectSchema>,
): Promise<ActionResult<{ project: ProjectListItem }>> {
  try {
    const parsed = createProjectSchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const created = await services.projectWork.service.createProject({
      tenantId: ctx.activeTenantId,
      name: parsed.name,
      key: parsed.key?.trim() ? parsed.key.trim() : undefined,
      description: parsed.description?.trim() ? parsed.description.trim() : undefined,
      createdById: ctx.user.id,
    })
    if (!created.ok) return fail(created.code)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'project.create',
      targetType: 'project',
      // AuditLog.target_id is UUID; projectKey is a slug (`__general__`, `ugyfel-x`).
      targetId: null,
      modelUsed: null,
      inputRef: created.project.name,
      outputRef: null,
      policyDecision: 'created',
      metadata: { key: created.project.key },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/projects')
    return ok({ project: created.project })
  } catch (error) {
    return mapActionError(error)
  }
}

export async function listWorkFilesAction(
  input: z.infer<typeof listFilesSchema>,
): Promise<ActionResult<{ files: WorkFileListItem[] }>> {
  try {
    const parsed = listFilesSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const listed = await services.projectWork.service.listFiles({
      tenantId: ctx.activeTenantId,
      projectKey: parsed.projectKey,
    })
    if (!listed.ok) return fail(listed.code)
    return ok({ files: listed.files })
  } catch (error) {
    return mapActionError(error)
  }
}

export async function readWorkFileAction(
  input: z.infer<typeof readFileSchema>,
): Promise<ActionResult<{ path: string; content: string; updatedAt: string }>> {
  try {
    const parsed = readFileSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const found = await services.projectWork.service.readFile({
      tenantId: ctx.activeTenantId,
      projectKey: parsed.projectKey,
      path: parsed.path,
    })
    if (!found.ok) return fail(found.code)
    return ok(found.file)
  } catch (error) {
    return mapActionError(error)
  }
}

export async function saveWorkFileAction(
  input: z.infer<typeof saveFileSchema>,
): Promise<ActionResult<{ path: string; byteSize: number }>> {
  try {
    const parsed = saveFileSchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const saved = await services.projectWork.service.writeFile({
      tenantId: ctx.activeTenantId,
      projectKey: parsed.projectKey,
      path: parsed.path,
      content: parsed.content,
      userId: ctx.user.id,
    })
    if (!saved.ok) return fail(saved.code)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'project.work_file.write',
      targetType: 'project',
      targetId: null,
      modelUsed: null,
      inputRef: saved.file.path,
      outputRef: null,
      policyDecision: 'written',
      metadata: { projectKey: parsed.projectKey, path: saved.file.path, byteSize: saved.file.byteSize },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/projects')
    return ok(saved.file)
  } catch (error) {
    return mapActionError(error)
  }
}

export async function deleteWorkFileAction(
  input: z.infer<typeof deleteFileSchema>,
): Promise<ActionResult<{ deleted: true }>> {
  try {
    const parsed = deleteFileSchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const deleted = await services.projectWork.service.deleteFile({
      tenantId: ctx.activeTenantId,
      projectKey: parsed.projectKey,
      path: parsed.path,
    })
    if (!deleted.ok) return fail(deleted.code)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'project.work_file.delete',
      targetType: 'project',
      targetId: null,
      modelUsed: null,
      inputRef: parsed.path,
      outputRef: null,
      policyDecision: 'deleted',
      metadata: { projectKey: parsed.projectKey, path: parsed.path },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/projects')
    return ok({ deleted: true as const })
  } catch (error) {
    return mapActionError(error)
  }
}

export async function listProjectMemoryAction(
  input: z.infer<typeof listMemorySchema>,
): Promise<ActionResult<{ items: MemoryView[] }>> {
  try {
    const parsed = listMemorySchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const agent = await scopedAgent(parsed.agentId, ctx.activeTenantId)
    if (!agent) return fail('agent_not_found')
    const read = await services.projectWork.service.readMemory({
      tenantId: ctx.activeTenantId,
      agentId: parsed.agentId,
      projectKey: parsed.projectKey,
      callerUserId: ctx.user.id,
    })
    if (!read.ok) return fail(read.code)
    return ok({ items: read.items })
  } catch (error) {
    return mapActionError(error)
  }
}

/**
 * Emberi felületről az írás mindig közvetlen (verzióval és naplóval) —
 * nincs jóváhagyási kör, mert maga az ember a döntéshozó.
 */
export async function saveProjectMemoryAction(
  input: z.infer<typeof saveMemorySchema>,
): Promise<ActionResult<{ item: MemoryView }>> {
  try {
    const parsed = saveMemorySchema.parse(input)
    const ctx = await requireTenantRole('approver')
    const agent = await scopedAgent(parsed.agentId, ctx.activeTenantId)
    if (!agent) return fail('agent_not_found')
    const written = await services.projectWork.service.writeMemory({
      tenantId: ctx.activeTenantId,
      agentId: parsed.agentId,
      projectKey: parsed.projectKey,
      kind: parsed.kind,
      title: parsed.title,
      body: parsed.body,
      artifactPath: parsed.artifactPath?.trim() ? parsed.artifactPath.trim() : undefined,
      replaceId: parsed.replaceId,
      confirmNew: true,
      withUserId: ctx.user.id,
      mode: 'direct',
    })
    if (!written.ok) return fail(written.code)
    if (written.status !== 'written') return fail('schema_mismatch')
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'project.project_memory.write',
      targetType: 'project',
      targetId: written.item.id,
      modelUsed: null,
      inputRef: written.item.title,
      outputRef: parsed.replaceId ? 'replaced' : 'created',
      policyDecision: 'written',
      metadata: {
        agentId: parsed.agentId,
        projectKey: parsed.projectKey,
        kind: parsed.kind,
        memoryId: written.item.id,
        replaceId: parsed.replaceId ?? null,
      },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/projects')
    revalidatePath(`/control-plane/agents/${parsed.agentId}`)
    return ok({ item: written.item })
  } catch (error) {
    return mapActionError(error)
  }
}
