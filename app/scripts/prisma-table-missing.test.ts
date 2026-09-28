/**
 * Futtatás: node --import tsx scripts/prisma-table-missing.test.ts
 */
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { isPrismaMissingTable } from '../src/lib/prisma-table-missing'

const err = new Prisma.PrismaClientKnownRequestError('The table `public.handoffs` does not exist', {
  code: 'P2021',
  clientVersion: 'test',
})

assert.equal(isPrismaMissingTable(err, 'handoffs'), true)
assert.equal(isPrismaMissingTable(err, 'gateway_operations'), false)
assert.equal(isPrismaMissingTable(new Error('nope'), 'handoffs'), false)

console.log('prisma-table-missing.test.ts: ok')
