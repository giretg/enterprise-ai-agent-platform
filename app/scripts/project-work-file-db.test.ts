/** Run against a disposable local, migrated DB named project_work_review_test; CI uses its ephemeral ci DB. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresWorkFileRepository } from '../src/repositories/postgres/project-work-repository'

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid')
if (!['localhost', '127.0.0.1'].includes(url.hostname) ||
    !(url.pathname.includes('project_work_review_test') || (process.env.CI === 'true' && url.pathname === '/ci'))) {
  throw new Error('Use only a disposable local project_work_review_test database')
}

async function main() {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({ data: { slug: `work-file-review-${suffix}`, displayName: 'Work file review' } })
  const user = await prisma.user.create({ data: { externalAuthId: suffix, email: `${suffix}@example.invalid`, name: 'Work file reviewer' } })
  const files = new PostgresWorkFileRepository()
  const base = {
    tenantId: tenant.id,
    projectKey: '__general__',
    lastWriterUserId: user.id,
    append: false,
    maxFileBytes: 200_000,
    maxProjectBytes: 10,
    maxCount: 1,
  }
  try {
    for (const limits of [{ maxCount: 1, maxProjectBytes: 20 }, { maxCount: 2, maxProjectBytes: 10 }]) {
      const competing = await Promise.all([
        files.save({ ...base, ...limits, path: 'a.txt', content: '123456' }),
        files.save({ ...base, ...limits, path: 'b.txt', content: '123456' }),
      ])
      assert.equal(competing.filter((result) => typeof result !== 'string').length, 1)
      assert.equal(competing.filter((result) => result === 'quota_exceeded').length, 1)
      assert.equal(await prisma.workFile.count({ where: { tenantId: tenant.id } }), 1)
      await prisma.workFile.deleteMany({ where: { tenantId: tenant.id } })
    }
    const chunks = Array.from({ length: 6 }, (_, i) => `${i}\n`)
    const appended = await Promise.all(chunks.map((content) => files.save({
      ...base,
      path: 'journal.txt',
      content,
      append: true,
      maxFileBytes: 12,
      maxProjectBytes: 12,
    })))
    assert.ok(appended.every((result) => typeof result !== 'string'))
    const journal = await files.find(tenant.id, '__general__', 'journal.txt')
    assert.ok(journal)
    assert.deepEqual(journal?.content.trim().split('\n').sort(), chunks.map((chunk) => chunk.trim()).sort())
    assert.equal(journal?.byteSize, 12)
    assert.equal(await files.delete(tenant.id, '__general__', 'journal.txt'), true)
    assert.equal(await files.delete(tenant.id, '__general__', 'journal.txt'), false)
    console.log('project-work-file-db: concurrent quota and append are atomic')
  } finally {
    await prisma.workFile.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
