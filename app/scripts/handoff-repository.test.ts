/** Run against a migrated PostgreSQL database: npm run test:handoff-repository. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresHandoffRepository } from '../src/repositories/postgres/handoff-repository'

async function main() {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({
    data: { slug: `handoff-test-${suffix}`, displayName: 'Handoff test' },
  })
  let userId: string | undefined
  let agentId: string | undefined
  try {
    const user = await prisma.user.create({
      data: { externalAuthId: suffix, email: `${suffix}@example.invalid`, name: 'Handoff test' },
    })
    userId = user.id
    const agent = await prisma.agent.create({
      data: {
        tenantId: tenant.id,
        name: 'Handoff test',
        roleInstruction: 'test',
        modelConfig: { provider: 'stub', model: 'stub' },
      },
    })
    agentId = agent.id
    const repo = new PostgresHandoffRepository()
    const handoff = await repo.insert({
      tenantId: tenant.id,
      fromAgentId: agent.id,
      fromDefinitionId: randomUUID(),
      toAgentId: null,
      toUserId: user.id,
      projectKey: '__general__',
      title: 'Concurrent decision',
      summary: 'One decision must win.',
      links: null,
      createdById: user.id,
    })
    const results = await Promise.all([
      repo.decide(handoff.id, 'done', user.id),
      repo.decide(handoff.id, 'rejected', user.id),
    ])
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal((await repo.findById(handoff.id))?.status, results.find(Boolean)?.status)
    assert.equal(await repo.decide(handoff.id, 'accepted', user.id), null)

    const second = await repo.insert({
      tenantId: tenant.id,
      fromAgentId: agent.id,
      fromDefinitionId: randomUUID(),
      toAgentId: null,
      toUserId: user.id,
      projectKey: '__general__',
      title: 'Normal decision',
      summary: 'Accept then complete.',
      links: null,
      createdById: user.id,
    })
    assert.equal((await repo.decide(second.id, 'accepted', user.id))?.status, 'accepted')
    assert.equal((await repo.decide(second.id, 'done', user.id))?.status, 'done')
    console.log('Handoff decision is atomic; accepted → done still works.')
  } finally {
    await prisma.handoff.deleteMany({ where: { tenantId: tenant.id } })
    if (agentId) await prisma.agent.delete({ where: { id: agentId } })
    if (userId) await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
