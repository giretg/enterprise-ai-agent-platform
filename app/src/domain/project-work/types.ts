import type { MemoryWriteMode, ProjectMemoryKind, ProjectMemoryStatus } from '@prisma/client'

export const PROJECT_MEMORY_KINDS = [
  'decision',
  'open_task',
  'finding',
  'constraint',
  'artifact',
  'handoff_summary',
] as const satisfies readonly ProjectMemoryKind[]

export type MemoryWriteModeValue = MemoryWriteMode

export type WorkProjectRecord = {
  id: string
  tenantId: string
  key: string
  name: string
  description: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export type WorkFileRecord = {
  id: string
  tenantId: string
  projectKey: string
  path: string
  content: string
  byteSize: number
  lastWriterUserId: string
  createdAt: Date
  updatedAt: Date
}

export type ProjectMemoryRecord = {
  id: string
  tenantId: string
  agentId: string
  projectKey: string
  kind: ProjectMemoryKind
  title: string
  body: string
  artifactPath: string | null
  withUserId: string
  status: ProjectMemoryStatus
  supersedesId: string | null
  createdAt: Date
}

export type WorkFileQuota = { count: number; bytes: number }

export interface WorkProjectStore {
  listByTenant(tenantId: string): Promise<WorkProjectRecord[]>
  findByKey(tenantId: string, key: string): Promise<WorkProjectRecord | null>
  create(input: {
    tenantId: string
    key: string
    name: string
    description: string | null
    createdById: string
  }): Promise<WorkProjectRecord>
}

export interface WorkFileStore {
  list(tenantId: string, projectKey: string, prefix?: string): Promise<Omit<WorkFileRecord, 'content'>[]>
  find(tenantId: string, projectKey: string, path: string): Promise<WorkFileRecord | null>
  upsert(input: {
    tenantId: string
    projectKey: string
    path: string
    content: string
    byteSize: number
    lastWriterUserId: string
  }): Promise<WorkFileRecord>
  delete(tenantId: string, projectKey: string, path: string): Promise<boolean>
  quota(tenantId: string, projectKey: string): Promise<WorkFileQuota>
}

export interface ProjectMemoryStore {
  listActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    withUserId?: string
  }): Promise<ProjectMemoryRecord[]>
  findById(id: string): Promise<ProjectMemoryRecord | null>
  insertActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string | null
  }): Promise<ProjectMemoryRecord>
  replaceActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string
  }): Promise<ProjectMemoryRecord | null>
}

export interface ProjectWorkUserLookup {
  findManyByIds(ids: string[]): Promise<Array<{ id: string; name: string }>>
}

export interface AgentMemoryWriteModeStore {
  findMemoryWriteMode(agentId: string, tenantId: string): Promise<MemoryWriteModeValue | null>
  updateMemoryWriteMode(agentId: string, memoryWriteMode: MemoryWriteModeValue): Promise<void>
}
