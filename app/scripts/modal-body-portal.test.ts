/**
 * Regresszió: a feladat-indító és a dispatch-prompt modál body-ra portaloz.
 *
 * A Munkatársak kártyán `hover:-translate-y-1` (CSS transform) van. A transform
 * containing blockot csinál a `position: fixed` gyereknek — ha a modal a kártya
 * DOM-jában marad, hoverre ugrál és a szomszéd avatar átüt rajta.
 *
 * Run: npx tsx scripts/modal-body-portal.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ❌ ${name}`)
    console.error(error)
  }
}

const root = resolve(import.meta.dirname, '..')

function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8')
}

function assertBodyPortal(source: string, label: string) {
  assert.match(source, /createPortal/, `${label}: hiányzik a createPortal`)
  assert.match(source, /document\.body/, `${label}: hiányzik a document.body cél`)
  // A fixed overlay a portal gyerekében maradhat — de a return nem lehet
  // nyers <div className="fixed…"> createPortal nélkül.
  const portalCall = source.indexOf('createPortal(')
  const fixedOverlay = source.indexOf('fixed inset-0')
  assert.ok(portalCall >= 0, `${label}: createPortal( hívás`)
  assert.ok(fixedOverlay >= 0, `${label}: fixed overlay`)
  assert.ok(
    portalCall < fixedOverlay || source.includes('createPortal(\n    <div\n      className="fixed'),
    `${label}: a fixed overlay createPortal alatt legyen`,
  )
}

console.log('\nModal body portal\n')

test('agent-task-button body-ra portaloz', () => {
  assertBodyPortal(readSrc('src/components/agents/agent-task-button.tsx'), 'agent-task-button')
})

test('ticket-dispatch-prompt-modal body-ra portaloz', () => {
  assertBodyPortal(
    readSrc('src/components/tickets/ticket-dispatch-prompt-modal.tsx'),
    'ticket-dispatch-prompt-modal',
  )
})

test('a registry kártya továbbra is transformos (miért kell a portal)', () => {
  const card = readSrc('src/components/agents/agent-registry-card.tsx')
  assert.match(
    card,
    /hover:-translate-y-1/,
    'ha a hover-transform eltűnik, a portal indoka is változhat',
  )
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nmodal-body-portal tests passed')
