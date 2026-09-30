/**
 * #661 MCP-agent paritás: work file append/bináris, agent output-mappa write-gate.
 * Futtatás: npm run test:work-file-output
 */
import assert from 'node:assert/strict'
import { executeGoogleDriveTool } from '../src/domain/enterprise-tools/handlers/google-drive'
import {
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  invokeEnterpriseTool,
  isOutputFolderWrite,
  type EnterpriseToolDeps,
} from '../src/domain/enterprise-tools'
import {
  ProjectWorkService,
  WORK_FILE_MAX_BYTES,
  resolveWorkFileBody,
} from '../src/domain/project-work/project-work-service'
import type { WorkFileRecord } from '../src/domain/project-work/types'

const TENANT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEFINITION = '44444444-4444-4444-8444-444444444444'
const CONNECTOR = '55555555-5555-4555-8555-555555555555'

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

class MemFiles {
  rows = new Map<string, WorkFileRecord>()
  private readonly appendQueues = new Map<string, Promise<unknown>>()
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
  async appendAtomic(input: {
    tenantId: string
    projectKey: string
    path: string
    chunk: string
    lastWriterUserId: string
    maxFileBytes: number
    maxProjectBytes: number
    maxCount: number
  }) {
    const key = this.key(input.tenantId, input.projectKey, input.path)
    const prev = this.appendQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.appendQueues.set(
      key,
      prev.then(() => gate),
    )
    await prev
    try {
      await Promise.resolve()
      const existing = this.rows.get(key)
      const content = `${existing?.content ?? ''}${input.chunk}`
      const byteSize = Buffer.byteLength(content, 'utf8')
      if (byteSize > input.maxFileBytes) return { ok: false as const, code: 'file_too_large' as const }
      const quota = await this.quota(input.tenantId, input.projectKey)
      const nextCount = existing ? quota.count : quota.count + 1
      const nextBytes = quota.bytes - (existing?.byteSize ?? 0) + byteSize
      if (nextCount > input.maxCount || nextBytes > input.maxProjectBytes) {
        return { ok: false as const, code: 'quota_exceeded' as const }
      }
      const row = await this.upsert({
        tenantId: input.tenantId,
        projectKey: input.projectKey,
        path: input.path,
        content,
        byteSize,
        lastWriterUserId: input.lastWriterUserId,
      })
      return { ok: true as const, record: row }
    } finally {
      release()
    }
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

const projects = {
  async listByTenant() {
    return []
  },
  async findByKey() {
    return null
  },
  async create(input: { tenantId: string; key: string; name: string; description: string | null; createdById: string }) {
    const now = new Date()
    return { id: globalThis.crypto.randomUUID(), ...input, createdAt: now, updatedAt: now, archivedAt: null }
  },
}
const memory = {
  async listActive() {
    return []
  },
  async findById() {
    return null
  },
  async insertActive() {
    throw new Error('not needed')
  },
}
const users = { async findManyByIds(ids: string[]) { return ids.map((id) => ({ id, name: id })) } }

function service(outputFolder: string | null = null) {
  return new ProjectWorkService(
    projects as never,
    new MemFiles() as never,
    memory as never,
    {
      async findMemoryWriteMode() {
        return 'approval' as const
      },
      async updateMemoryWriteMode() {},
      async findOutputFolder() {
        return outputFolder
      },
      async updateOutputFolder() {},
    },
    users as never,
  )
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

async function main() {
await check('30 egymás utáni append sorrendhelyes', async () => {
  const svc = service()
  for (let i = 0; i < 30; i++) {
    const res = await svc.appendFile({ tenantId: TENANT, path: 'data/naplo.jsonl', content: `sor${i}\n`, userId: ANNA })
    assert.equal(res.ok, true)
  }
  const read = await svc.readFile({ tenantId: TENANT, path: 'data/naplo.jsonl' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  const lines = read.file.content.trim().split('\n')
  assert.equal(lines.length, 30)
  lines.forEach((line, i) => assert.equal(line, `sor${i}`))
})

await check('párhuzamos append megőrzi az összes chunkot (nincs lost-update)', async () => {
  const svc = service()
  const chunks = Array.from({ length: 40 }, (_, i) => `P${i}`)
  const results = await Promise.all(
    chunks.map((line) =>
      svc.appendFile({ tenantId: TENANT, path: 'data/parallel.jsonl', content: `${line}\n`, userId: ANNA }),
    ),
  )
  assert.ok(results.every((res) => res.ok), 'minden append ok')
  const read = await svc.readFile({ tenantId: TENANT, path: 'data/parallel.jsonl' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  const lines = read.file.content.trim().split('\n')
  assert.equal(lines.length, 40)
  assert.deepEqual([...lines].sort(), [...chunks].sort())
})

await check('append túllépéskor file_too_large, kvóta érvényesül', async () => {
  const svc = service()
  const big = 'x'.repeat(WORK_FILE_MAX_BYTES - 10)
  const first = await svc.writeFile({ tenantId: TENANT, path: 'data/nagy.txt', content: big, userId: ANNA })
  assert.equal(first.ok, true)
  const over = await svc.appendFile({ tenantId: TENANT, path: 'data/nagy.txt', content: 'y'.repeat(20), userId: ANNA })
  assert.equal(over.ok, false)
  if (over.ok) return
  assert.equal(over.code, 'file_too_large')
  const read = await svc.readFile({ tenantId: TENANT, path: 'data/nagy.txt' })
  assert.equal(read.ok && read.file.content, big)
})

await check('write contentBase64 roundtrip (HTML)', async () => {
  const svc = service()
  const html = '<html><body>Riport áéű</body></html>'
  const res = await svc.writeFile({ tenantId: TENANT, path: 'riport.html', contentBase64: b64(html), userId: ANNA })
  assert.equal(res.ok, true)
  const read = await svc.readFile({ tenantId: TENANT, path: 'riport.html' })
  assert.equal(read.ok && read.file.content, html)
})

await check('érvénytelen törzs: üres / mindkettő / egyik sem / bináris → invalid_content', async () => {
  assert.equal(resolveWorkFileBody({}).ok, false)
  assert.equal(resolveWorkFileBody({ content: 'a', contentBase64: b64('a') }).ok, false)
  assert.equal(resolveWorkFileBody({ contentBase64: '!!!nem-base64!!!' }).ok, false)
  assert.equal(resolveWorkFileBody({ contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') }).ok, false)
  const svc = service()
  const res = await svc.writeFile({ tenantId: TENANT, path: 'rossz.txt', userId: ANNA })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'invalid_content')
})

await check('isOutputFolderWrite: mappán belüli vagy hiányzó parent, különben nem', () => {
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: 'mappa1', outputFolderId: 'mappa1' }), true)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: undefined, outputFolderId: 'mappa1' }), true)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: '  ', outputFolderId: 'mappa1' }), true)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: 'masik', outputFolderId: 'mappa1' }), false)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: undefined, outputFolderId: null }), false)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: 'mappa1', outputFolderId: null }), false)
  assert.equal(isOutputFolderWrite({ toolName: 'google_sheets_write_range', parentFolderId: 'mappa1', outputFolderId: 'mappa1' }), false)
  assert.equal(isOutputFolderWrite({ toolName: 'gmail_send', parentFolderId: 'mappa1', outputFolderId: 'mappa1' }), false)
})

await check('drive upload: textContent és contentBase64 stubbal', async () => {
  const text = (await executeGoogleDriveTool(
    'google_drive_upload_file',
    { name: 'riport.html', textContent: '<h1>Riport</h1>' },
    'stub-token',
  )) as { file: { name: string } }
  assert.equal(text.file.name, 'riport.html')
  const binary = (await executeGoogleDriveTool(
    'google_drive_upload_file',
    { name: 'kep.png', contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' },
    'stub-token',
  )) as { file: { name: string; mimeType: string } }
  assert.equal(binary.file.name, 'kep.png')
  assert.equal(binary.file.mimeType, 'image/png')
  await assert.rejects(() =>
    executeGoogleDriveTool('google_drive_upload_file', { name: 'semmi.txt' }, 'stub-token'),
  )
})

await check('output-mappa upload: hiányzó parent azonnal fut, más mappa approval', async () => {
  const FOLDER = 'mappa1'
  const writer = {
    snapshot: {
      name: 'Writer',
      roleInstruction: 'Write',
      skills: [],
      connectors: [{ connectorId: CONNECTOR, type: 'google_drive', accessMode: 'write' }],
      capabilities: [{ toolName: GOOGLE_DRIVE_UPLOAD_FILE_TOOL, allowed: true }],
    },
  }
  function uploadDeps(outputFolderId: string | null): {
    deps: EnterpriseToolDeps
    uploaded: Array<Record<string, unknown>>
    enqueued: string[]
  } {
    const uploaded: Array<Record<string, unknown>> = []
    const enqueued: string[] = []
    const deps: EnterpriseToolDeps = {
      async findConnector() {
        return { id: CONNECTOR, tenantId: TENANT, type: 'google_drive', authMode: 'user_delegated', lifecycleState: 'active' }
      },
      async findActiveGrant() {
        return { id: 'grant', tokenRef: 'stub-drive-token', scopes: ['https://www.googleapis.com/auth/drive'], status: 'active' }
      },
      async loadDefinition() {
        return { definitionId: DEFINITION, agentId: AGENT, version: 1, tenantId: TENANT, status: 'active', publishedAt: '2026-01-02T00:00:00.000Z', ...writer }
      },
      async findCurrentDefinitionId() {
        return DEFINITION
      },
      async findAgentGrant() {
        return { accessLevel: 'operate' }
      },
      async resolveAccessToken() {
        return 'stub-drive-token'
      },
      async findAgentOutputFolder() {
        return outputFolderId
      },
      async executeDriveTool(_tool, args) {
        uploaded.push(args)
        return { file: { name: args.name } }
      },
      async enqueueWrite(input) {
        enqueued.push(input.toolName)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'awaiting_approval' }) }] }
      },
    }
    return { deps, uploaded, enqueued }
  }
  const principal = { userId: ANNA, tenantId: TENANT, role: 'admin', assumed: false }
  const body = { definitionId: DEFINITION, name: 'riport.html', textContent: '<h1>ok</h1>', idempotencyKey: 'up-1' }

  const inside = uploadDeps(FOLDER)
  const direct = await invokeEnterpriseTool(inside.deps, {
    principal,
    toolName: GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
    args: body,
  })
  assert.equal(direct.isError, undefined)
  assert.equal(inside.enqueued.length, 0)
  assert.equal(inside.uploaded[0]?.parentFolderId, FOLDER)

  const outside = uploadDeps(FOLDER)
  const queued = await invokeEnterpriseTool(outside.deps, {
    principal,
    toolName: GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
    args: { ...body, parentFolderId: 'masik', idempotencyKey: 'up-2' },
  })
  assert.equal(queued.isError, undefined)
  assert.deepEqual(outside.enqueued, [GOOGLE_DRIVE_UPLOAD_FILE_TOOL])
  assert.equal(outside.uploaded.length, 0)

  const none = uploadDeps(null)
  const alsoQueued = await invokeEnterpriseTool(none.deps, {
    principal,
    toolName: GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
    args: body,
  })
  assert.equal(alsoQueued.isError, undefined)
  assert.deepEqual(none.enqueued, [GOOGLE_DRIVE_UPLOAD_FILE_TOOL])
})

await check('get/setOutputFolder: érvényesítés', async () => {
  let stored: string | null = null
  const svc = new ProjectWorkService(
    projects as never,
    new MemFiles() as never,
    memory as never,
    {
      async findMemoryWriteMode() {
        return 'approval' as const
      },
      async updateMemoryWriteMode() {},
      async findOutputFolder() {
        return stored
      },
      async updateOutputFolder(_agentId: string, folderId: string | null) {
        stored = folderId
      },
    },
    users as never,
  )
  const set = await svc.setOutputFolder(AGENT, TENANT, 'mappa1')
  assert.equal(set.ok && set.folderId, 'mappa1')
  const get = await svc.getOutputFolder(AGENT, TENANT)
  assert.equal(get.ok && get.folderId, 'mappa1')
  const bad = await svc.setOutputFolder(AGENT, TENANT, 'nem mappa!!!')
  assert.equal(bad.ok, false)
  const cleared = await svc.setOutputFolder(AGENT, TENANT, '  ')
  assert.equal(cleared.ok && cleared.folderId, null)
})

if (failures > 0) {
  console.log(`\n${failures} hiba`)
  process.exit(1)
}
console.log('\nMinden ellenőrzés átment.')
}

void main()
