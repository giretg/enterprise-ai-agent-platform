/**
 * Gateway kontextus-fejléc szűrők — DB nélküli, tiszta logikai tesztek.
 *
 * Invariáns: a publikus gateway végpont NEM megbízható `x-agent-version` /
 * `x-ticket-id` fejléceiből csak TÁROLHATÓ érték juthat a `ModelCall` rekordba
 * (`agent_version Int`, `ticket_id @db.Uuid`). Egy érvénytelen fejléc `undefined`
 * (a hívás lefut és rögzül, csak a hibás kontextus esik ki) — SOHA nem `NaN` vagy
 * nem-UUID szemét, ami a rekord perzisztálását — a modellhívás UTÁN — megbuktatná
 * és a költséget láthatatlanul kiejtené a keretből.
 *
 * Futtatás: npm run test:gateway-request-context
 */
import assert from 'node:assert/strict'
import {
  parseAgentVersionHeader,
  parseTicketIdHeader,
} from '../src/lib/gateway-request-context'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

// ── parseAgentVersionHeader ────────────────────────────────────────────────

check('agent-version: érvényes egész átmegy', () => {
  assert.equal(parseAgentVersionHeader('3'), 3)
  assert.equal(parseAgentVersionHeader('0'), 0)
  assert.equal(parseAgentVersionHeader(' 12 '), 12)
})

check('agent-version: nem-számjegy → undefined (NEM NaN)', () => {
  // A regresszió lényege: a régi `Number.parseInt('abc', 10)` NaN-t adott, amit a
  // hívó `?? currentVersion` fallbackje nem fogott, és egy Int oszlopba írva a
  // ModelCall rögzítése elbukott a (már megtörtént, díjazott) modellhívás után.
  const result = parseAgentVersionHeader('abc')
  assert.equal(result, undefined)
  assert.equal(Number.isNaN(result as unknown as number), false)
})

check('agent-version: hiányzó / üres / null → undefined', () => {
  assert.equal(parseAgentVersionHeader(null), undefined)
  assert.equal(parseAgentVersionHeader(undefined), undefined)
  assert.equal(parseAgentVersionHeader(''), undefined)
  assert.equal(parseAgentVersionHeader('   '), undefined)
})

check('agent-version: tört / negatív / vegyes → undefined', () => {
  assert.equal(parseAgentVersionHeader('1.5'), undefined) // "1.5" nem tisztán számjegy
  assert.equal(parseAgentVersionHeader('-1'), undefined)
  assert.equal(parseAgentVersionHeader('3px'), undefined)
  assert.equal(parseAgentVersionHeader('1e3'), undefined)
})

// ── parseTicketIdHeader ────────────────────────────────────────────────────

check('ticket-id: érvényes UUID átmegy (kis- és nagybetű)', () => {
  const lower = '2f1a4c9e-1b2c-4d3e-8f9a-0b1c2d3e4f5a'
  assert.equal(parseTicketIdHeader(lower), lower)
  const upper = '2F1A4C9E-1B2C-4D3E-8F9A-0B1C2D3E4F5A'
  assert.equal(parseTicketIdHeader(upper), upper)
  assert.equal(parseTicketIdHeader(`  ${lower}  `), lower)
})

check('ticket-id: nem-UUID → undefined (nem jut @db.Uuid oszlopba)', () => {
  assert.equal(parseTicketIdHeader('abc'), undefined)
  assert.equal(parseTicketIdHeader('123'), undefined)
  assert.equal(parseTicketIdHeader('2f1a4c9e-1b2c-4d3e-8f9a'), undefined) // csonka
  assert.equal(parseTicketIdHeader("' OR 1=1 --"), undefined)
})

check('ticket-id: hiányzó / üres / null → undefined', () => {
  assert.equal(parseTicketIdHeader(null), undefined)
  assert.equal(parseTicketIdHeader(undefined), undefined)
  assert.equal(parseTicketIdHeader(''), undefined)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
