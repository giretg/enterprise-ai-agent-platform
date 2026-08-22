/**
 * Privacy highlight injektálás: rehype-raw csak a biztonságos `<mark>` cimkéket
 * kaphatja. A marker jelenléte NEM nyithat raw HTML XSS-t a chat UI-n.
 *
 * Futtatás: npm run test:privacy-markdown-highlights
 */
import assert from 'node:assert/strict'
import { injectPrivacyHighlights } from '../src/lib/privacy-markdown-highlights'
import type { PrivacyEntityMarker } from '../src/domain/privacy/privacy-observability'

function marker(
  start: number,
  end: number,
  overrides: Partial<PrivacyEntityMarker> = {},
): PrivacyEntityMarker {
  return {
    start,
    end,
    category: 'email',
    categoryLabel: 'E-mail',
    displayValue: 'x@y.z',
    status: 'applied',
    action: 'tokenize',
    previewAlias: '[[EMAIL_1]]',
    source: 'pattern',
    ...overrides,
  }
}

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('privacy-markdown-highlights')

check('kiemelés <mark>-kal, szöveg escape nélkül is olvasható', () => {
  const text = 'Írd meg a foo@bar.com címre'
  const start = text.indexOf('foo@bar.com')
  const out = injectPrivacyHighlights(text, [marker(start, start + 'foo@bar.com'.length)])
  assert.match(out, /<mark class="privacy-applied" title="[^"]*">foo@bar\.com<\/mark>/)
  assert.equal(out.includes('<script'), false)
})

check('üzenetben lévő raw HTML escape-elődik (XSS a marker mellett)', () => {
  const payload = '<img src=x onerror=alert(1)>'
  const email = 'a@b.c'
  const text = `${payload} majd ${email}`
  const start = text.indexOf(email)
  const out = injectPrivacyHighlights(text, [marker(start, start + email.length)])
  assert.equal(out.includes('<img'), false)
  assert.equal(out.includes('onerror'), true) // szövegként megmarad
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(out, /<mark class="privacy-applied"[^>]*>a@b\.c<\/mark>/)
})

check('marker belsejében lévő HTML breakout escape-elődik', () => {
  const evil = '</mark><script>alert(1)</script><mark>'
  const text = `előtte ${evil} utána`
  const start = text.indexOf(evil)
  const out = injectPrivacyHighlights(text, [marker(start, start + evil.length)])
  assert.equal(out.includes('<script>'), false)
  assert.match(out, /&lt;\/mark&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;mark&gt;/)
  // Pontosan egy nyitó <mark class=…> a generált cimke.
  assert.equal((out.match(/<mark /g) ?? []).length, 1)
  assert.equal((out.match(/<\/mark>/g) ?? []).length, 1)
})

check('tooltip title attribútum escape-elődik', () => {
  const text = 'x@y.z'
  const out = injectPrivacyHighlights(text, [
    marker(0, text.length, {
      categoryLabel: 'E-mail "onclick=alert(1)"',
    }),
  ])
  assert.match(out, /title="[^"]*&quot;[^"]*"/)
  assert.equal(out.includes('title="E-mail "onclick'), false)
})

check('markdown hangsúly (**) megmarad escape után is', () => {
  const text = 'Nézd: **fontos** és a@b.c'
  const start = text.indexOf('a@b.c')
  const out = injectPrivacyHighlights(text, [marker(start, start + 5)])
  assert.match(out, /\*\*fontos\*\*/)
})

check('üres / hiányzó marker → eredeti szöveg (nincs rehype-raw szükség)', () => {
  assert.equal(injectPrivacyHighlights('sima <b>html</b>', []), 'sima <b>html</b>')
})

if (failures > 0) {
  console.log(`\n${failures} hiba`)
  process.exit(1)
}
console.log('\nMinden teszt zöld.')
