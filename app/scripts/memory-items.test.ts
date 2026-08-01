/**
 * Legacy MemoryVersion.content tételes parse/serialize/apply.
 *
 * Futtatás: npm run test:memory-items
 */
import assert from 'node:assert/strict'
import {
  EMPTY_MEMORY_PLACEHOLDER,
  applyMemoryItemChange,
  parseMemoryItems,
  serializeMemoryItems,
} from '../src/domain/training/memory-items'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run() {
  await test('üres / placeholder → nincs tétel', () => {
    assert.deepEqual(parseMemoryItems(null), [])
    assert.deepEqual(parseMemoryItems(''), [])
    assert.deepEqual(parseMemoryItems(EMPTY_MEMORY_PLACEHOLDER), [])
  })

  await test('bullet lista → tételek', () => {
    const content = `- Első szabály\n- Második szabály\n* Harmadik`
    assert.deepEqual(parseMemoryItems(content), [
      'Első szabály',
      'Második szabály',
      'Harmadik',
    ])
  })

  await test('serialize roundtrip bullet formában', () => {
    const items = ['A', 'B több\nsoros']
    const serialized = serializeMemoryItems(items)
    assert.equal(serialized, '- A\n- B több\n  soros')
    assert.deepEqual(parseMemoryItems(serialized), ['A', 'B több\nsoros'])
  })

  await test('üres serialize → placeholder', () => {
    assert.equal(serializeMemoryItems([]), EMPTY_MEMORY_PLACEHOLDER)
  })

  await test('add hozzáfűz', () => {
    const next = applyMemoryItemChange('- Régi', { operation: 'add', text: 'Új' })
    assert.deepEqual(parseMemoryItems(next), ['Régi', 'Új'])
  })

  await test('update indexen', () => {
    const next = applyMemoryItemChange('- A\n- B\n- C', {
      operation: 'update',
      itemIndex: 1,
      text: 'B2',
    })
    assert.deepEqual(parseMemoryItems(next), ['A', 'B2', 'C'])
  })

  await test('remove utolsó → placeholder', () => {
    const next = applyMemoryItemChange('- Egyetlen', { operation: 'remove', itemIndex: 0 })
    assert.equal(next, EMPTY_MEMORY_PLACEHOLDER)
    assert.deepEqual(parseMemoryItems(next), [])
  })

  await test('érvénytelen index hibát dob', () => {
    assert.throws(
      () => applyMemoryItemChange('- A', { operation: 'remove', itemIndex: 3 }),
      /Érvénytelen szabály-index/,
    )
  })

  await test('üres add hibát dob', () => {
    assert.throws(
      () => applyMemoryItemChange('- A', { operation: 'add', text: '   ' }),
      /nem lehet üres/,
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes memory-items teszt zöld')
}

run()
