import assert from 'node:assert/strict'
import {
  defaultBoardDateRange,
  formatDateInput,
  resolveBoardDateRange,
} from '../src/lib/board-date-range'

const now = new Date(2026, 7, 3, 12, 0, 0) // Aug 3, 2026 local
const defaults = defaultBoardDateRange(now)
assert.equal(defaults.to, '2026-08-03')
assert.equal(defaults.from, '2026-07-03')

const resolved = resolveBoardDateRange({})
assert.equal(resolved.from, defaultBoardDateRange().from)
assert.equal(resolved.to, defaultBoardDateRange().to)

const swapped = resolveBoardDateRange({ from: '2026-08-10', to: '2026-08-01' })
assert.equal(swapped.from, '2026-08-01')
assert.equal(swapped.to, '2026-08-10')
assert.equal(formatDateInput(swapped.updatedAtGte), '2026-08-01')
assert.equal(swapped.updatedAtLte.getHours(), 23)
assert.equal(swapped.updatedAtLte.getMinutes(), 59)

const invalid = resolveBoardDateRange({ from: 'nope', to: '2026-08-01' })
assert.equal(invalid.from, defaultBoardDateRange().from)
assert.equal(invalid.to, '2026-08-01')

console.log('board-date-range.test.ts: ok')
