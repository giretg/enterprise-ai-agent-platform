/**
 * Workspace-handoff invariánsok (issue #377).
 *
 * Üzleti kockázat: a playbook átadja a path stringet (pl. feldolgozottLapPath),
 * de a workspace ticket-szintű. A következő lépés FILE_NOT_FOUND-ot kap, miközben
 * a slotGaps üres — a név átment, a bájtok nem. Emberi csatolás nélkül a 2. agent
 * nem tudja elolvasni az 1. lépés fájlját.
 *
 * Futtatás: npm run test:workspace-handoff
 */
process.env.FILE_EDITOR_STUB = 'true'
process.env.FILE_EDITOR_STUB_MEMORY = 'true'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'
import {
  HandoffFileMissingError,
  assertRequiredHandoffFilesPresent,
  collectHandoffCandidatePaths,
  collectRequiredHandoffPaths,
  copyWorkspaceHandoff,
} from '../src/domain/playbook/workspace-handoff'

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

const TENANT = 'handoff-tenant'

async function main() {
  console.log('workspace-handoff')

  await check('collect: relatív fájlnév kiterjesztéssel jelölt path', () => {
    assert.deepEqual(
      collectHandoffCandidatePaths({
        feldolgozottLapPath: 'feldolgozott-tulajdoni-lap-043-15.json',
      }),
      ['feldolgozott-tulajdoni-lap-043-15.json'],
    )
  })

  await check('collect: könyvtáros relatív path kiterjesztés nélkül is jelölt', () => {
    assert.deepEqual(collectHandoffCandidatePaths({ report: 'out/napi-riport' }), [
      'out/napi-riport',
    ])
  })

  await check('collect: ./ prefix normalizálása', () => {
    assert.deepEqual(collectHandoffCandidatePaths({ path: './foo.json' }), ['foo.json'])
  })

  await check('collect: abszolút, /tmp, Windows, URL, traversal és e-mail kiesik', () => {
    assert.deepEqual(
      collectHandoffCandidatePaths({
        users: '/Users/agent/out.json',
        tmp: '/tmp/tl_extracted_043.json',
        win: 'C:\\temp\\lap.json',
        https: 'https://example.com/file.json',
        http: 'http://example.com/file.json',
        fileUrl: 'file:///tmp/lap.json',
        traversal: '../secret.json',
        nested: 'out/../../etc/passwd',
        empty: '',
        prose: 'ready',
        email: 'user@company.com',
      }),
      [],
    )
  })

  await check('collect: minden relatív, perjeles path elfogadott', () => {
    assert.deepEqual(
      collectHandoffCandidatePaths({ spaced: 'exports/2026 final', numeric: '043/15' }),
      ['exports/2026 final', '043/15'],
    )
  })

  await check('required: csak explicit path/artifact nevű slotból lesz fail-closed fájl', () => {
    assert.deepEqual(
      collectRequiredHandoffPaths({
        ownerEmail: 'user@company.com',
        hrsz: '043/15',
        feldolgozottLapPath: 'exports/2026 final',
        sourceArtifact: 'handoff.json',
      }),
      ['exports/2026 final', 'handoff.json'],
    )
  })

  await check('required: tulajdoni-lap kimenetből csak a path-slot kötelező fájl', () => {
    assert.deepEqual(
      collectRequiredHandoffPaths({
        status: 'ready',
        feldolgozottLapPath: 'feldolgozott-tulajdoni-lap-043-15.json',
        ingatlan: 'Külterület, 43/15 helyrajzi szám',
        tulajdonosDb: 182,
      }),
      ['feldolgozott-tulajdoni-lap-043-15.json'],
    )
  })

  await check('collect: nem-string és üres érték kimarad; dedupe stabil sorrend', () => {
    assert.deepEqual(
      collectHandoffCandidatePaths({
        a: 'first.json',
        n: 12,
        b: './first.json',
        c: 'second.json',
        nested: { path: 'third.json' },
      }),
      ['first.json', 'second.json'],
    )
  })

  await check('copy: A ticket workspace-éből B-be másol, hiányzó path missing listában', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const fromTicketId = randomUUID()
    const toTicketId = randomUUID()
    const present = Buffer.from('handoff-bytes', 'utf8')
    await storage.write(TENANT, fromTicketId, 'feldolgozott-tulajdoni-lap.json', present)

    const result = await copyWorkspaceHandoff({
      storage,
      tenantId: TENANT,
      fromTicketId,
      toTicketId,
      paths: ['feldolgozott-tulajdoni-lap.json', 'nincs-ilyen.json'],
    })

    assert.deepEqual(result.copied, ['feldolgozott-tulajdoni-lap.json'])
    assert.deepEqual(result.missing, ['nincs-ilyen.json'])
    const copied = await storage.read(TENANT, toTicketId, 'feldolgozott-tulajdoni-lap.json')
    assert.ok(copied)
    assert.equal(copied.toString('utf8'), 'handoff-bytes')
    assert.equal(await storage.read(TENANT, toTicketId, 'nincs-ilyen.json'), null)
  })

  await check('copy: bináris tartalom és audience marker átmegy', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const fromTicketId = randomUUID()
    const toTicketId = randomUUID()
    const binary = Buffer.from([0, 1, 2, 255, 0, 10])
    await storage.write(TENANT, fromTicketId, 'scan.bin', binary)
    await storage.setFileAudience(TENANT, fromTicketId, 'scan.bin', 'user')

    const result = await copyWorkspaceHandoff({
      storage,
      tenantId: TENANT,
      fromTicketId,
      toTicketId,
      paths: ['scan.bin'],
    })

    assert.deepEqual(result.copied, ['scan.bin'])
    const copied = await storage.read(TENANT, toTicketId, 'scan.bin')
    assert.ok(copied)
    assert.deepEqual([...copied], [0, 1, 2, 255, 0, 10])
    assert.equal(await storage.getFileAudience(TENANT, toTicketId, 'scan.bin'), 'user')
  })

  await check('assert: hiányzó kötelező path → HandoffFileMissingError', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const ticketId = randomUUID()
    await assert.rejects(
      () =>
        assertRequiredHandoffFilesPresent({
          storage,
          tenantId: TENANT,
          ticketId,
          requiredPaths: ['feldolgozott-tulajdoni-lap.json'],
        }),
      (e: unknown) =>
        e instanceof HandoffFileMissingError &&
        e.ticketId === ticketId &&
        e.missingPaths.includes('feldolgozott-tulajdoni-lap.json'),
    )
  })

  await check('assert: meglévő kötelező path átmegy', async () => {
    const storage = new WorkspaceStorage('test-bucket')
    const ticketId = randomUUID()
    await storage.write(TENANT, ticketId, 'out/riport.json', Buffer.from('{}'))
    await assertRequiredHandoffFilesPresent({
      storage,
      tenantId: TENANT,
      ticketId,
      requiredPaths: ['out/riport.json'],
    })
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden workspace-handoff invariáns zöld')
}

void main()
