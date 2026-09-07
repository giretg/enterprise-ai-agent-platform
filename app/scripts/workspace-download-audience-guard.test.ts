/**
 * Workspace letöltés-kapu invariánsai (broken-access-control javítás).
 *
 * Üzleti kockázat, amit ez a teszt őriz: a workspace-fájllista SZÁNDÉKOSAN
 * elrejti a felhasználó elől az agent belső munka-fájljait (nyers tool-kimenetek,
 * kivonat-JSON-ok, `.workspace-meta` markerek). Korábban a letöltő végpont ezt a
 * döntést NEM ismételte meg: egy nyers `?path=…`-sal a legalacsonyabb szerepkör
 * is lehúzhatta a rejtett fájlokat. Ez a teszt a javítás két alappillérét
 * rögzíti:
 *
 *  1. `WorkspaceStorage.safeObjectPath` — a tár maga utasítja el a `..`
 *     útvonal-kilépést, függetlenül attól, melyik hívó (route vagy szolgáltatás)
 *     adta a bemenetet.
 *  2. `getFileAudience` + `isWorkspaceFileUserFacing` — a letöltés a listázással
 *     AZONOS user/internal döntést hozza; a rejtett fájl 404-et kap.
 *
 * Run: npx tsx scripts/workspace-download-audience-guard.test.ts
 */
process.env.FILE_EDITOR_STUB = 'true'
process.env.FILE_EDITOR_STUB_MEMORY = 'true'

import assert from 'node:assert/strict'
import {
  FileEditorError,
  WorkspaceStorage,
  safeObjectPath,
} from '../src/domain/file-editor/workspace-storage'
import { isWorkspaceFileUserFacing } from '../src/lib/workspace-file-visibility'

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

const TENANT = 'tenant-a'
const TICKET = 'ticket-1'

/**
 * A letöltő route lényegi kapuja, tár-szinten reprodukálva: normalizál, feloldja
 * a közönség-besorolást, majd a listázással azonos user-facing döntést hoz.
 * `true` = letölthető, `false` = a route 404-et adna.
 */
async function downloadAllowed(
  storage: WorkspaceStorage,
  rawPath: string,
): Promise<boolean> {
  let safePath: string
  try {
    safePath = safeObjectPath(rawPath)
  } catch {
    return false
  }
  const audience = await storage.getFileAudience(TENANT, TICKET, safePath)
  return isWorkspaceFileUserFacing(safePath, audience)
}

async function main() {
  console.log('workspace-download-audience-guard')

  await check('safeObjectPath rejects `..` traversal', () => {
    assert.throws(() => safeObjectPath('../../etc/passwd'), FileEditorError)
    assert.throws(() => safeObjectPath('a/../../b'), FileEditorError)
    assert.throws(() => safeObjectPath('deliverables/../../secret'), FileEditorError)
  })

  await check('safeObjectPath rejects absurdly long names (no raw ENAMETOOLONG)', () => {
    // Egy modell-válasz került útvonal helyére: lokálisan nyers ENAMETOOLONG lett
    // belőle, GCS-en pedig némán létrejött volna egy több száz karakteres kulcs.
    assert.throws(() => safeObjectPath('x'.repeat(600)), /too long/)
    assert.throws(() => safeObjectPath(`${'y'.repeat(240)}.json`), /too long/)
    assert.throws(() => safeObjectPath('rossz\nnev.json'), /control characters/)
    assert.equal(safeObjectPath('rendben/nev.json'), 'rendben/nev.json')
  })

  await check('safeObjectPath normalizes `.` and duplicate slashes', () => {
    assert.equal(safeObjectPath('./a//b/./c.txt'), 'a/b/c.txt')
    assert.equal(safeObjectPath('/leading/slash.txt'), 'leading/slash.txt')
  })

  await check('storage read/write/delete reject traversal at the tár boundary', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await assert.rejects(() => storage.read(TENANT, TICKET, '../escape.txt'), FileEditorError)
    await assert.rejects(
      () => storage.write(TENANT, TICKET, '../escape.txt', Buffer.from('x')),
      FileEditorError,
    )
    await assert.rejects(() => storage.delete(TENANT, TICKET, '../escape.txt'), FileEditorError)
    await assert.rejects(
      () => storage.streamToClient(TENANT, TICKET, '../escape.txt'),
      FileEditorError,
    )
  })

  await check('user-uploaded file is downloadable (audience=user)', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, 'report.pdf', Buffer.from('hello'))
    await storage.setFileAudience(TENANT, TICKET, 'report.pdf', 'user')
    assert.equal(await storage.getFileAudience(TENANT, TICKET, 'report.pdf'), 'user')
    assert.equal(await downloadAllowed(storage, 'report.pdf'), true)
  })

  await check('agent-internal file (audience=internal) is NOT downloadable', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, 'draft.docx', Buffer.from('scratch'))
    await storage.setFileAudience(TENANT, TICKET, 'draft.docx', 'internal')
    assert.equal(await storage.getFileAudience(TENANT, TICKET, 'draft.docx'), 'internal')
    assert.equal(await downloadAllowed(storage, 'draft.docx'), false)
  })

  await check('technical paths are hidden even without a marker', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, '.tool-results/raw.json', Buffer.from('{}'))
    await storage.write(TENANT, TICKET, 'invoice_raw.json', Buffer.from('{}'))
    await storage.write(TENANT, TICKET, '.workspace-meta/file-audience.json', Buffer.from('{}'))
    assert.equal(await downloadAllowed(storage, '.tool-results/raw.json'), false)
    assert.equal(await downloadAllowed(storage, 'invoice_raw.json'), false)
    assert.equal(await downloadAllowed(storage, '.workspace-meta/file-audience.json'), false)
  })

  await check('normalized alias of a hidden path is still blocked', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, '.workspace-meta/x', Buffer.from('secret'))
    // Nyers, „ártatlannak látszó" alias — a normalizálás után ugyanaz a rejtett path.
    assert.equal(await downloadAllowed(storage, './.workspace-meta//x'), false)
  })

  await check('marker survives non-normalized write path (set with ./alias)', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    await storage.write(TENANT, TICKET, 'out/result.txt', Buffer.from('x'))
    await storage.setFileAudience(TENANT, TICKET, './out//result.txt', 'internal')
    // A letöltés a normalizált néven jön — a markernek meg kell találnia.
    assert.equal(await downloadAllowed(storage, 'out/result.txt'), false)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden invariáns zöld')
}

void main()
