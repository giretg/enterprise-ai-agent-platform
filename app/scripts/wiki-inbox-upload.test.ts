/**
 * A tálca-feltöltés kimenetei és méretkorlátai. A futó app útját az
 * `e2e/wiki-control-plane.spec.ts` fedi; itt az okok szétválasztása és az a szabály
 * van, hogy a 25 MB-os fájlnak minden rétegen át kell férnie.
 */
import assert from 'node:assert/strict'
import nextConfig from '../next.config'
import { MAX_INBOX_FILE_BYTES, uploadInboxFile, type InboxUploadResult } from '../src/components/knowledge/wiki/wiki-inbox-upload'
import { KB_MAX_FILE_BYTES } from '../src/domain/knowledge-base/knowledge-base-service'

const MB = 1024 * 1024

function file(content = 'tartalom') {
  return new File([content], 'anyag.docx', { type: 'application/test' })
}

async function main() {
  // Sikeres feltöltés: a beolvasott tartalom, név és típus megy tovább.
  let sent: File | null = null
  const queued = await uploadInboxFile(file(), async (copy) => {
    sent = copy
    return { success: true, data: { status: 'queued' } }
  })
  assert.deepEqual(queued, { kind: 'queued' })
  const sentFile = sent as unknown as File
  assert.equal(await sentFile.text(), 'tartalom')
  assert.equal(sentFile.name, 'anyag.docx')
  assert.equal(sentFile.type, 'application/test')

  assert.deepEqual(
    await uploadInboxFile(file(), async () => ({ success: true, data: { status: 'duplicate' } })),
    { kind: 'duplicate' },
  )

  // Olvashatatlan fájl (felhős helyőrző): a szerverig el sem jut.
  class UnreadableFile extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      throw new DOMException('A requested file could not be read', 'NotReadableError')
    }
  }
  let calls = 0
  assert.deepEqual(
    await uploadInboxFile(new UnreadableFile(['x'], 'felho.xlsx'), async (): Promise<InboxUploadResult> => {
      calls++
      return { success: true, data: { status: 'queued' } }
    }),
    { kind: 'unreadable' },
  )
  assert.equal(calls, 0)

  // A szerver elutasítása megőrzi a hibakódot; a megszakadt kérés külön ok.
  assert.deepEqual(
    await uploadInboxFile(file(), async () => ({ success: false, error: 'forbidden' })),
    { kind: 'rejected', error: 'forbidden' },
  )
  assert.deepEqual(
    await uploadInboxFile(file(), async () => {
      throw new TypeError('Failed to fetch')
    }),
    { kind: 'interrupted' },
  )

  // A kliens és a szerver ugyanazt a korlátot érvényesíti.
  assert.equal(MAX_INBOX_FILE_BYTES, KB_MAX_FILE_BYTES)

  // A proxy és a server action is átengedi a legnagyobb fájlt a multipart-borítékkal.
  // A proxy korlátja nélkül a törzs csonkolódik: „Unexpected end of form”, HTTP 500.
  const envelopeBytes = 64 * 1024
  const experimental = nextConfig.experimental
  for (const [layer, limit] of [
    ['proxyClientMaxBodySize', experimental?.proxyClientMaxBodySize],
    ['serverActions.bodySizeLimit', experimental?.serverActions?.bodySizeLimit],
  ] as const) {
    assert.equal(typeof limit, 'string', `${layer}: hiányzik a next.config.ts-ből`)
    const match = /^(\d+)mb$/.exec(String(limit))
    assert.ok(match, `${layer}: „<szám>mb” alakú korlátot várunk`)
    assert.ok(Number(match[1]) * MB >= KB_MAX_FILE_BYTES + envelopeBytes, `${layer}: kisebb a legnagyobb feltölthető fájlnál`)
  }

  console.log('wiki-inbox-upload: OK')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
