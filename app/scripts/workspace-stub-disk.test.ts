/**
 * FILE_EDITOR_STUB lemezre ír — túléli a „process/újraindítás” szimulációt
 * (új WorkspaceStorage példány, üres memória-Map).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-stub-disk-'))
  const prevStub = process.env.FILE_EDITOR_STUB
  const prevMemory = process.env.FILE_EDITOR_STUB_MEMORY
  const prevDir = process.env.WORKSPACE_STUB_DIR

  process.env.FILE_EDITOR_STUB = 'true'
  delete process.env.FILE_EDITOR_STUB_MEMORY
  process.env.WORKSPACE_STUB_DIR = root

  try {
    const tenantId = 'tenant-disk'
    const ticketId = 'ticket-disk'
    const writer = new WorkspaceStorage('test-bucket')
    await writer.write(tenantId, ticketId, 'augusztus.xlsx', Buffer.from('PK-fake-xlsx'))
    await writer.setFileAudience(tenantId, ticketId, 'augusztus.xlsx', 'user')
    await writer.write(tenantId, ticketId, 'egyeztetes_progress.json', Buffer.from('{"ok":true}'))

    // Új példány + üres memória-Map szimuláció (globalThis Map-et nem töröljük,
    // de a disk mód nem abból olvas).
    const reader = new WorkspaceStorage('test-bucket')
    assert.deepEqual(await reader.listUserFacing(tenantId, ticketId), [
      'augusztus.xlsx',
      'egyeztetes_progress.json',
    ])
    const xlsx = await reader.read(tenantId, ticketId, 'augusztus.xlsx')
    assert.equal(xlsx?.toString('utf8'), 'PK-fake-xlsx')

    const deleted = await reader.deleteTicketWorkspace(tenantId, ticketId)
    assert.equal(deleted, 3) // xlsx + progress + audience marker
    assert.deepEqual(await reader.list(tenantId, ticketId), [])
  } finally {
    if (prevStub === undefined) delete process.env.FILE_EDITOR_STUB
    else process.env.FILE_EDITOR_STUB = prevStub
    if (prevMemory === undefined) delete process.env.FILE_EDITOR_STUB_MEMORY
    else process.env.FILE_EDITOR_STUB_MEMORY = prevMemory
    if (prevDir === undefined) delete process.env.WORKSPACE_STUB_DIR
    else process.env.WORKSPACE_STUB_DIR = prevDir
    await rm(root, { recursive: true, force: true })
  }

  console.log('workspace stub disk tests passed')
}

void main()
