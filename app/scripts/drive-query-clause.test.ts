/** Futtatás: npm run test:drive-query-clause */
import assert from 'node:assert/strict'
import { driveQueryClause } from '../src/domain/connector-grant/google-drive-api-client'

assert.equal(driveQueryClause('Birtok'), "fullText contains 'Birtok'")
assert.equal(driveQueryClause("Ostoros árlista"), "fullText contains 'Ostoros árlista'")
assert.equal(driveQueryClause("name contains 'Birtok'"), "(name contains 'Birtok')")
assert.equal(driveQueryClause('starred = true'), '(starred = true)')
assert.equal(driveQueryClause('a\\b'), "fullText contains 'a\\\\b'")
console.log('drive-query-clause OK')
