/** Run against a migrated PostgreSQL database. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { selfServiceTenantStore } from '../src/repositories/postgres/self-service-tenant-store'

async function main() {
  const user = await prisma.user.create({
    data: { externalAuthId: randomUUID(), email: 'self-service-race@example.invalid', name: 'Race test' },
  })
  let release!: () => void
  let read!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const wasRead = new Promise<void>((resolve) => { read = resolve })

  try {
    const provision = selfServiceTenantStore.transaction(async (tx) => {
      assert.equal((await tx.findUser(user.id))?.status, 'pending')
      read()
      await held
      await tx.activateUser(user.id, 'admin')
    })
    await wasRead

    const suspend = prisma.user.update({ where: { id: user.id }, data: { status: 'suspended' } })
    const early = await Promise.race([
      suspend.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ])
    release()
    await provision
    await suspend

    assert.equal(early, false, 'suspension must wait while provisioning decides from the locked user row')
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status, 'suspended')
    console.log('Concurrent suspension remains effective after self-service activation.')
  } finally {
    release()
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
