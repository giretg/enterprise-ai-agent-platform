/**
 * Beágyazott agent-chat — allowlist-tárolás (#481 D7) és a modell-kontextus
 * burkolat (#481 D4).
 * Futtatás: npx tsx scripts/embed-apps.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMBED_CONTEXT_MAX_BYTES,
  embeddedContextByteSize,
  embeddedContextToModelPrefix,
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

const apps = [{ slug: 'crm', name: 'CRM', origin: 'https://crm.example.com' }]

test('embeddedContextToModelPrefix: engedélyezett slug → burkolt prefix a szerverről', () => {
  const res = embeddedContextToModelPrefix(apps, { appSlug: 'crm', label: 'Ügy', data: { id: 1 } })
  assert.ok(res.ok)
  assert.match(res.prefix, /<<<EXTERNAL_UNTRUSTED_DATA source="embedded_app:crm">>>/)
  assert.match(res.prefix, /Ügy: \{"id":1\}/)
})

test('embeddedContextToModelPrefix: ismeretlen slug / üres allowlist elutasítva (forrás-címke nem hamisítható)', () => {
  assert.deepEqual(
    embeddedContextToModelPrefix(apps, { appSlug: 'evil', label: 'x', data: {} }),
    { ok: false, reason: 'app_not_allowed' },
  )
  assert.deepEqual(
    embeddedContextToModelPrefix([], { appSlug: 'crm', label: 'x', data: {} }),
    { ok: false, reason: 'app_not_allowed' },
  )
})

test('8 kB kapu: bájtban mér (UTF-8), a label is beleszámít, felette elutasít', () => {
  assert.equal(embeddedContextByteSize({ label: 'é', data: '' }), new TextEncoder().encode('é: ""').length)
  const bigLabel = 'á'.repeat(EMBED_CONTEXT_MAX_BYTES / 2) // 2 bájt/karakter → önmagában kitölti a keretet
  assert.deepEqual(
    embeddedContextToModelPrefix(apps, { appSlug: 'crm', label: bigLabel, data: { id: 1 } }),
    { ok: false, reason: 'too_large' },
  )
  assert.ok(embeddedContextToModelPrefix(apps, { appSlug: 'crm', label: 'ok', data: 'x'.repeat(8000) }).ok)
})
