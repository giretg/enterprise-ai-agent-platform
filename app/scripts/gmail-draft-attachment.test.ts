import assert from 'node:assert/strict'
import { buildRawMessage } from '../src/domain/connector-grant/gmail-api-client'

let failures = 0

function test(name: string, run: () => void) {
  try {
    run()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

console.log('Gmail draft attachment (buildRawMessage)\n')

test('melléklet nélkül sima text/plain üzenet marad', () => {
  const msg = decode(buildRawMessage({ to: 'a@b.hu', subject: 'Riport', body: 'szia' }))
  assert.ok(msg.includes('Content-Type: text/plain; charset=utf-8'))
  assert.ok(!msg.includes('multipart/mixed'))
  assert.ok(msg.endsWith('szia'))
})

test('HTML-melléklettel multipart/mixed, base64 test, csatolt fájlnév', () => {
  const html = '<h1>Havi report</h1>'
  const msg = decode(
    buildRawMessage({
      subject: 'havi-report-2026-08',
      body: 'Csatolva küldöm.',
      attachments: [
        {
          fileName: 'havi-report-2026-08.html',
          mimeType: 'text/html',
          contentBase64: Buffer.from(html, 'utf8').toString('base64'),
        },
      ],
    }),
  )
  const boundary = msg.match(/boundary="([^"]+)"/)?.[1]
  assert.ok(boundary, 'van boundary')
  assert.ok(msg.includes('Content-Type: multipart/mixed; boundary='))
  assert.ok(msg.includes('Content-Disposition: attachment; filename="havi-report-2026-08.html"'))
  assert.ok(msg.includes('Content-Transfer-Encoding: base64'))
  // a melléklet dekódolva visszaadja az eredeti HTML-t
  const part = msg.split(`--${boundary}`)[2]
  const b64 = part.split('\r\n\r\n')[1].replace(/\s+/g, '')
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), html)
  assert.ok(msg.trimEnd().endsWith(`--${boundary}--`))
})

test('nem-ASCII fájlnév RFC 2231 filename*-gal is szerepel', () => {
  const msg = decode(
    buildRawMessage({
      subject: 's',
      body: 'b',
      attachments: [
        { fileName: 'árjelentés.html', mimeType: 'text/html', contentBase64: 'eA==' },
      ],
    }),
  )
  assert.ok(msg.includes("filename*=UTF-8''"))
  assert.ok(!/Content-Disposition:[^\r\n]*[^\x00-\x7F]/.test(msg), 'a header ASCII-safe')
})

console.log(failures === 0 ? '\nAll passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
