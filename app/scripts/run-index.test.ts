/**
 * RA-03 — `run_index` tool (szkóp-feloldás, futás-fejlécek).
 * Futtatás: npm run test:run-index
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUN_INDEX_NOT_FOUND,
  RunIndexNotFoundError,
  selectRunIndexCandidates,
} from '../src/domain/run-analysis/run-index-service'
import {
  TOOL_GROUP_ANALYSIS,
  TOOL_REGISTRY,
} from '../src/domain/tool-broker/tool-registry'
import { SIDE_EFFECTING_TOOLS, TOOL_TRUST_REGISTRY } from '../src/domain/tool-broker/tool-trust-registry'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

async function main() {
  console.log('=== RA-03 run_index ===')

  await test('selectRunIndexCandidates: legutóbbi N, dedupe grain:id szerint', () => {
    const base = Date.parse('2026-08-01T00:00:00Z')
    const { selected, truncated } = selectRunIndexCandidates(
      [
        { grain: 'turn', id: 't-old', startedAt: new Date(base) },
        { grain: 'ticket', id: 'k-1', startedAt: new Date(base + 5_000) },
        { grain: 'process', id: 'p-1', startedAt: new Date(base + 8_000) },
        { grain: 'turn', id: 't-new', startedAt: new Date(base + 10_000) },
        { grain: 'turn', id: 't-old', startedAt: new Date(base + 1_000) },
      ],
      3,
    )
    assert.equal(selected.length, 3)
    assert.equal(truncated, true)
    assert.deepEqual(
      selected.map((s) => `${s.grain}:${s.id}`),
      ['turn:t-new', 'process:p-1', 'ticket:k-1'],
    )
  })

  await test('selectRunIndexCandidates: kevesebb mint limit → truncated false', () => {
    const { truncated, selected } = selectRunIndexCandidates(
      [{ grain: 'turn', id: 'a', startedAt: new Date() }],
      5,
    )
    assert.equal(truncated, false)
    assert.equal(selected.length, 1)
  })

  await test('RunIndexNotFoundError: run_not_found üzenet', () => {
    const err = new RunIndexNotFoundError()
    assert.equal(err.message, RUN_INDEX_NOT_FOUND)
  })

  await test('registry: run_index chat-only, external_untrusted, Futás-elemzés csoport', () => {
    const d = TOOL_REGISTRY.run_index
    assert.deepEqual(d.surfaces, ['chat'])
    assert.equal(d.sideEffecting, false)
    assert.equal(d.trust, 'external_untrusted')
    assert.equal(d.capabilityGroup, TOOL_GROUP_ANALYSIS)
    assert.equal(d.handlerId, 'run_index')
    assert.equal(TOOL_TRUST_REGISTRY.run_index, 'external_untrusted')
    assert.equal(SIDE_EFFECTING_TOOLS.run_index, false)
  })

  await test('forrásszerződés: discoverCandidates take-korlátos', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /const take = filters\.fetchLimit/)
    assert.match(src, /fetchLimit: limit \+ 1/)
  })

  await test('forrásszerződés: run_analyst önelemzés kizárva + audit', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /RUN_ANALYST_SYSTEM_ROLE/)
    assert.match(src, /analysis\.run_index/)
  })

  if (failures > 0) {
    console.error(`\n${failures} hiba`)
    process.exit(1)
  }
  console.log('\nMinden run_index teszt OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
