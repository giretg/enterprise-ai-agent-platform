/**
 * Tenant-szintű munka-projektek: kulcs, foglalt Általános, létrehozás/frissítés,
 * archiválás, prompt-brief, beszélgetés/ticket választó.
 * Futtatás: npx tsx scripts/work-project.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkProjectRecord, WorkProjectRepository } from '../src/repositories/interfaces'
import { WorkProjectService } from '../src/domain/work-project/work-project-service'
import { formatProjectMemoryContextBlock } from '../src/lib/memory-prompt'
import {
  GENERAL_WORK_PROJECT_KEY,
  GENERAL_WORK_PROJECT_NAME,
  assignableWorkProjectOptions,
  effectiveWorkProjectKey,
  isReservedWorkProjectKey,
  slugifyWorkProjectKey,
} from '../src/lib/work-project'

class MemoryWorkProjects implements WorkProjectRepository {
  private rows = new Map<string, WorkProjectRecord>()

  async listByTenant(
    tenantId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<WorkProjectRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .filter((row) => opts?.includeArchived === true || row.archivedAt == null)
      .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  }

  async findById(id: string): Promise<WorkProjectRecord | null> {
    return this.rows.get(id) ?? null
  }

  async findByKey(tenantId: string, key: string): Promise<WorkProjectRecord | null> {
    return [...this.rows.values()].find((row) => row.tenantId === tenantId && row.key === key) ?? null
  }

  async create(data: {
    tenantId: string
    key: string
    name: string
    description: string | null
    createdById: string
  }): Promise<WorkProjectRecord> {
    const now = new Date()
    const row: WorkProjectRecord = {
      id: `wp-${this.rows.size + 1}`,
      tenantId: data.tenantId,
      key: data.key,
      name: data.name,
      description: data.description,
      createdById: data.createdById,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    this.rows.set(row.id, row)
    return row
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; archivedAt?: Date | null },
  ): Promise<WorkProjectRecord> {
    const existing = this.rows.get(id)
    if (!existing) throw new Error('missing')
    const next = { ...existing, ...patch, updatedAt: new Date() }
    this.rows.set(id, next)
    return next
  }
}

let failures = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`  ✗ ${name}`)
      console.error(error)
    })
}

async function main() {
  console.log('work-project')

  await test('a dev Prisma-kliens a workProject modell hiányát elavultnak tekinti', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/lib/db.ts'), 'utf8')
    assert.match(src, /DEV_REQUIRED_MODELS = \[[^\]]*workProject/)
  })

  await test('a Projektek oldal lista-hiba esetén is kirakja a létrehozó űrlapot', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/app/control-plane/projects/page.tsx'),
      'utf8',
    )
    assert.match(src, /WorkProjectCatalog/)
    assert.match(src, /Új projektet ettől még létrehozhatsz/)
    assert.match(src, /<WorkProjectCatalog projects=\{projects\} canEdit=\{canEdit\} \/>/)
  })

  await test('a magyar név ékezet nélkül, kötőjeles kulcsot kap', () => {
    assert.equal(slugifyWorkProjectKey('Ingatlan adásvétel'), 'ingatlan-adasvetel')
    assert.equal(isReservedWorkProjectKey(GENERAL_WORK_PROJECT_KEY), true)
  })

  await test('a lista mindig az Általános gyűjtővel kezdődik', async () => {
    const service = new WorkProjectService(new MemoryWorkProjects())
    const listed = await service.list('tenant-1')
    assert.equal(listed[0]?.builtin, true)
    assert.equal(listed[0]?.key, GENERAL_WORK_PROJECT_KEY)
    assert.equal(listed[0]?.name, 'Általános')
  })

  await test('létrehozás: névből kulcs, foglalt Általános elutasítva, duplikátum elutasítva', async () => {
    const service = new WorkProjectService(new MemoryWorkProjects())
    const created = await service.create({
      tenantId: 'tenant-1',
      name: 'Ingatlan adásvétel',
      actorId: 'user-1',
    })
    assert.equal(created.ok, true)
    if (created.ok) {
      assert.equal(created.project.key, 'ingatlan-adasvetel')
      assert.equal(created.project.name, 'Ingatlan adásvétel')
      assert.equal(created.project.builtin, false)
    }

    const reserved = await service.create({
      tenantId: 'tenant-1',
      name: 'Általános',
      key: '__general__',
      actorId: 'user-1',
    })
    assert.equal(reserved.ok, false)

    const dup = await service.create({
      tenantId: 'tenant-1',
      name: 'Ingatlan adásvétel',
      actorId: 'user-1',
    })
    assert.equal(dup.ok, false)

    const listed = await service.list('tenant-1')
    assert.equal(listed.length, 2)
    assert.equal(listed[1]?.name, 'Ingatlan adásvétel')
  })

  await test('frissítés csak a saját tenant projektjén, a kulcs nem változik', async () => {
    const repo = new MemoryWorkProjects()
    const service = new WorkProjectService(repo)
    const created = await service.create({
      tenantId: 'tenant-1',
      name: 'CRM bevezetés',
      actorId: 'user-1',
    })
    assert.equal(created.ok, true)
    if (!created.ok || !created.project.id) throw new Error('create failed')

    const updated = await service.update({
      tenantId: 'tenant-1',
      id: created.project.id,
      name: 'CRM bevezetés — 2. hullám',
      description: 'Értékesítés és ügyfélszolgálat',
      actorId: 'user-1',
    })
    assert.equal(updated.ok, true)
    if (updated.ok) {
      assert.equal(updated.project.key, 'crm-bevezetes')
      assert.equal(updated.project.name, 'CRM bevezetés — 2. hullám')
    }

    const otherTenant = await service.update({
      tenantId: 'tenant-2',
      id: created.project.id,
      name: 'Hamis',
      actorId: 'user-2',
    })
    assert.equal(otherTenant.ok, false)
  })

  await test('archivált projekt kiesik a választható listából, de a katalógusban marad', async () => {
    const service = new WorkProjectService(new MemoryWorkProjects())
    const created = await service.create({
      tenantId: 'tenant-1',
      name: 'Ingatlan adásvétel',
      description: 'Lakások és telkek',
      actorId: 'user-1',
    })
    assert.equal(created.ok, true)
    if (!created.ok || !created.project.id) throw new Error('create failed')

    const archived = await service.archive({
      tenantId: 'tenant-1',
      id: created.project.id,
      actorId: 'user-1',
      archived: true,
    })
    assert.equal(archived.ok, true)
    if (archived.ok) assert.equal(archived.project.archived, true)

    const assignable = await service.list('tenant-1')
    assert.equal(assignable.some((p) => p.key === 'ingatlan-adasvetel'), false)
    assert.equal(assignable[0]?.key, GENERAL_WORK_PROJECT_KEY)

    const catalog = await service.list('tenant-1', { includeArchived: true })
    const hidden = catalog.find((p) => p.key === 'ingatlan-adasvetel')
    assert.equal(hidden?.archived, true)

    const rejected = await service.assignableKey('tenant-1', 'ingatlan-adasvetel')
    assert.equal(rejected.ok, false)

    const restored = await service.archive({
      tenantId: 'tenant-1',
      id: created.project.id,
      actorId: 'user-1',
      archived: false,
    })
    assert.equal(restored.ok, true)
    const back = await service.assignableKey('tenant-1', 'ingatlan-adasvetel')
    assert.deepEqual(back, { ok: true, key: 'ingatlan-adasvetel' })
  })

  await test('üres vagy hiányzó kulcs az Általános gyűjtőt jelenti, archiváltat nem lehet kiosztani', async () => {
    const service = new WorkProjectService(new MemoryWorkProjects())
    assert.deepEqual(await service.assignableKey('tenant-1', undefined), {
      ok: true,
      key: GENERAL_WORK_PROJECT_KEY,
    })
    assert.deepEqual(await service.assignableKey('tenant-1', '  '), {
      ok: true,
      key: GENERAL_WORK_PROJECT_KEY,
    })
    const missing = await service.assignableKey('tenant-1', 'nincs-ilyen')
    assert.equal(missing.ok, false)
  })

  await test('a választható opciók közül az archivált kiesik, az Általános marad a default', () => {
    assert.equal(effectiveWorkProjectKey(undefined), GENERAL_WORK_PROJECT_KEY)
    assert.equal(effectiveWorkProjectKey(''), GENERAL_WORK_PROJECT_KEY)
    const options = assignableWorkProjectOptions([
      { key: GENERAL_WORK_PROJECT_KEY, name: GENERAL_WORK_PROJECT_NAME },
      { key: 'ingatlan-adasvetel', name: 'Ingatlan adásvétel' },
      { key: 'regi-ugy', name: 'Régi ügy', archived: true },
    ])
    assert.deepEqual(
      options.map((o) => o.key),
      [GENERAL_WORK_PROJECT_KEY, 'ingatlan-adasvetel'],
    )
  })

  await test('a promptba a projekt neve és leírása akkor is bekerül, ha még nincs emlék', () => {
    const block = formatProjectMemoryContextBlock(null, 'ingatlan-adasvetel', {
      key: 'ingatlan-adasvetel',
      name: 'Ingatlan adásvétel',
      description: 'Lakások és telkek — adásvételi ügyek.',
    })
    assert.ok(block)
    assert.match(block, /Projekt: Ingatlan adásvétel/)
    assert.match(block, /Lakások és telkek — adásvételi ügyek\./)
    assert.match(block, /Project memory context \(projekt: Ingatlan adásvétel\)/)
  })

  await test('a promptba a projekt emlékei is bekerülnek a név és a leírás mellé', () => {
    const chunk = {
      id: 'chunk-1',
      type: 'decision',
      path: 'decision/iranyar',
      title: 'Irányár',
      summary: 'A vevő 48 millióig megy.',
      text: 'A vevő 48 millióig megy.',
      tags: [],
      salience: 0.9,
      confidence: 'high',
      score: 0.9,
    }
    const block = formatProjectMemoryContextBlock(
      {
        projectState: {
          focusNarrative: 'Szerződéstervezet vár az ügyvédre.',
          focusChunkId: null,
          decisions: [],
          openTasks: [],
          constraints: [],
          artifacts: [],
          referencedChunkIds: [],
        },
        chunks: [chunk],
        supersedeCandidates: [],
        conflictSets: [],
        scores: { 'chunk-1': 0.9 },
        memoryVersionId: null,
        queryMode: 'normal',
      },
      'ingatlan-adasvetel',
      {
        key: 'ingatlan-adasvetel',
        name: 'Ingatlan adásvétel',
        description: 'Lakások és telkek.',
      },
    )
    assert.ok(block)
    assert.match(block, /Projekt: Ingatlan adásvétel/)
    assert.match(block, /Lakások és telkek\./)
    assert.match(block, /Szerződéstervezet vár az ügyvédre/)
    assert.match(block, /A vevő 48 millióig megy/)
  })

  await test('a beszélgetés, a ticket és a ticketindítás felületén van projektválasztó', () => {
    const chat = readFileSync(
      resolve(import.meta.dirname, '../src/components/agents/agent-chat-panel.tsx'),
      'utf8',
    )
    const composer = readFileSync(
      resolve(import.meta.dirname, '../src/components/agents/agent-chat-composer.tsx'),
      'utf8',
    )
    const ticket = readFileSync(
      resolve(import.meta.dirname, '../src/components/tickets/ticket-detail.tsx'),
      'utf8',
    )
    const createForm = readFileSync(
      resolve(import.meta.dirname, '../src/components/tickets/create-board-ticket-form.tsx'),
      'utf8',
    )
    const taskButton = readFileSync(
      resolve(import.meta.dirname, '../src/components/agents/agent-task-button.tsx'),
      'utf8',
    )
    const catalog = readFileSync(
      resolve(import.meta.dirname, '../src/components/work-projects/work-project-catalog.tsx'),
      'utf8',
    )
    assert.match(composer, /AssignableWorkProjectSelect|WorkProjectSelect/)
    assert.match(chat, /projectKey/)
    assert.match(chat, /GENERAL_WORK_PROJECT_KEY|effectiveWorkProjectKey/)
    assert.match(ticket, /AssignableWorkProjectSelect|WorkProjectSelect/)
    assert.match(createForm, /AssignableWorkProjectSelect|WorkProjectSelect/)
    assert.match(createForm, /projectKey/)
    assert.match(taskButton, /AssignableWorkProjectSelect|WorkProjectSelect/)
    assert.match(catalog, /Archiválás/)
    assert.match(catalog, /archiveWorkProject/)
  })

  await test('új beszélgetés és új ticket a kiválasztott projektkulcsot viszi', () => {
    const chat = readFileSync(
      resolve(import.meta.dirname, '../src/components/agents/agent-chat-panel.tsx'),
      'utf8',
    )
    const createForm = readFileSync(
      resolve(import.meta.dirname, '../src/components/tickets/create-board-ticket-form.tsx'),
      'utf8',
    )
    const stream = readFileSync(
      resolve(import.meta.dirname, '../src/app/api/v1/agent-chat/stream/route.ts'),
      'utf8',
    )
    assert.match(chat, /projectKey/)
    assert.match(chat, /createAgentTaskTicket\([\s\S]*projectKey/)
    assert.match(createForm, /createBoardTicket\([\s\S]*projectKey/)
    assert.match(stream, /services\.workProjects\.assignableKey\(user\.activeTenantId, projectKey\)/)
    assert.match(stream, /projectKey: assignedProjectKey/)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('All passed')
}

void main()
