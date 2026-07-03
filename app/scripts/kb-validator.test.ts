/**
 * Determinisztikus teszt a KB-v3 §7.6 OKF-validátorhoz.
 * Futtatás: npm run test:kb-validator
 *
 * DB NÉLKÜL fut. A `buildOkfBundle` valós kimenetén és kézzel rontott
 * bundle-ökön igazolja: tiszta bundle → ok; hiányzó frontmatter/mező /
 * connector-mismatch / broken link → error; üres oldal / hiányzó forrás-link /
 * külső link / érzékeny adat → warning; source-link coverage arány.
 */
import assert from 'node:assert/strict'
import { buildOkfBundle, type OkfBundle } from '../src/lib/kb-v3'
import { validateOkfBundle } from '../src/lib/kb-validator'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const CONNECTOR = '11111111-1111-4111-a111-111111111111'

/** Segéd: egy tartalmi oldal tartalmának cseréje a bundle-ben. */
function patchPage(bundle: OkfBundle, index: number, content: string): OkfBundle {
  const files = bundle.files.map((f) => ({ ...f }))
  const pages = files.filter((f) => f.path !== 'index.md')
  pages[index].content = content
  return { ...bundle, files }
}

async function run() {
  console.log('=== KB-v3 §7.6 OKF-validator teszt ===')

  await check('tiszta buildOkfBundle → ok, teljes source coverage', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# Remote Work\nSzabályok itt.\n\n# Onboarding\nLépések itt.',
      connectorId: CONNECTOR,
      sourceDocumentId: 'doc-1',
    })
    const res = validateOkfBundle(bundle, { connectorId: CONNECTOR })
    assert.equal(res.ok, true)
    assert.equal(res.errors, 0)
    assert.equal(res.pageCount, 2)
    assert.equal(res.sourceLinkCoverage, 1)
    assert.equal(res.brokenLinks, 0)
  })

  await check('connector-mismatch a frontmatterben → error', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nszöveg',
      connectorId: CONNECTOR,
    })
    const res = validateOkfBundle(bundle, { connectorId: 'másik-connector' })
    assert.equal(res.ok, false)
    assert.ok(res.issues.some((i) => i.code === 'connector_mismatch'))
  })

  await check('hiányzó frontmatter blokk → error', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nszöveg',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(bundle, 0, '# A\ncsak törzs, nincs frontmatter\n\n## Source\n- Forrás: `x`')
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.equal(res.ok, false)
    assert.ok(res.issues.some((i) => i.code === 'frontmatter_missing'))
  })

  await check('hiányzó kötelező mező (title) → error', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nszöveg',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(
      bundle,
      0,
      `---\ntype: Section\nconnector_id: "${CONNECTOR}"\n---\n\n# A\ntörzs\n\n## Source\n- Forrás: \`x\``,
    )
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.ok(res.issues.some((i) => i.code === 'missing_field'))
    assert.equal(res.ok, false)
  })

  await check('törött belső link → error, brokenLinks számol', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nszöveg',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(
      bundle,
      0,
      `---\ntype: Section\ntitle: "A"\nconnector_id: "${CONNECTOR}"\n---\n\n# A\nLásd [ezt](../nincs/ilyen.md).\n\n## Source\n- Forrás: \`x\``,
    )
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.equal(res.brokenLinks, 1)
    assert.ok(res.issues.some((i) => i.code === 'broken_link'))
    assert.equal(res.ok, false)
  })

  await check('valós index→pages link nem törött', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nx\n\n# B\ny',
      connectorId: CONNECTOR,
    })
    const res = validateOkfBundle(bundle, { connectorId: CONNECTOR })
    assert.equal(res.brokenLinks, 0)
  })

  await check('hiányzó ## Source → warning, coverage < 1', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nx\n\n# B\ny',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(
      bundle,
      0,
      `---\ntype: Section\ntitle: "A"\nconnector_id: "${CONNECTOR}"\n---\n\n# A\nérdemi törzs itt\n`,
    )
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.ok(res.issues.some((i) => i.code === 'missing_source_link'))
    assert.equal(res.sourceLinkCoverage, 0.5)
    assert.equal(res.ok, true) // warning, nem error
  })

  await check('üres oldal → warning', () => {
    const bundle = buildOkfBundle({
      filename: 'empty.md',
      extractedText: '',
      connectorId: CONNECTOR,
    })
    const res = validateOkfBundle(bundle, { connectorId: CONNECTOR })
    assert.ok(res.issues.some((i) => i.code === 'empty_page'))
  })

  await check('külső link → warning, externalLinks számol', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nx',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(
      bundle,
      0,
      `---\ntype: Section\ntitle: "A"\nconnector_id: "${CONNECTOR}"\n---\n\n# A\nLásd [ext](https://example.com/x).\n\n## Source\n- Forrás: \`x\``,
    )
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.equal(res.externalLinks, 1)
    assert.ok(res.issues.some((i) => i.code === 'external_link'))
  })

  await check('érzékeny adat (email + kártyaszám) → warning', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nx',
      connectorId: CONNECTOR,
    })
    const broken = patchPage(
      bundle,
      0,
      `---\ntype: Section\ntitle: "A"\nconnector_id: "${CONNECTOR}"\n---\n\n# A\nEmail: john@example.com, kártya 4111 1111 1111 1111.\n\n## Source\n- Forrás: \`x\``,
    )
    const res = validateOkfBundle(broken, { connectorId: CONNECTOR })
    assert.ok(res.sensitiveHits >= 1)
    assert.ok(res.issues.some((i) => i.code === 'sensitive_data'))
  })

  await check('index.md-re nincs kötelező connector_id / source elvárás', () => {
    const bundle = buildOkfBundle({
      filename: 'policy.md',
      extractedText: '# A\nx',
      connectorId: CONNECTOR,
    })
    const res = validateOkfBundle(bundle, { connectorId: CONNECTOR })
    assert.ok(!res.issues.some((i) => i.path === 'index.md' && i.severity === 'error'))
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

void run()
