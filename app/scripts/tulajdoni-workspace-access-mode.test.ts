/**
 * tulajdoni_lap_* workspace accessMode — read-only connector ne írjon.
 *
 * Futtatás: tsx scripts/tulajdoni-workspace-access-mode.test.ts
 */
import assert from 'node:assert/strict'
import {
  isTulajdoniLapEgyeztetesCoverageOnly,
  resolveTulajdoniWorkspaceAccessMode,
} from '../src/lib/tulajdoni-workspace-access'

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

check('egyeztetes JSON-only (Föld frissítés) → write, nem read', () => {
  assert.equal(
    resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_egyeztetes', {
      feldolgozottLapPath: 'feldolgozott-tulajdoni-lap.json',
      nyilvantartasPath: 'tool-outputs/http_api_get_all.json',
      parcelId: 'parcel-1',
    }),
    'write',
  )
})

check('egyeztetes Excel kimenettel → write', () => {
  assert.equal(
    resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_egyeztetes', {
      documentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nyilvantartasPath: 'nyilvantartas.json',
      kimenet: 'egyeztetes.xlsx',
    }),
    'write',
  )
})

check('egyeztetes coverage-only → read', () => {
  const args = { coverageAppliedPath: 'proposal-extract.json' }
  assert.equal(isTulajdoniLapEgyeztetesCoverageOnly(args), true)
  assert.equal(resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_egyeztetes', args), 'read')
})

check('egyeztetes coverage + forrás → nem coverage-only, write', () => {
  const args = {
    coverageAppliedPath: 'proposal-extract.json',
    feldolgozottLapPath: 'feldolgozott-tulajdoni-lap.json',
  }
  assert.equal(isTulajdoniLapEgyeztetesCoverageOnly(args), false)
  assert.equal(resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_egyeztetes', args), 'write')
})

check('parse handoff kimenettel → write', () => {
  assert.equal(
    resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_parse', {
      documentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      kimenet: 'feldolgozott-tulajdoni-lap.json',
    }),
    'write',
  )
})

check('parse handoff nélkül → read', () => {
  assert.equal(
    resolveTulajdoniWorkspaceAccessMode('tulajdoni_lap_parse', {
      documentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nezet: 'osszefoglalo',
    }),
    'read',
  )
})

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('OK — tulajdoni workspace access mode (6 checks)')
