/**
 * „A futás szerint elkészült, de a munkaterületen nincs meg" — kimutatás.
 * Futtatás: npx tsx scripts/declared-workspace-outputs.test.ts
 */
import assert from 'node:assert/strict'
import {
  declaredWorkspaceOutputs,
  missingDeclaredOutputs,
} from '../src/lib/declared-workspace-outputs'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ❌ ${name}`)
    console.error(e)
  }
}

console.log('declared-workspace-outputs')

test('a mért mellékhatás fájl-célpontja fájlnak számít', () => {
  assert.deepEqual(
    declaredWorkspaceOutputs([
      {
        toolName: 'tulajdoni_lap_parse',
        effectSummary: {
          unit: 'feldolgozott tulajdonosi rekord',
          amount: 182,
          target: 'tulajdoni_lap_043_15_handoff.json',
        },
      },
    ]),
    ['tulajdoni_lap_043_15_handoff.json'],
  )
})

test('ticket-azonosító (board_write) nem fájl', () => {
  assert.deepEqual(
    declaredWorkspaceOutputs([
      {
        toolName: 'board_write',
        effectSummary: {
          unit: 'állapotváltás',
          amount: 1,
          target: 'c8bc57bb-297d-45c7-972c-4a7578f0cf7a',
        },
      },
    ]),
    [],
  )
})

test('szemét-célpont (abszolút út, kilépés, kiterjesztés nélkül) kimarad', () => {
  assert.deepEqual(
    declaredWorkspaceOutputs([
      { effectSummary: { target: '/etc/passwd' } },
      { effectSummary: { target: '../titkos.json' } },
      { effectSummary: { target: 'Ostoros Föld API' } },
      { effectSummary: null },
      { effectSummary: 'nem objektum' },
    ]),
    [],
  )
})

test('ismétlődés egyszer szerepel, sorrendtartóan', () => {
  assert.deepEqual(
    declaredWorkspaceOutputs([
      { effectSummary: { target: 'a.json' } },
      { effectSummary: { target: 'b.xlsx' } },
      { effectSummary: { target: 'a.json' } },
    ]),
    ['a.json', 'b.xlsx'],
  )
})

test('a hiányzó fájlok a lista és a napló különbsége', () => {
  assert.deepEqual(missingDeclaredOutputs(['a.json', 'b.xlsx'], ['b.xlsx']), ['a.json'])
  assert.deepEqual(missingDeclaredOutputs(['a.json'], ['a.json']), [])
  assert.deepEqual(missingDeclaredOutputs([], ['a.json']), [])
})

if (failures > 0) {
  console.error(`\n${failures} teszt bukott`)
  process.exit(1)
}
console.log('ok')
