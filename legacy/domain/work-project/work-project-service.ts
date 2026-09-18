import type { AuditRepository, WorkProjectRecord, WorkProjectRepository } from '@/repositories/interfaces'
import {
  GENERAL_WORK_PROJECT_DESCRIPTION,
  GENERAL_WORK_PROJECT_KEY,
  GENERAL_WORK_PROJECT_NAME,
  isReservedWorkProjectKey,
  normalizeWorkProjectKey,
  slugifyWorkProjectKey,
} from '@/lib/work-project'

export type WorkProjectView = {
  id: string | null
  key: string
  name: string
  description: string | null
  builtin: boolean
  archived: boolean
  createdAt: Date | null
}

export type WorkProjectBrief = {
  key: string
  name: string
  description: string | null
}

export type WorkProjectWriteResult =
  | { ok: true; project: WorkProjectView }
  | { ok: false; reason: string }

function toView(row: WorkProjectRecord): WorkProjectView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    builtin: false,
    archived: row.archivedAt != null,
    createdAt: row.createdAt,
  }
}

function generalView(): WorkProjectView {
  return {
    id: null,
    key: GENERAL_WORK_PROJECT_KEY,
    name: GENERAL_WORK_PROJECT_NAME,
    description: GENERAL_WORK_PROJECT_DESCRIPTION,
    builtin: true,
    archived: false,
    createdAt: null,
  }
}

export function generalWorkProjectBrief(): WorkProjectBrief {
  return {
    key: GENERAL_WORK_PROJECT_KEY,
    name: GENERAL_WORK_PROJECT_NAME,
    description: GENERAL_WORK_PROJECT_DESCRIPTION,
  }
}

export async function resolveWorkProjectBrief(
  projects: WorkProjectRepository | undefined,
  tenantId: string | null,
  key: string,
): Promise<WorkProjectBrief> {
  const normalized = (key || GENERAL_WORK_PROJECT_KEY).trim() || GENERAL_WORK_PROJECT_KEY
  if (!projects || !tenantId || isReservedWorkProjectKey(normalized)) return generalWorkProjectBrief()
  const row = await projects.findByKey(tenantId, normalized)
  if (!row) return { key: normalized, name: normalized, description: null }
  return { key: row.key, name: row.name, description: row.description }
}

function trimName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 80) return null
  return trimmed
}

function trimDescription(description: string | null | undefined): string | null {
  const trimmed = (description ?? '').trim()
  if (trimmed.length > 500) return null
  return trimmed.length === 0 ? null : trimmed
}

export class WorkProjectService {
  constructor(
    private readonly projects: WorkProjectRepository,
    private readonly audit?: AuditRepository,
  ) {}

  async list(tenantId: string, opts?: { includeArchived?: boolean }): Promise<WorkProjectView[]> {
    const rows = await this.projects.listByTenant(tenantId, {
      includeArchived: opts?.includeArchived === true,
    })
    return [generalView(), ...rows.map(toView)]
  }

  async resolveBrief(tenantId: string | null, key: string): Promise<WorkProjectBrief> {
    return resolveWorkProjectBrief(this.projects, tenantId, key)
  }

  async assignableKey(
    tenantId: string,
    raw: string | null | undefined,
  ): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
    const key = (raw ?? '').trim() || GENERAL_WORK_PROJECT_KEY
    if (isReservedWorkProjectKey(key)) return { ok: true, key: GENERAL_WORK_PROJECT_KEY }
    if (!normalizeWorkProjectKey(key)) return { ok: false, reason: 'Érvénytelen projektkulcs.' }
    const row = await this.projects.findByKey(tenantId, key)
    if (!row) return { ok: false, reason: 'A projekt nem található.' }
    if (row.archivedAt) return { ok: false, reason: 'Ez a projekt archiválva van.' }
    return { ok: true, key }
  }

  async archive(input: {
    tenantId: string
    id: string
    actorId: string
    archived: boolean
  }): Promise<WorkProjectWriteResult> {
    const existing = await this.projects.findById(input.id)
    if (!existing || existing.tenantId !== input.tenantId) {
      return { ok: false, reason: 'A projekt nem található.' }
    }
    const updated = await this.projects.update(existing.id, {
      archivedAt: input.archived ? new Date() : null,
    })
    await this.audit?.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: input.archived ? 'work_project.archive' : 'work_project.unarchive',
      targetType: 'work_project',
      targetId: updated.id,
      modelUsed: null,
      inputRef: updated.key,
      outputRef: updated.id,
      policyDecision: 'allowed',
      tenantId: input.tenantId,
      metadata: { key: updated.key, archived: input.archived },
    })
    return { ok: true, project: toView(updated) }
  }

  async create(input: {
    tenantId: string
    name: string
    description?: string | null
    key?: string | null
    actorId: string
  }): Promise<WorkProjectWriteResult> {
    const name = trimName(input.name)
    if (!name) return { ok: false, reason: 'A projekt nevének 1–80 karakternek kell lennie.' }
    const description = trimDescription(input.description)
    if (input.description != null && input.description.trim().length > 500) {
      return { ok: false, reason: 'A leírás legfeljebb 500 karakter lehet.' }
    }

    const rawKey = (input.key ?? '').trim() || slugifyWorkProjectKey(name)
    if (isReservedWorkProjectKey(rawKey)) {
      return { ok: false, reason: 'Az Általános gyűjtő foglalt — válassz másik nevet.' }
    }
    const key = normalizeWorkProjectKey(rawKey)
    if (!key) {
      return {
        ok: false,
        reason: 'A projektkulcs csak betűt, számot és a _ . : - jeleket tartalmazhat, szóköz nélkül.',
      }
    }

    const existing = await this.projects.findByKey(input.tenantId, key)
    if (existing) return { ok: false, reason: 'Ilyen kulccsal már van projekt.' }

    const created = await this.projects.create({
      tenantId: input.tenantId,
      key,
      name,
      description,
      createdById: input.actorId,
    })

    await this.audit?.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'work_project.create',
      targetType: 'work_project',
      targetId: created.id,
      modelUsed: null,
      inputRef: key,
      outputRef: created.id,
      policyDecision: 'allowed',
      tenantId: input.tenantId,
      metadata: { key, name },
    })

    return { ok: true, project: toView(created) }
  }

  async update(input: {
    tenantId: string
    id: string
    name: string
    description?: string | null
    actorId: string
  }): Promise<WorkProjectWriteResult> {
    const existing = await this.projects.findById(input.id)
    if (!existing || existing.tenantId !== input.tenantId) {
      return { ok: false, reason: 'A projekt nem található.' }
    }

    const name = trimName(input.name)
    if (!name) return { ok: false, reason: 'A projekt nevének 1–80 karakternek kell lennie.' }
    if (input.description != null && input.description.trim().length > 500) {
      return { ok: false, reason: 'A leírás legfeljebb 500 karakter lehet.' }
    }
    const description = trimDescription(input.description)

    const updated = await this.projects.update(existing.id, { name, description })

    await this.audit?.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'work_project.update',
      targetType: 'work_project',
      targetId: updated.id,
      modelUsed: null,
      inputRef: updated.key,
      outputRef: updated.id,
      policyDecision: 'allowed',
      tenantId: input.tenantId,
      metadata: { key: updated.key, name },
    })

    return { ok: true, project: toView(updated) }
  }
}
