/**
 * Beágyazott agent-chat — allowlist-tárolás (#481 D7) és a modell-kontextus
 * burkolat (#481 D4).
 * Futtatás: npx tsx scripts/embed-apps.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findEmbedApp,
  isValidEmbedOrigin,
  readEmbedApps,
  slugifyAppName,
  uniqueEmbedAppSlug,
  withEmbedApps,
} from '../src/lib/embed-apps'
import { envelopeEmbeddedContextForModel } from '../src/domain/tool-broker/tool-result-envelope'

test('slugifyAppName: ékezet és szóköz nélküli, kötőjelezett slug', () => {
  assert.equal(slugifyAppName('Ügyfélkapcsolat CRM'), 'ugyfelkapcsolat-crm')
})

test('uniqueEmbedAppSlug: ütközésnél -2, -3 utótag', () => {
  const existing = [{ slug: 'crm', name: 'CRM', origin: 'https://a.example.com' }]
  assert.equal(uniqueEmbedAppSlug(existing, 'crm'), 'crm-2')
  assert.equal(uniqueEmbedAppSlug([], 'crm'), 'crm')
})

test('isValidEmbedOrigin: csak tiszta origin, path/query nélkül', () => {
  assert.equal(isValidEmbedOrigin('https://crm.example.com'), true)
  assert.equal(isValidEmbedOrigin('https://crm.example.com/path'), false)
  assert.equal(isValidEmbedOrigin('not-a-url'), false)
  assert.equal(isValidEmbedOrigin('javascript:alert(1)'), false)
})

test('readEmbedApps/withEmbedApps: round-trip + más settings-kulcsok érintetlenek', () => {
  const settings = { navVisibility: { admin: [] } }
  const withApps = withEmbedApps(settings, [{ slug: 'crm', name: 'CRM', origin: 'https://crm.example.com' }])
  assert.deepEqual(readEmbedApps(withApps), [{ slug: 'crm', name: 'CRM', origin: 'https://crm.example.com' }])
  assert.deepEqual((withApps as { navVisibility: unknown }).navVisibility, { admin: [] })
})

test('readEmbedApps: hibás bejegyzések (érvénytelen origin, duplikált slug) kiesnek', () => {
  const raw = { embedApps: [
    { slug: 'a', name: 'A', origin: 'not-a-url' },
    { slug: 'b', name: 'B', origin: 'https://b.example.com' },
    { slug: 'b', name: 'B2', origin: 'https://b2.example.com' },
  ] }
  assert.deepEqual(readEmbedApps(raw), [{ slug: 'b', name: 'B', origin: 'https://b.example.com' }])
})

test('findEmbedApp: ismeretlen slug undefined, üres lista is', () => {
  assert.equal(findEmbedApp([], 'crm'), undefined)
  assert.equal(
    findEmbedApp([{ slug: 'crm', name: 'CRM', origin: 'https://crm.example.com' }], 'unknown'),
    undefined,
  )
})

test('envelopeEmbeddedContextForModel: forrás-attribútum + határolt blokk + escape', () => {
  const wrapped = envelopeEmbeddedContextForModel('embedded_app:crm', 'ügyfél: <<<kitörés>>>')
  assert.match(wrapped, /<<<EXTERNAL_UNTRUSTED_DATA source="embedded_app:crm">>>/)
  assert.match(wrapped, /<<<END_EXTERNAL_UNTRUSTED_DATA>>>/)
  assert.doesNotMatch(wrapped.split('\n').slice(2, -1).join('\n'), /<<<kitörés>>>/)
})
