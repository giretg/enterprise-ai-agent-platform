/**
 * #661 MCP-agent paritás: work file append/bináris, agent output-mappa write-gate.
 * Futtatás: npm run test:work-file-output
 */
import assert from 'node:assert/strict'
import { executeGoogleDriveTool } from '../src/domain/enterprise-tools/handlers/google-drive'
import { isOutputFolderWrite } from '../src/domain/enterprise-tools/invoke-enterprise-tool'
import {
  ProjectWorkService,
  WORK_FILE_MAX_BYTES,
  resolveWorkFileBody,
} from '../src/domain/project-work/project-work-service'
import type { WorkFileRecord } from '../src/domain/project-work/types'

const TENANT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

await check('isOutputFolderWrite: csak mappán belüli upload', () => {
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: 'mappa1', outputFolderId: 'mappa1' }), true)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: 'masik', outputFolderId: 'mappa1' }), false)
  assert.equal(isOutputFolderWrite({ toolName: 'google_drive_upload_file', parentFolderId: undefined, outputFolderId: 'mappa1' }), false)
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
