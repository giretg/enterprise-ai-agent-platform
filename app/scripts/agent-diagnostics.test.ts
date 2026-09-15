/**
 * Futtatás: npx tsx scripts/agent-diagnostics.test.ts
 *
 * Az agent-diagnosztika tiszta rétege: statikus checkek + próba-segédek.
 * DB/hálózat nélkül.
 */
import assert from 'node:assert/strict'
import {
  computeAgentDiagnostics,
} from '../src/domain/agent-diagnostics/agent-diagnostics'
import {
  probeResultToCheck,
  sanitizeProbeError,
} from '../src/domain/agent-diagnostics/agent-probes'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

test('üres agent: nincs vizsgálandó eszköz (unknown)', () => {
  const checks = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [],
    isDraft: false,
  })
  assert.equal(checks.length, 1)
  assert.equal(checks[0].id, 'empty')
  assert.equal(checks[0].status, 'unknown')
  assert.equal(checks[0].fixSection, 'eszkozok')
})

test('engedélyezett gmail eszköz kötés nélkül: fail a kapcsolatokra mutat', () => {
  const checks = computeAgentDiagnostics({
    allowedTools: ['gmail_search', 'gmail_create_draft'],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [],
    isDraft: false,
  })
  const binding = checks.find((c) => c.id === 'binding:gmail')
  assert.ok(binding)
  assert.equal(binding.status, 'fail')
  assert.equal(binding.fixSection, 'kapcsolatok')
})

test('gmail írás scope-hiány: fail (az elfelejtett írásjog esete)', () => {
  const checks = computeAgentDiagnostics({
    allowedTools: ['gmail_create_draft'],
    boundConnectorTypes: ['gmail'],
    gmailSendCovered: false,
    driveWriteCovered: null,
    skills: [],
    isDraft: false,
  })
  const write = checks.find((c) => c.id === 'write:gmail')
  assert.ok(write)
  assert.equal(write.status, 'fail')
  assert.equal(write.fixSection, 'kapcsolatok')
})

test('drive írás scope-hiány: fail, lefedve: ok selected_only megjegyzéssel', () => {
  const missing = computeAgentDiagnostics({
    allowedTools: ['google_drive_create_folder'],
    boundConnectorTypes: ['google_drive'],
    gmailSendCovered: null,
    driveWriteCovered: false,
    skills: [],
    isDraft: false,
  })
  assert.equal(missing.find((c) => c.id === 'write:drive')?.status, 'fail')

  const covered = computeAgentDiagnostics({
    allowedTools: ['google_drive_create_folder'],
    boundConnectorTypes: ['google_drive'],
    gmailSendCovered: null,
    driveWriteCovered: true,
    driveWriteIsSelectedOnly: true,
    skills: [],
    isDraft: false,
  })
  const ok = covered.find((c) => c.id === 'write:drive')
  assert.equal(ok?.status, 'ok')
  assert.match(ok?.detail ?? '', /kijelölt/)
})

test('piros skill: fail, sárga: warn, zöld: ok', () => {
  const red = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [{ name: 'Számlázó', color: 'red', enabled: true }],
    isDraft: false,
  })
  assert.equal(red.find((c) => c.id === 'skills')?.status, 'fail')

  const yellow = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [{ name: 'Számlázó', color: 'yellow', enabled: true }],
    isDraft: false,
  })
  assert.equal(yellow.find((c) => c.id === 'skills')?.status, 'warn')

  const green = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [{ name: 'Számlázó', color: 'green', enabled: true }],
    isDraft: false,
  })
  assert.equal(green.find((c) => c.id === 'skills')?.status, 'ok')
})

test('letiltott skill nem számít', () => {
  const checks = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [{ name: 'Számlázó', color: 'red', enabled: false }],
    isDraft: false,
  })
  assert.equal(checks.find((c) => c.id === 'skills'), undefined)
})

test('vázlat: warn a motor-szekcióra mutat', () => {
  const checks = computeAgentDiagnostics({
    allowedTools: [],
    boundConnectorTypes: [],
    gmailSendCovered: null,
    driveWriteCovered: null,
    skills: [],
    isDraft: true,
  })
  const lifecycle = checks.find((c) => c.id === 'lifecycle')
  assert.ok(lifecycle)
  assert.equal(lifecycle.status, 'warn')
})

test('sanitizeProbeError: titok/host soha nem kerül a válaszba', () => {
  assert.equal(sanitizeProbeError(new Error('probe timeout')), 'timeout')
  assert.equal(sanitizeProbeError(new Error('gmail.search auth failed: 401')), 'auth_failed')
  assert.equal(sanitizeProbeError(new Error('grant_token_expired')), 'auth_failed')
  assert.equal(sanitizeProbeError(new Error('boom https://secret-host/x token abc')), 'request_failed')
})

test('probeResultToCheck: unknown marad unknown, fix-szekció megmarad', () => {
  const check = probeResultToCheck({
    id: 'live:xyz',
    label: 'Egyszarvú connector: automatikus próba nincs',
    outcome: 'unknown',
    reason: 'not_testable',
    fixSection: 'kapcsolatok',
    fixHint: 'Kézzel ellenőrizd.',
  })
  assert.equal(check.status, 'unknown')
  assert.equal(check.fixSection, 'kapcsolatok')
})

console.log('\nAll agent-diagnostics tests passed.')
