/**
 * MCP project work: named project, work files, memory write mode, conversation partner.
 * Futtatás: npm run test:project-work
 */
import assert from 'node:assert/strict'
import type { MemoryWriteMode, ProjectMemoryKind } from '@prisma/client'
import { scanMemoryContentForSecrets } from '../src/domain/memory/memory-content-guard'
import { invokeProjectWork } from '../src/domain/project-work/mcp'
import {
  ProjectWorkService,
  WORK_FILE_MAX_BYTES,
} from '../src/domain/project-work/project-work-service'
import type {
  ProjectMemoryRecord,
  ProjectMemoryStore,
  WorkFileRecord,
  WorkFileStore,
  WorkProjectRecord,
  WorkProjectStore,
} from '../src/domain/project-work/types'
import { GENERAL_WORK_PROJECT_KEY, normalizeWorkFilePath } from '../src/lib/work-project'
import type { AgentDefinition } from '../src/domain/agent-definition'

const TENANT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const DEF = '33333333-3333-4333-8333-333333333333'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BELA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

class MemProjects implements WorkProjectStore {
  rows = new Map<string, WorkProjectRecord>()
  async listByTenant(tenantId: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId)
  }
  async findByKey(tenantId: string, key: string) {
    return [...this.rows.values()].find((row) => row.tenantId === tenantId && row.key === key) ?? null
  }
  async create(input: {
    tenantId: string
    key: string
    name: string
    description: string | null
    createdById: string
  }) {
    const now = new Date()
    const row: WorkProjectRecord = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    this.rows.set(row.id, row)
    return row
  }
}

class MemFiles implements WorkFileStore {
  rows = new Map<string, WorkFileRecord>()
  private key(tenantId: string, projectKey: string, path: string) {
    return `${tenantId}:${projectKey}:${path}`
  }
  async list(tenantId: string, projectKey: string, prefix?: string) {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.projectKey === projectKey)
      .filter((row) => (prefix ? row.path.startsWith(prefix) : true))
      .map(({ content: _c, ...meta }) => meta)
  }
  async find(tenantId: string, projectKey: string, path: string) {
    return this.rows.get(this.key(tenantId, projectKey, path)) ?? null
  }
  async upsert(input: {
    tenantId: string
    projectKey: string
    path: string
    content: string
    byteSize: number
    lastWriterUserId: string
  }) {
    const existing = this.rows.get(this.key(input.tenantId, input.projectKey, input.path))
    const now = new Date()
    const row: WorkFileRecord = {
      id: existing?.id ?? globalThis.crypto.randomUUID(),
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.rows.set(this.key(input.tenantId, input.projectKey, input.path), row)
    return row
  }
  async delete(tenantId: string, projectKey: string, path: string) {
    return this.rows.delete(this.key(tenantId, projectKey, path))
  }
  async quota(tenantId: string, projectKey: string) {
    const rows = [...this.rows.values()].filter(
      (row) => row.tenantId === tenantId && row.projectKey === projectKey,
    )
    return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.byteSize, 0) }
  }
}

class MemMemory implements ProjectMemoryStore {
  rows = new Map<string, ProjectMemoryRecord>()
  async listActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    withUserId?: string
  }) {
    return [...this.rows.values()].filter(
      (row) =>
        row.tenantId === input.tenantId &&
        row.agentId === input.agentId &&
        row.projectKey === input.projectKey &&
        row.status === 'active' &&
        (input.withUserId ? row.withUserId === input.withUserId : true),
    )
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null
  }
  async insertActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string | null
  }) {
    const row: ProjectMemoryRecord = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      status: 'active',
      createdAt: new Date(),
    }
    this.rows.set(row.id, row)
    return row
  }
  async replaceActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string
  }) {
    const previous = this.rows.get(input.supersedesId)
    if (
      !previous ||
      previous.tenantId !== input.tenantId ||
      previous.agentId !== input.agentId ||
      previous.projectKey !== input.projectKey ||
      previous.status !== 'active'
    ) return null
    this.rows.set(previous.id, { ...previous, status: 'superseded' })
    const row: ProjectMemoryRecord = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      status: 'active',
      createdAt: new Date(),
    }
    this.rows.set(row.id, row)
    return row
  }
}

function harness(mode: MemoryWriteMode = 'approval') {
  const projects = new MemProjects()
  const files = new MemFiles()
  const memory = new MemMemory()
  let writeMode = mode
  const roleInstruction = { text: 'Mindig forintban számolj.' }
  const svc = new ProjectWorkService(
    projects,
    files,
    memory,
    {
      async findMemoryWriteMode(agentId, tenantId) {
        if (agentId !== AGENT || tenantId !== TENANT) return null
        return writeMode
      },
      async updateMemoryWriteMode(_agentId, next) {
        writeMode = next
      },
    },
    {
      async findManyByIds(ids) {
        return ids.map((id) => ({
          id,
          name: id === ANNA ? 'Anna' : id === BELA ? 'Béla' : id,
        }))
      },
    },
  )
  return { svc, files, memory, roleInstruction, setMode: (next: MemoryWriteMode) => { writeMode = next } }
}

const definition: AgentDefinition = {
  definitionId: DEF,
  agentId: AGENT,
  version: 1,
  tenantId: TENANT,
  status: 'active',
  publishedAt: '2026-01-01T00:00:00.000Z',
  snapshot: {
    name: 'Ügyvéd',
    roleInstruction: 'Mindig forintban számolj.',
    skills: [],
    connectors: [],
    capabilities: [],
  },
}

function parsePayload(result: { content: Array<{ text: string }>; isError?: true }) {
  assert.equal(result.content[0]?.type ?? 'text', 'text')
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

async function main() {
await check('__general__ always listed; named project is created', async () => {
  const { svc } = harness()
  const listed = await svc.listProjects(TENANT)
  assert.equal(listed[0]?.key, GENERAL_WORK_PROJECT_KEY)
  const created = await svc.createProject({ tenantId: TENANT, name: 'Átvilágítás', createdById: ANNA })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.project.key, 'atvilagitas')
  const again = await svc.listProjects(TENANT)
  assert.deepEqual(
    again.map((row) => row.key),
    [GENERAL_WORK_PROJECT_KEY, 'atvilagitas'],
  )
})

await check('work file write/read survives a later call on the same projectKey', async () => {
  const { svc } = harness()
  await svc.createProject({ tenantId: TENANT, name: 'Átvilágítás', createdById: ANNA, key: 'atvilagitas' })
  const written = await svc.writeFile({
    tenantId: TENANT,
    projectKey: 'atvilagitas',
    path: 'plans/atvilagitas.md',
    content: '# 4. szakasz',
    userId: ANNA,
  })
  assert.equal(written.ok, true)
  const read = await svc.readFile({
    tenantId: TENANT,
    projectKey: 'atvilagitas',
    path: 'plans/atvilagitas.md',
  })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.file.content, '# 4. szakasz')
  assert.equal(read.file.lastWriterUserId, ANNA)
})

await check('approval mode proposes; item is invisible until commit; author is the caller', async () => {
  const { svc } = harness('approval')
  await svc.createProject({ tenantId: TENANT, name: 'Átvilágítás', createdById: ANNA, key: 'atvilagitas' })
  const proposed = await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    projectKey: 'atvilagitas',
    kind: 'decision',
    title: 'Terv kész',
    body: 'Következő a 4. szakasz. Fájl: plans/atvilagitas.md',
    artifactPath: 'plans/atvilagitas.md',
    withUserId: ANNA,
    mode: 'approval',
  })
  assert.equal(proposed.ok, true)
  if (!proposed.ok) return
  assert.equal(proposed.status, 'needs_approval')
  const before = await svc.readMemory({
    tenantId: TENANT,
    agentId: AGENT,
    projectKey: 'atvilagitas',
    callerUserId: BELA,
  })
  assert.equal(before.ok && before.items.length, 0)
  if (proposed.status !== 'needs_approval') return
  const item = await svc.commitMemory(proposed.draft)
  assert.equal(item.withUserId, ANNA)
  assert.equal(item.withUserName, 'Anna')
  const after = await svc.readMemory({
    tenantId: TENANT,
    agentId: AGENT,
    projectKey: 'atvilagitas',
    callerUserId: BELA,
  })
  assert.equal(after.ok && after.items[0]?.withUserName, 'Anna')
})

await check('direct mode writes immediately with the caller as conversation partner', async () => {
  const { svc } = harness('direct')
  const written = await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    kind: 'decision',
    title: 'Általános döntés',
    body: 'A __general__ projekten dolgozunk.',
    withUserId: ANNA,
    mode: 'direct',
  })
  assert.equal(written.ok, true)
  if (!written.ok) return
  assert.equal(written.status, 'written')
  if (written.status !== 'written') return
  assert.equal(written.item.withUserId, ANNA)
})

await check('approved replace of an already-superseded item fails at commit', async () => {
  const { svc } = harness('direct')
  const base = { tenantId: TENANT, agentId: AGENT, kind: 'decision', withUserId: ANNA }
  const first = await svc.writeMemory({ ...base, title: 'v1', body: 'v1', mode: 'direct' })
  assert.ok(first.ok && first.status === 'written')
  if (!first.ok || first.status !== 'written') return
  const pending = await svc.writeMemory({ ...base, title: 'v2a', body: 'v2a', replaceId: first.item.id, mode: 'approval' })
  assert.ok(pending.ok && pending.status === 'needs_approval')
  if (!pending.ok || pending.status !== 'needs_approval') return
  await svc.writeMemory({ ...base, title: 'v2b', body: 'v2b', replaceId: first.item.id, mode: 'direct' })
  await assert.rejects(svc.commitMemory(pending.draft), /memory_not_found/)
})

await check('parallel replacements produce exactly one active memory item', async () => {
  const { svc } = harness('direct')
  const base = { tenantId: TENANT, agentId: AGENT, kind: 'decision', withUserId: ANNA }
  const first = await svc.writeMemory({ ...base, title: 'v1', body: 'v1', mode: 'direct' })
  assert.ok(first.ok && first.status === 'written')
  if (!first.ok || first.status !== 'written') return
  const [left, right] = await Promise.all([
    svc.writeMemory({ ...base, title: 'v2a', body: 'v2a', replaceId: first.item.id, mode: 'approval' }),
    svc.writeMemory({ ...base, title: 'v2b', body: 'v2b', replaceId: first.item.id, mode: 'approval' }),
  ])
  assert.ok(left.ok && left.status === 'needs_approval')
  assert.ok(right.ok && right.status === 'needs_approval')
  if (!left.ok || left.status !== 'needs_approval' || !right.ok || right.status !== 'needs_approval') return
  const settled = await Promise.allSettled([svc.commitMemory(left.draft), svc.commitMemory(right.draft)])
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
  const active = await svc.readMemory({ tenantId: TENANT, agentId: AGENT, callerUserId: ANNA })
  assert.equal(active.ok && active.items.length, 1)
})

await check('Béla sees Anna tagged; mine=true returns only Béla', async () => {
  const { svc } = harness('direct')
  await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    kind: 'decision',
    title: 'Anna döntése',
    body: 'Forintban.',
    withUserId: ANNA,
    mode: 'direct',
  })
  await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    kind: 'open_task',
    title: 'Béla feladata',
    body: 'Szakasz 4.',
    withUserId: BELA,
    mode: 'direct',
  })
  const all = await svc.readMemory({
    tenantId: TENANT,
    agentId: AGENT,
    callerUserId: BELA,
  })
  assert.equal(all.ok && all.items.length, 2)
  const mine = await svc.readMemory({
    tenantId: TENANT,
    agentId: AGENT,
    mine: true,
    callerUserId: BELA,
  })
  assert.equal(mine.ok && mine.items.length, 1)
  if (!mine.ok) return
  assert.equal(mine.items[0]?.withUserId, BELA)
  assert.equal(mine.items[0]?.title, 'Béla feladata')
})

await check('secret-looking memory is blocked in both modes', async () => {
  const { svc } = harness('direct')
  const blocked = await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    kind: 'finding',
    title: 'kulcs',
    body: 'AKIAIOSFODNN7EXAMPLE',
    withUserId: ANNA,
    mode: 'direct',
  })
  assert.equal(blocked.ok, false)
  if (blocked.ok) return
  assert.equal(blocked.code, 'secret_blocked')
  assert.ok(scanMemoryContentForSecrets(['AKIAIOSFODNN7EXAMPLE']).secrets.includes('aws_access_key_id'))
})

await check('memory write does not change trained operating rules', async () => {
  const { svc, roleInstruction } = harness('direct')
  const before = roleInstruction.text
  await svc.writeMemory({
    tenantId: TENANT,
    agentId: AGENT,
    kind: 'constraint',
    title: 'mindig forintban',
    body: 'Ezt ne tedd a betanított szabályba.',
    withUserId: ANNA,
    mode: 'direct',
  })
  assert.equal(roleInstruction.text, before)
})

await check('path traversal and oversized files are rejected; unknown project fails closed', async () => {
  const { svc } = harness()
  assert.equal(normalizeWorkFilePath('../secret'), null)
  const unknown = await svc.writeFile({
    tenantId: TENANT,
    projectKey: 'nincs-ilyen',
    path: 'a.md',
    content: 'x',
    userId: ANNA,
  })
  assert.equal(unknown.ok, false)
  const huge = await svc.writeFile({
    tenantId: TENANT,
    path: 'big.md',
    content: 'x'.repeat(WORK_FILE_MAX_BYTES + 1),
    userId: ANNA,
  })
  assert.equal(huge.ok, false)
})

await check('MCP stamps withUserId from the principal, not from tool args', async () => {
  const { svc, setMode } = harness('direct')
  setMode('direct')
  const result = await invokeProjectWork(
    {
      loadDefinition: async () => definition,
      findCurrentDefinitionId: async () => DEF,
      findAgentGrant: async () => ({ accessLevel: 'operate' }),
      projectWork: svc,
    },
    {
      principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
      toolName: 'platform.project_memory.write',
      args: {
        definitionId: DEF,
        kind: 'decision',
        title: 'Hamisított szerző',
        body: 'A modell Bélát írná.',
        withUserId: BELA,
        idempotencyKey: 'k1',
      },
    },
  )
  const payload = parsePayload(result)
  assert.equal(result.isError, undefined)
  assert.equal(payload.status, 'written')
  const item = payload.item as { withUserId: string; withUserName: string }
  assert.equal(item.withUserId, ANNA)
  assert.equal(item.withUserName, 'Anna')
})

  console.log(failures === 0 ? '\nOK project-work' : `\nFAIL ${failures}`)
  if (failures > 0) process.exit(1)
}

void main()
