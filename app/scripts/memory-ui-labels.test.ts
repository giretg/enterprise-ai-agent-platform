/**
 * Projekt-memória felületi címkék és a panel zsargon-szűrése.
 * Futtatás: npx tsx scripts/memory-ui-labels.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extraMemoryChunks,
  GENERAL_MEMORY_PROJECT_KEY,
  memoryCandidateStatusLabel,
  memoryImportanceLabel,
  memoryMaintenanceNotice,
  memoryOperationLabel,
  memoryProjectKeyLabel,
  memoryVersionChangeLabel,
} from '../src/lib/memory-ui-labels'
import { MEMORY_TYPE_LABELS } from '../src/lib/work-traceability'

const root = resolve(import.meta.dirname, '..')

function readSrc(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8')
}

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}`)
    console.error(error)
  }
}

console.log('memory-ui-labels')

test('az általános gyűjtőnek magyar címkéje van, a nyers kulcs nem szivárog', () => {
  assert.equal(memoryProjectKeyLabel(GENERAL_MEMORY_PROJECT_KEY), 'Általános (alapértelmezett)')
  assert.equal(memoryProjectKeyLabel('ingatlan-ugy'), 'ingatlan-ugy')
})

test('a fontosság csak a szélső értékeken jelenik meg', () => {
  assert.equal(memoryImportanceLabel(0.8), 'Kiemelt')
  assert.equal(memoryImportanceLabel(0.5), null)
  assert.equal(memoryImportanceLabel(0.1), 'Háttérbe szorult')
})

test('a műveletek és státuszok magyarul jelennek meg', () => {
  assert.equal(memoryOperationLabel('refresh_needed'), 'Frissítés kell')
  assert.equal(memoryOperationLabel('archive'), 'Archiválás')
  assert.equal(memoryCandidateStatusLabel('proposed'), 'jóváhagyásra vár')
})

test('a verzió-változás a changeSet-ből olvasható', () => {
  assert.equal(memoryVersionChangeLabel({ operation: 'create' }), 'Új emlék')
  assert.equal(
    memoryVersionChangeLabel({ operation: 'rollback', toVersion: 2 }),
    'Visszaállítva a 2. állapotra',
  )
  assert.equal(memoryVersionChangeLabel(null), null)
})

test('az átnézés üzenete megmondja, hogy történt-e változás', () => {
  assert.match(
    memoryMaintenanceNotice({ proposed: 0, scanned: 1, skipped: 0 }),
    /nincs teendőd/,
  )
  assert.match(
    memoryMaintenanceNotice({ proposed: 2, scanned: 8, skipped: 1 }),
    /2 javaslat/,
  )
  assert.match(
    memoryMaintenanceNotice({ proposed: 2, scanned: 8, skipped: 1 }),
    /keret miatt kimaradt/,
  )
})

test('a további emlékek nem ismétlik az összefoglalóban már láthatóakat', () => {
  const extra = extraMemoryChunks(
    [
      { id: 'focus-1' },
      { id: 'constraint-1' },
      { id: 'finding-1' },
    ],
    [{ id: 'focus-1' }, { id: 'constraint-1' }, null],
  )
  assert.deepEqual(extra.map((c) => c.id), ['finding-1'])
})

test('a típuscímkék hétköznapiak, nem belső azonosítók', () => {
  assert.equal(MEMORY_TYPE_LABELS.focus, 'Hol tartunk')
  assert.equal(MEMORY_TYPE_LABELS.constraint, 'Projekt-szabály')
  assert.equal(MEMORY_TYPE_LABELS.artifact, 'Fontos fájl')
})

test('a panel nem szivárogtat belső zsargont a felhasználó elé', () => {
  const src = readSrc('src/components/agents/memory-panel.tsx')
  assert.doesNotMatch(src, /Jelenlegi fókusz \(project_state\)/)
  assert.doesNotMatch(src, />project_state</)
  assert.doesNotMatch(src, /salience \{/)
  assert.doesNotMatch(src, />salience</)
  assert.doesNotMatch(src, /Verzió-idővonal/)
  assert.doesNotMatch(src, /Memória karbantartás/)
  assert.doesNotMatch(src, /Nincs aktív fókusz-emlék/)
  assert.doesNotMatch(src, /Aktív emlékek/)
  assert.match(src, /Hol tartunk most/)
  assert.match(src, /Emlékek átnézése/)
  assert.match(src, /Korábbi állapotok/)
  assert.match(src, /Projekt-szabályok/)
  assert.match(src, /Visszaállítás erre/)
  assert.match(src, /Melyik projekt emlékeit nézed/)
  assert.match(src, /nagyobb, összefüggő munka/)
  assert.doesNotMatch(src, /Telegramon/)
  assert.doesNotMatch(src, /webes chat jelenleg/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('All passed')
