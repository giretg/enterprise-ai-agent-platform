/**
 * Contract: N+1 batch repository metódusok léteznek, és a hot path hívók
 * batch/IN lekérdezést használnak (docs/perf/github-issues/004).
 *
 * DB nélkül: forrás-szöveg ellenőrzés + in-memory listStartablePlaybooks.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { PlaybookAssignment, PlaybookV2, PlaybookVersionV2 } from '@prisma/client'
import type {
  CreatePlaybookAssignmentInput,
  CreatePlaybookV2Input,
  CreatePlaybookVersionV2Input,
  PlaybookV2Repository,
  PlaybookV2WithVersions,
} from '../src/repositories/interfaces'
import { PlaybookV2Service } from '../src/domain/playbook/playbook-v2-service'
import { orderRowsByIds } from '../src/repositories/order-by-ids'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string) {
  return readFileSync(join(root, rel), 'utf8')
}

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function unused(): never {
  throw new Error('unused')
}

function makeRepo(hooks?: {
  onFindDefaultAssignment?: () => void
  onFindDefaultAssignments?: () => void
  onListDefaultAssignments?: () => void
}): PlaybookV2Repository {
  const playbooks: PlaybookV2[] = []
  const versions: PlaybookVersionV2[] = []
  const assignments: PlaybookAssignment[] = []

  return {
    async createPlaybook(input: CreatePlaybookV2Input) {
      const pb = {
        id: randomUUID(),
        tenantId: input.tenantId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        processType: input.processType,
        status: 'draft',
        currentPublishedVersionId: null,
        ownerUserId: input.ownerUserId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        archivedAt: null,
      } as PlaybookV2
      playbooks.push(pb)
      return pb
    },
    findPlaybook: async () => null,
    findPlaybookByKey: async () => null,
    async listPlaybooks(tenantId: string | null): Promise<PlaybookV2WithVersions[]> {
      return playbooks
        .filter((p) => p.tenantId === tenantId)
        .map((p) => ({ ...p, versions: versions.filter((v) => v.playbookId === p.id) }))
    },
    async updatePlaybook(id, data) {
      const pb = playbooks.find((p) => p.id === id)!
      Object.assign(pb, data)
      return pb
    },
    async createVersion(input: CreatePlaybookVersionV2Input) {
      const v = {
        id: randomUUID(),
        tenantId: input.tenantId,
        playbookId: input.playbookId,
        version: input.version,
        status: 'published',
        spec: input.spec,
        compiledSpec: null,
        validationResult: input.validationResult,
        changeSummary: input.changeSummary,
        contentHash: input.contentHash,
        createdById: input.createdById,
        approvedById: null,
        approvedAt: null,
        publishedAt: new Date(),
        retiredAt: null,
        createdAt: new Date(),
      } as unknown as PlaybookVersionV2
      versions.push(v)
      return v
    },
    findVersion: async () => null,
    findVersionByContentHash: async () => null,
    listVersions: async () => [],
    nextVersionNumber: async () => 1,
    updateVersion: async () => unused(),
    publishVersion: async () => unused(),
    async createAssignment(input: CreatePlaybookAssignmentInput) {
      const assignment = {
        id: randomUUID(),
        tenantId: input.tenantId,
        playbookId: input.playbookId,
        playbookVersionId: input.playbookVersionId,
        assignmentType: input.assignmentType,
        assignmentKey: input.assignmentKey,
        isDefault: input.isDefault,
        createdById: input.createdById,
        createdAt: new Date(),
        revokedAt: null,
      } as PlaybookAssignment
      assignments.push(assignment)
      return assignment
    },
    async findDefaultAssignment(tenantId, assignmentType, assignmentKey) {
      hooks?.onFindDefaultAssignment?.()
      return (
        assignments.find(
          (a) =>
            a.tenantId === tenantId &&
            a.assignmentType === assignmentType &&
            a.assignmentKey === assignmentKey &&
            a.isDefault &&
            a.revokedAt === null,
        ) ?? null
      )
    },
    async findDefaultAssignments(tenantId, assignmentType, assignmentKeys) {
      hooks?.onFindDefaultAssignments?.()
      const result = new Map<string, PlaybookAssignment>()
      for (const key of assignmentKeys) {
        const row =
          assignments.find(
            (a) =>
              a.tenantId === tenantId &&
              a.assignmentType === assignmentType &&
              a.assignmentKey === key &&
              a.isDefault &&
              a.revokedAt === null,
          ) ?? null
        if (row) result.set(key, row)
      }
      return result
    },
    async listDefaultAssignments(tenantId, assignmentType) {
      hooks?.onListDefaultAssignments?.()
      return assignments
        .filter(
          (a) =>
            a.tenantId === tenantId &&
            a.assignmentType === assignmentType &&
            a.isDefault &&
            a.revokedAt === null,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    },
    async findVersionsByIds(tenantId, ids) {
      if (ids.length === 0) return []
      return versions.filter((v) => v.tenantId === tenantId && ids.includes(v.id))
    },
    async findPlaybooksByIds(tenantId, ids) {
      if (ids.length === 0) return []
      return playbooks.filter((p) => p.tenantId === tenantId && ids.includes(p.id))
    },
  }
}

console.log('\nN+1 batch contract\n')

async function main() {
  await test('interface exposes batch helpers', () => {
    const iface = read('src/repositories/interfaces/index.ts')
    assert.match(iface, /findDefaultAssignments\(/)
    assert.match(iface, /findCapabilitiesForAgents\(/)
    assert.match(iface, /findByIds\(ids: string\[\]\): Promise<Tenant\[\]>/)
    assert.match(iface, /findByKeys\(permissionKeys/)
    assert.match(iface, /findByIds\(ids: string\[\]\): Promise<Document\[\]>/)
    assert.match(iface, /findVersionsByIds\(/)
  })

  await test('batch ID lookup preserves requested order, duplicates, and skips missing rows', () => {
    const rows = [
      { id: 'tenant-c', name: 'C' },
      { id: 'tenant-a', name: 'A' },
      { id: 'tenant-b', name: 'B' },
    ]
    const ordered = orderRowsByIds(
      ['tenant-b', 'missing', 'tenant-a', 'tenant-b', 'tenant-c'],
      rows,
    )
    assert.deepEqual(
      ordered.map((row) => row.id),
      ['tenant-b', 'tenant-a', 'tenant-b', 'tenant-c'],
    )
  })

  await test('postgres repos implement batch helpers', () => {
    assert.match(read('src/repositories/postgres/playbook-v2-repository.ts'), /async findDefaultAssignments\(/)
    assert.match(read('src/repositories/postgres/tool-broker-repository.ts'), /async findCapabilitiesForAgents\(/)
    assert.match(read('src/repositories/postgres/tenant-repository.ts'), /async findByIds\(/)
    assert.match(read('src/repositories/postgres/iam-repository.ts'), /async findByKeys\(/)
    assert.match(read('src/repositories/postgres/agent-repository.ts'), /async findByIds\(ids: string\[\]\)/)
    assert.match(read('src/repositories/postgres/skill-repository.ts'), /async findVersionsByIds\(/)
  })

  await test('hot paths use batch APIs', () => {
    const startable = read('src/domain/playbook/playbook-v2-service.ts')
    // A startable lista assignment-vezérelt: egy default-assignment lekérdezés,
    // majd batch version/playbook feloldás — playbookonkénti lookup nélkül (#003).
    assert.match(startable, /listDefaultAssignments\(/)
    assert.match(startable, /findVersionsByIds\(/)
    assert.match(startable, /findPlaybooksByIds\(/)
    assert.doesNotMatch(startable, /for \(const playbook of playbooks\)/)

    const tenantAction = read('src/app/actions/tenant.ts')
    assert.match(tenantAction, /tenants\.findByIds\(/)
    assert.doesNotMatch(tenantAction, /membershipTenantIds\]\.map\(\(id\) => repositories\.tenants\.findById/)

    // Web-Egress feloldás: systemRole + tenant fail-closed (nem N+1 capability scan).
    const egress = read('src/domain/tool-broker/tool-broker-delegation.ts')
    assert.match(egress, /selectActiveTenantWebEgress\(/)
    assert.doesNotMatch(egress, /findCapabilitiesForAgents\(/)

    const processAction = read('src/app/actions/process.ts')
    assert.match(processAction, /listSuitableAgentsForVersion/)
    assert.match(processAction, /findCapabilitiesForAgents\(/)

    const listUi = read('src/components/processes/process-definition-list.tsx')
    assert.match(listUi, /listSuitableAgentsForVersion/)
    assert.doesNotMatch(listUi, /for \(const role of version\.agentRoles\)/)

    const builderUi = read('src/components/processes/process-definition-builder.tsx')
    assert.match(builderUi, /listSuitableAgentsForVersion/)

    const gate = read('src/domain/playbook/process-definition-service.ts')
    assert.match(gate, /findManyByIds\(/)
    assert.match(gate, /findByKeys\(/)

    assert.match(read('src/domain/agent/agent-chat-runtime.ts'), /documents\.findByIds\(/)
    assert.match(read('src/domain/agent/general-task-runtime.ts'), /documents\.findByIds\(/)
    assert.match(read('src/domain/skill/skill-service.ts'), /findVersionsByIds\(/)

    const chatRuntime = read('src/domain/agent/agent-chat-runtime.ts')
    const loadMessagesStart = chatRuntime.indexOf('async getConversationMessages(')
    const loadMessagesEnd = chatRuntime.indexOf('async getPrivacyMarkerContext(', loadMessagesStart)
    assert.ok(loadMessagesStart >= 0 && loadMessagesEnd > loadMessagesStart, 'getConversationMessages megtalálható')
    const loadMessages = chatRuntime.slice(loadMessagesStart, loadMessagesEnd)
    assert.match(loadMessages, /documents\.findByIds\(/)
    assert.doesNotMatch(loadMessages, /documents\.findById\(/)
    assert.match(loadMessages, /loadKnownValueReplacements\(/)
    const knownValueCalls = loadMessages.split('loadKnownValueReplacements(').length - 1
    assert.equal(knownValueCalls, 1, 'known-value szótár beszélgetésenként egyszer, ne üzenetenként')

    const platform = read('src/app/actions/platform.ts')
    const actionStart = platform.indexOf('export async function loadAgentChatMessages')
    const actionEnd = platform.indexOf('export async function listAgentChatSessions', actionStart)
    assert.ok(actionStart >= 0 && actionEnd > actionStart, 'loadAgentChatMessages megtalálható')
    const action = platform.slice(actionStart, actionEnd)
    assert.match(action, /getConversationMessages\(/)
    assert.doesNotMatch(action, /services\.conversations\.getConversation\(/)
    assert.doesNotMatch(action, /prisma\.document\.findUnique/)
  })

  await test('listStartablePlaybooks uses one batch assignment lookup, never single', async () => {
    let single = 0
    let batch = 0
    const repo = makeRepo({
      onFindDefaultAssignment: () => {
        single++
      },
      onFindDefaultAssignments: () => {
        batch++
      },
      onListDefaultAssignments: () => {
        batch++
      },
    })
    const tenant = 'tenant-b'
    const svc = new PlaybookV2Service(repo, { append: async () => ({}) as never } as never)

    for (let i = 0; i < 4; i++) {
      const pb = await repo.createPlaybook({
        tenantId: tenant,
        key: `k-${i}`,
        name: `N ${i}`,
        description: null,
        processType: `pt-${i}`,
        ownerUserId: null,
      })
      const version = await repo.createVersion({
        tenantId: tenant,
        playbookId: pb.id,
        version: 1,
        spec: {},
        validationResult: {},
        changeSummary: 'x',
        contentHash: `h-${i}`,
        createdById: 'u',
      })
      await repo.createAssignment({
        tenantId: tenant,
        playbookId: pb.id,
        playbookVersionId: version.id,
        assignmentType: 'process_type',
        assignmentKey: pb.processType,
        isDefault: true,
        createdById: 'u',
      })
    }

    single = 0
    batch = 0
    const rows = await svc.listStartablePlaybooks(tenant)
    assert.equal(rows.length, 4)
    assert.equal(batch, 1)
    assert.equal(single, 0)
  })

  await test('listStartablePlaybooks rejects a version assigned to a different playbook', async () => {
    const repo = makeRepo()
    const tenant = 'tenant-integrity'
    const assignedPlaybook = await repo.createPlaybook({
      tenantId: tenant,
      key: 'assigned',
      name: 'Assigned',
      description: null,
      processType: 'integrity-check',
      ownerUserId: null,
    })
    const versionOwner = await repo.createPlaybook({
      tenantId: tenant,
      key: 'version-owner',
      name: 'Version owner',
      description: null,
      processType: 'other-process',
      ownerUserId: null,
    })
    const foreignVersion = await repo.createVersion({
      tenantId: tenant,
      playbookId: versionOwner.id,
      version: 1,
      spec: {},
      validationResult: {},
      changeSummary: 'x',
      contentHash: 'integrity-hash',
      createdById: 'u',
    })
    await repo.createAssignment({
      tenantId: tenant,
      playbookId: assignedPlaybook.id,
      playbookVersionId: foreignVersion.id,
      assignmentType: 'process_type',
      assignmentKey: assignedPlaybook.processType,
      isDefault: true,
      createdById: 'u',
    })

    assert.deepEqual(await new PlaybookV2Service(
      repo,
      { append: async () => ({}) as never } as never,
    ).listStartablePlaybooks(tenant), [])
  })

  await test('getConversationMessages batches documents and known-values, not per message', async () => {
    const { AgentChatRuntime } = await import('../src/domain/agent/agent-chat-runtime')
    const findByIdCalls: string[] = []
    const findByIdsCalls: string[][] = []
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'agent',
      content: JSON.stringify({ text: `üzenet ${i}`, attachmentIds: [`doc-${i}`] }),
      contentDeletedAt: null,
      createdAt: new Date(`2026-08-0${i + 1}T10:00:00Z`),
      ticketRefId: null,
    }))
    const runtime = new AgentChatRuntime(
      {} as never,
      {
        findById: async (id: string) => {
          findByIdCalls.push(id)
          return { id, filename: `${id}.txt`, extractedText: 'x' }
        },
        findByIds: async (ids: string[]) => {
          findByIdsCalls.push(ids)
          return ids.map((id) => ({ id, filename: `${id}.txt`, extractedText: 'x' }))
        },
      } as never,
      {} as never,
      {} as never,
      {
        getConversation: async () => ({
          conversation: {
            id: 'conv-1',
            agentId: 'agent-1',
            status: 'active',
            title: 'Teszt',
            lastMessageAt: new Date(),
            continuedFromTicketId: null,
          },
          messages,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
    const loaded = await runtime.getConversationMessages('conv-1', 'tenant-1', 'agent-1', 'user-1')
    assert.equal(loaded.messages.length, 5)
    assert.equal(findByIdCalls.length, 0)
    assert.equal(findByIdsCalls.length, 1)
    assert.equal(findByIdsCalls[0]?.length, 5)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll N+1 batch contract checks passed.\n')
}

void main()
