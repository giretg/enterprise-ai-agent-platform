/**
 * Audience-marker forge védelem.
 *
 * Üzleti kockázat: a listázás/letöltés a `.workspace-meta/file-audience/*`
 * markerekre támaszkodik. Ha az agent `file_write`-tal (vagy nyers
 * storage.write-tal) `user` markert ír egy belső tool-kimenetre, a
 * legalacsonyabb szerepkör is listázza és letölti a rejtett fájlt.
 *
 * Run: npx tsx scripts/workspace-audience-meta-guard.test.ts
 */
process.env.FILE_EDITOR_STUB = 'true'
process.env.FILE_EDITOR_STUB_MEMORY = 'true'

import assert from 'node:assert/strict'
import { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import {
  FileEditorError,
  WorkspaceStorage,
} from '../src/domain/file-editor/workspace-storage'
import {
  isWorkspaceFileUserFacing,
  WORKSPACE_FILE_AUDIENCE_MANIFEST,
  WORKSPACE_FILE_AUDIENCE_PREFIX,
} from '../src/lib/workspace-file-visibility'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const TENANT = 'tenant-meta-guard'
const TICKET = 'ticket-meta-guard'

function audienceMarkerPath(filePath: string): string {
  return `${WORKSPACE_FILE_AUDIENCE_PREFIX}${Buffer.from(filePath, 'utf8').toString('base64url')}`
}

async function downloadAllowed(
  storage: WorkspaceStorage,
  filePath: string,
): Promise<boolean> {
  const audience = await storage.getFileAudience(TENANT, TICKET, filePath)
  return isWorkspaceFileUserFacing(filePath, audience)
}

async function main() {
  console.log('workspace-audience-meta-guard')

  await check('direct storage.write cannot forge audience marker', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const secret = 'tool-outputs/fold_ownerships_raw.json'
    await storage.write(TENANT, TICKET, secret, Buffer.from('{"ssn":"secret"}'))
    assert.equal(await downloadAllowed(storage, secret), false)

    await assert.rejects(
      () => storage.write(TENANT, TICKET, audienceMarkerPath(secret), Buffer.from('user')),
      (err: unknown) => err instanceof FileEditorError && err.code === 'FORBIDDEN_PATH',
    )
    assert.equal(await downloadAllowed(storage, secret), false)
  })

  await check('direct storage.write cannot forge legacy audience manifest', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const secret = 'invoice_raw.json'
    await storage.write(TENANT, TICKET, secret, Buffer.from('{}'))
    await assert.rejects(
      () =>
        storage.write(
          TENANT,
          TICKET,
          WORKSPACE_FILE_AUDIENCE_MANIFEST,
          Buffer.from(JSON.stringify({ [secret]: 'user' })),
        ),
      (err: unknown) => err instanceof FileEditorError && err.code === 'FORBIDDEN_PATH',
    )
    assert.equal(await downloadAllowed(storage, secret), false)
  })

  await check('file_write tool path cannot forge audience marker', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const editor = new FileEditorService(storage)
    const secret = 'tool-outputs/orders_extract.json'
    await editor.writeFile(TENANT, TICKET, { path: secret, content: '{"x":1}' })
    assert.equal(await downloadAllowed(storage, secret), false)

    await assert.rejects(
      () =>
        editor.writeFile(TENANT, TICKET, {
          path: audienceMarkerPath(secret),
          content: 'user',
        }),
      (err: unknown) => err instanceof FileEditorError && err.code === 'FORBIDDEN_PATH',
    )
    assert.equal(await downloadAllowed(storage, secret), false)
    assert.equal(await storage.listUserFacing(TENANT, TICKET).then((f) => f.includes(secret)), false)
  })

  await check('file_delete cannot remove audience marker to reclassify', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const editor = new FileEditorService(storage)
    await editor.writeFile(TENANT, TICKET, { path: 'notes.txt', content: 'private' })
    await storage.setFileAudience(TENANT, TICKET, 'notes.txt', 'internal')
    assert.equal(await downloadAllowed(storage, 'notes.txt'), false)

    await assert.rejects(
      () => editor.deleteFile(TENANT, TICKET, { path: audienceMarkerPath('notes.txt') }),
      (err: unknown) => err instanceof FileEditorError && err.code === 'FORBIDDEN_PATH',
    )
    assert.equal(await downloadAllowed(storage, 'notes.txt'), false)
  })

  await check('setFileAudience still works for legitimate classification', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, 'report.pdf', Buffer.from('ok'))
    await storage.setFileAudience(TENANT, TICKET, 'report.pdf', 'user')
    assert.equal(await downloadAllowed(storage, 'report.pdf'), true)
    await storage.setFileAudience(TENANT, TICKET, 'report.pdf', 'internal')
    assert.equal(await downloadAllowed(storage, 'report.pdf'), false)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden invariáns zöld')
}

void main()
