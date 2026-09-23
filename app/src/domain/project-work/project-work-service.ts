import type { ProjectMemoryKind } from '@prisma/client'
import { scanMemoryContentForSecrets } from '@/domain/memory/memory-content-guard'
import {
  effectiveWorkProjectKey,
  GENERAL_WORK_PROJECT_KEY,
  GENERAL_WORK_PROJECT_NAME,
  isReservedWorkProjectKey,
  isValidProjectKey,
  normalizeWorkFilePath,
  slugifyWorkProjectKey,
} from '@/lib/work-project'
import {
  PROJECT_MEMORY_KINDS,
  type AgentMemoryWriteModeStore,
  type MemoryWriteModeValue,
  type ProjectMemoryRecord,
  type ProjectMemoryStore,
  type ProjectWorkUserLookup,
  type WorkFileRecord,
  type WorkFileStore,
  type WorkProjectRecord,
  type WorkProjectStore,
} from './types'

export type { MemoryWriteModeValue, ProjectMemoryRecord, WorkFileRecord, WorkProjectRecord }

// ponytail: per-project byte+count caps; split per-file GCS if a project grows past a few MB.
export const WORK_FILE_MAX_BYTES = 200_000
export const WORK_FILE_MAX_PROJECT_BYTES = 5_000_000
export const WORK_FILE_MAX_COUNT = 200
export const MEMORY_TITLE_MAX = 200
export const MEMORY_BODY_MAX = 8_000

export type ProjectWorkErr = { ok: false; code: string; message: string }
export type ProjectWorkOk<T> = { ok: true } & T
export type ProjectWorkResult<T> = ProjectWorkOk<T> | ProjectWorkErr

const MESSAGES: Record<string, string> = {
  invalid_project_key: 'Invalid projectKey',
  reserved_project_key: 'The built-in general project cannot be created or renamed',
  unknown_project: 'Unknown projectKey — call platform.projects.create first, or use __general__',
  project_key_taken: 'A project with this key already exists',
  invalid_path: 'Invalid work file path',
  file_not_found: 'Work file not found',
  file_too_large: 'Work file exceeds the size quota',
  quota_exceeded: 'Project work-file quota exceeded',
  secret_blocked: 'Memory write blocked: secret-looking content',
  invalid_memory_kind: 'Invalid memory kind',
  memory_not_found: 'Memory item not found',
  agent_not_found: 'Agent not found',
}

function err(code: string, extra?: string): ProjectWorkErr {
  return { ok: false, code, message: extra ? `${MESSAGES[code] ?? code}: ${extra}` : MESSAGES[code] ?? code }
}

function ok<T>(value: T): ProjectWorkOk<T> {
  return { ok: true, ...value }
}

export function isProjectMemoryKind(value: string): value is ProjectMemoryKind {
  return (PROJECT_MEMORY_KINDS as readonly string[]).includes(value)
}

export type ProjectListItem = {
  key: string
  name: string
  description: string | null
  reserved: boolean
}

export type MemoryView = {
  id: string
  kind: ProjectMemoryKind
  title: string
  body: string
  artifactPath: string | null
  withUserId: string
  withUserName: string
  createdAt: string
}

export type MemoryWriteInput = {
  tenantId: string
  agentId: string
  projectKey?: string
  kind: string
  title: string
  body: string
  artifactPath?: string
  replaceId?: string
  withUserId: string
  mode: MemoryWriteModeValue
}

export class ProjectWorkService {
  constructor(
    private readonly projects: WorkProjectStore,
    private readonly files: WorkFileStore,
    private readonly memory: ProjectMemoryStore,
    private readonly agents: AgentMemoryWriteModeStore,
    private readonly users: ProjectWorkUserLookup,
  ) {}

  async listProjects(tenantId: string): Promise<ProjectListItem[]> {
    const rows = (await this.projects.listByTenant(tenantId)).filter((row) => row.archivedAt == null)
    const named = rows
      .filter((row) => !isReservedWorkProjectKey(row.key))
      .map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        reserved: false,
      }))
    return [
      {
        key: GENERAL_WORK_PROJECT_KEY,
        name: GENERAL_WORK_PROJECT_NAME,
        description: 'Work with no named project.',
        reserved: true,
      },
      ...named,
    ]
  }

  async createProject(input: {
    tenantId: string
    name: string
    createdById: string
    key?: string
    description?: string
  }): Promise<ProjectWorkResult<{ project: ProjectListItem }>> {
    const name = input.name.trim()
    if (!name) return err('invalid_project_key', 'name required')
    const key = (input.key?.trim() || slugifyWorkProjectKey(name)).trim()
    if (!key || isReservedWorkProjectKey(key) || !isValidProjectKey(key)) return err('invalid_project_key')
    const existing = await this.projects.findByKey(input.tenantId, key)
    if (existing) return err('project_key_taken')
    const row = await this.projects.create({
      tenantId: input.tenantId,
      key,
      name,
      description: input.description?.trim() || null,
      createdById: input.createdById,
    })
    return ok({
      project: { key: row.key, name: row.name, description: row.description, reserved: false },
    })
  }

  async assertProject(tenantId: string, rawKey: string | undefined): Promise<ProjectWorkResult<{ projectKey: string }>> {
    const projectKey = effectiveWorkProjectKey(rawKey)
    if (isReservedWorkProjectKey(projectKey)) return ok({ projectKey })
    if (!isValidProjectKey(projectKey)) return err('invalid_project_key')
    const row = await this.projects.findByKey(tenantId, projectKey)
    if (!row || row.archivedAt) return err('unknown_project')
    return ok({ projectKey })
  }

  async listFiles(input: {
    tenantId: string
    projectKey?: string
    prefix?: string
  }): Promise<ProjectWorkResult<{ files: Array<{ path: string; byteSize: number; lastWriterUserId: string; updatedAt: string }> }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    const prefix = input.prefix ? normalizeWorkFilePath(input.prefix) : undefined
    if (input.prefix && !prefix) return err('invalid_path')
    const rows = await this.files.list(input.tenantId, scoped.projectKey, prefix ?? undefined)
    return ok({
      files: rows.map((row) => ({
        path: row.path,
        byteSize: row.byteSize,
        lastWriterUserId: row.lastWriterUserId,
        updatedAt: row.updatedAt.toISOString(),
      })),
    })
  }

  async readFile(input: {
    tenantId: string
    projectKey?: string
    path: string
  }): Promise<ProjectWorkResult<{ file: { path: string; content: string; lastWriterUserId: string; updatedAt: string } }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    const path = normalizeWorkFilePath(input.path)
    if (!path) return err('invalid_path')
    const row = await this.files.find(input.tenantId, scoped.projectKey, path)
    if (!row) return err('file_not_found')
    return ok({
      file: {
        path: row.path,
        content: row.content,
        lastWriterUserId: row.lastWriterUserId,
        updatedAt: row.updatedAt.toISOString(),
      },
    })
  }

  async writeFile(input: {
    tenantId: string
    projectKey?: string
    path: string
    content: string
    userId: string
  }): Promise<ProjectWorkResult<{ file: { path: string; byteSize: number; lastWriterUserId: string } }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    const path = normalizeWorkFilePath(input.path)
    if (!path) return err('invalid_path')
    const content = input.content
    const byteSize = Buffer.byteLength(content, 'utf8')
    if (byteSize > WORK_FILE_MAX_BYTES) return err('file_too_large')
    const existing = await this.files.find(input.tenantId, scoped.projectKey, path)
    const quota = await this.files.quota(input.tenantId, scoped.projectKey)
    const nextCount = quota.count + (existing ? 0 : 1)
    const nextBytes = quota.bytes - (existing?.byteSize ?? 0) + byteSize
    if (nextCount > WORK_FILE_MAX_COUNT || nextBytes > WORK_FILE_MAX_PROJECT_BYTES) return err('quota_exceeded')
    const row = await this.files.upsert({
      tenantId: input.tenantId,
      projectKey: scoped.projectKey,
      path,
      content,
      byteSize,
      lastWriterUserId: input.userId,
    })
    return ok({
      file: { path: row.path, byteSize: row.byteSize, lastWriterUserId: row.lastWriterUserId },
    })
  }

  async deleteFile(input: {
    tenantId: string
    projectKey?: string
    path: string
  }): Promise<ProjectWorkResult<{ deleted: true }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    const path = normalizeWorkFilePath(input.path)
    if (!path) return err('invalid_path')
    const deleted = await this.files.delete(input.tenantId, scoped.projectKey, path)
    if (!deleted) return err('file_not_found')
    return ok({ deleted: true as const })
  }

  async readMemory(input: {
    tenantId: string
    agentId: string
    projectKey?: string
    mine?: boolean
    callerUserId: string
  }): Promise<ProjectWorkResult<{ items: MemoryView[] }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    const rows = await this.memory.listActive({
      tenantId: input.tenantId,
      agentId: input.agentId,
      projectKey: scoped.projectKey,
      withUserId: input.mine ? input.callerUserId : undefined,
    })
    const names = await this.users.findManyByIds([...new Set(rows.map((row) => row.withUserId))])
    const byId = new Map(names.map((row) => [row.id, row.name]))
    return ok({
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        artifactPath: row.artifactPath,
        withUserId: row.withUserId,
        withUserName: byId.get(row.withUserId) ?? row.withUserId,
        createdAt: row.createdAt.toISOString(),
      })),
    })
  }

  async writeMemory(
    input: MemoryWriteInput,
  ): Promise<
    ProjectWorkResult<
      | { status: 'written'; item: MemoryView }
      | { status: 'needs_approval'; draft: Omit<MemoryWriteInput, 'mode'> }
    >
  > {
    const prepared = await this.prepareMemoryWrite(input)
    if (!prepared.ok) return prepared
    if (input.mode === 'approval') {
      return ok({ status: 'needs_approval' as const, draft: prepared.draft })
    }
    const item = await this.insertMemory(prepared.draft)
    return ok({ status: 'written' as const, item })
  }

  /** Approved draft → re-validated at commit time (project may be archived, replaceId superseded since enqueue). */
  async commitMemory(draft: Omit<MemoryWriteInput, 'mode'>): Promise<MemoryView> {
    const prepared = await this.prepareMemoryWrite({ ...draft, mode: 'direct' })
    if (!prepared.ok) throw new Error(prepared.code)
    return this.insertMemory(prepared.draft)
  }

  private async insertMemory(draft: Omit<MemoryWriteInput, 'mode'>): Promise<MemoryView> {
    const input = {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      projectKey: effectiveWorkProjectKey(draft.projectKey),
      kind: draft.kind as ProjectMemoryKind,
      title: draft.title,
      body: draft.body,
      artifactPath: draft.artifactPath ?? null,
      withUserId: draft.withUserId,
      supersedesId: draft.replaceId ?? null,
    }
    const row = draft.replaceId
      ? await this.memory.replaceActive({ ...input, supersedesId: draft.replaceId })
      : await this.memory.insertActive(input)
    if (!row) throw new Error('memory_not_found')
    const [user] = await this.users.findManyByIds([row.withUserId])
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      artifactPath: row.artifactPath,
      withUserId: row.withUserId,
      withUserName: user?.name ?? row.withUserId,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async getWriteMode(agentId: string, tenantId: string): Promise<ProjectWorkResult<{ mode: MemoryWriteModeValue }>> {
    const mode = await this.agents.findMemoryWriteMode(agentId, tenantId)
    if (!mode) return err('agent_not_found')
    return ok({ mode })
  }

  async setWriteMode(
    agentId: string,
    tenantId: string,
    mode: MemoryWriteModeValue,
  ): Promise<ProjectWorkResult<{ mode: MemoryWriteModeValue }>> {
    const existing = await this.agents.findMemoryWriteMode(agentId, tenantId)
    if (!existing) return err('agent_not_found')
    await this.agents.updateMemoryWriteMode(agentId, mode)
    return ok({ mode })
  }

  private async prepareMemoryWrite(
    input: MemoryWriteInput,
  ): Promise<ProjectWorkResult<{ draft: Omit<MemoryWriteInput, 'mode'> }>> {
    const scoped = await this.assertProject(input.tenantId, input.projectKey)
    if (!scoped.ok) return scoped
    if (!isProjectMemoryKind(input.kind)) return err('invalid_memory_kind')
    const title = input.title.trim()
    const body = input.body.trim()
    if (!title || title.length > MEMORY_TITLE_MAX) return err('invalid_memory_kind', 'title')
    if (!body || body.length > MEMORY_BODY_MAX) return err('invalid_memory_kind', 'body')
    const scan = scanMemoryContentForSecrets([title, body, input.artifactPath])
    if (scan.secrets.length > 0) return err('secret_blocked', scan.secrets.join(','))
    let artifactPath: string | undefined
    if (input.artifactPath) {
      const path = normalizeWorkFilePath(input.artifactPath)
      if (!path) return err('invalid_path')
      artifactPath = path
    }
    if (input.replaceId) {
      const previous = await this.memory.findById(input.replaceId)
      if (
        !previous ||
        previous.tenantId !== input.tenantId ||
        previous.agentId !== input.agentId ||
        previous.projectKey !== scoped.projectKey ||
        previous.status !== 'active'
      ) {
        return err('memory_not_found')
      }
    }
    return ok({
      draft: {
        tenantId: input.tenantId,
        agentId: input.agentId,
        projectKey: scoped.projectKey,
        kind: input.kind,
        title,
        body,
        artifactPath,
        replaceId: input.replaceId,
        withUserId: input.withUserId,
      },
    })
  }
}
