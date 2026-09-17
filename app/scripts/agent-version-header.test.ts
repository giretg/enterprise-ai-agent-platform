/**
 * `x-agent-version` gateway-fejléc validáció regressziók.
 * Futtatás: npm run test:agent-version-header
 *
 * A kulcs-invariáns: nem-numerikus / negatív / szemét fejléc SOHA nem adhat
 * `NaN`-t vagy negatív számot, mert az a fizetős modellhívás UTÁN buktatná a
 * `model_calls` rögzítést (néma költség- és audit-rés). Minden érvénytelen
 * bemenet `undefined` → a hívó a `?? agent.currentVersion` fallbackre esik.
 */
import assert from 'node:assert/strict'
import { parseAgentVersionHeader } from '../src/lib/agent-version-header'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    console.error(`✗ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

// Érvényes egész értékek átmennek.
check('valid integer', () => assert.equal(parseAgentVersionHeader('7'), 7))
check('zero is valid', () => assert.equal(parseAgentVersionHeader('0'), 0))
check('whitespace trimmed', () => assert.equal(parseAgentVersionHeader('  12  '), 12))
check('trailing garbage truncates like parseInt', () =>
  assert.equal(parseAgentVersionHeader('3abc'), 3))

// Érvénytelen bemenet → undefined (a fallback lép).
check('non-numeric → undefined (nincs NaN)', () =>
  assert.equal(parseAgentVersionHeader('abc'), undefined))
check('empty string → undefined', () => assert.equal(parseAgentVersionHeader(''), undefined))
check('whitespace only → undefined', () => assert.equal(parseAgentVersionHeader('   '), undefined))
check('null → undefined', () => assert.equal(parseAgentVersionHeader(null), undefined))
check('undefined → undefined', () => assert.equal(parseAgentVersionHeader(undefined), undefined))
check('negative → undefined', () => assert.equal(parseAgentVersionHeader('-5'), undefined))
check('leading-plus garbage → undefined vagy szám, de sosem NaN', () => {
  const out = parseAgentVersionHeader('+')
  assert.ok(out === undefined || Number.isInteger(out))
})

// Explicit invariáns: a visszaadott érték sosem NaN.
check('return value is never NaN', () => {
  for (const raw of ['abc', 'NaN', 'Infinity', '1e10x', '  ', '-1', 'v3']) {
    const out = parseAgentVersionHeader(raw)
    assert.ok(out === undefined || Number.isInteger(out), `raw=${raw} → ${out}`)
    assert.ok(!Number.isNaN(out as number), `raw=${raw} produced NaN`)
  }
})

console.log(`\nagent-version-header: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
