/**
 * GitHub Contents base64 dekódolás — determinisztikus unit teszt.
 * Futtatás: npx tsx scripts/decode-github-contents.test.ts
 */
import assert from 'node:assert/strict'
import {
  decodeGitHubContentsBody,
  isProbablyBinaryBuffer,
} from '../src/domain/connector/decode-github-contents-body'

let failures = 0
async function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function main() {
  console.log('decode-github-contents-body')

  await test('dekódolja a GitHub Contents fájl base64 tartalmát', () => {
    const markdown = '# Riportok\n\nA reporting menüpont…\n'
    const body = decodeGitHubContentsBody({
      type: 'file',
      encoding: 'base64',
      content: b64(markdown),
      path: 'docs/felhasznaloi-kezikonyv.md',
      name: 'felhasznaloi-kezikonyv.md',
      sha: 'abc123',
      download_url: 'https://raw.githubusercontent.com/x/y/main/docs/f.md',
    }) as Record<string, unknown>
    assert.equal(body.encoding, 'utf-8')
    assert.equal(body.content, markdown)
    assert.equal(body.byteLength, Buffer.byteLength(markdown, 'utf8'))
  })

  await test('whitespace-es base64-et is kezel (GitHub sortörések)', () => {
    const text = 'hello world'
    const wrapped = b64(text).match(/.{1,4}/g)!.join('\n')
    const body = decodeGitHubContentsBody({
      type: 'file',
      encoding: 'base64',
      content: wrapped,
      path: 'a.txt',
    }) as Record<string, unknown>
    assert.equal(body.content, text)
  })

  await test('nem nyúl hozzá a könyvtárlistához / más JSON-hoz', () => {
    const dir = [{ type: 'file', name: 'a.md' }]
    assert.equal(decodeGitHubContentsBody(dir), dir)
    const other = { ok: true, items: [1, 2] }
    assert.equal(decodeGitHubContentsBody(other), other)
    const already = { type: 'file', encoding: 'utf-8', content: 'plain' }
    assert.equal(decodeGitHubContentsBody(already), already)
  })

  await test('érvénytelen base64-et nem dekódol kásává', () => {
    const body = {
      type: 'file',
      encoding: 'base64',
      content: 'ez nem base64!!! csak úgy néz ki',
      path: 'a.txt',
      sha: 'abc',
    }
    // Változatlanul megy tovább — a Buffer némán eldobná a nem base64 karaktereket.
    assert.equal(decodeGitHubContentsBody(body), body)
  })

  await test('könyvtárlistából kiveszi a redundáns URL-mezőket', () => {
    const listing = [
      {
        name: 'app',
        path: 'app',
        type: 'dir',
        size: 0,
        sha: 'aaa',
        url: 'https://api.github.com/repos/o/r/contents/app?ref=main',
        git_url: 'https://api.github.com/repos/o/r/git/trees/aaa',
        html_url: 'https://github.com/o/r/tree/main/app',
        download_url: null,
        _links: { self: 'x', git: 'y', html: 'z' },
      },
    ]
    const trimmed = decodeGitHubContentsBody(listing) as Array<Record<string, unknown>>
    assert.equal(trimmed.length, 1)
    assert.equal(trimmed[0].name, 'app')
    assert.equal(trimmed[0].path, 'app')
    assert.equal(trimmed[0].type, 'dir')
    assert.equal(trimmed[0].html_url, 'https://github.com/o/r/tree/main/app')
    assert.equal('url' in trimmed[0], false)
    assert.equal('git_url' in trimmed[0], false)
    assert.equal('_links' in trimmed[0], false)
    assert.ok(
      JSON.stringify(trimmed).length < JSON.stringify(listing).length / 1.5,
      'a trimmelt lista érdemben kisebb',
    )
  })

  await test('bináris tartalmat nem ad vissza szövegként', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(isProbablyBinaryBuffer(binary), true)
    const body = decodeGitHubContentsBody({
      type: 'file',
      encoding: 'base64',
      content: binary.toString('base64'),
      path: 'icon.png',
      name: 'icon.png',
    }) as Record<string, unknown>
    assert.equal(body.encoding, 'binary')
    assert.equal(body.content, null)
    assert.match(String(body.decodeNote), /Bináris/)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
