/**
 * Agent Registry — megosztott viselkedés-profil kaszkád (Feature-spec §3.4, I7, N-AR-3).
 *
 * Futtatás: npm run test:behavior-profile  (a Neon teszt-branch ellen fut)
 *
 * N-AR-3: egy megosztott `behavior_profile` új al-verzióra promótálása NEM
 * változtatja meg a hivatkozó agent élő viselkedését, amíg
 * `acceptBehaviorProfileUpdate` le nem fut; a befogadás új `agent_versions`
 * snapshotot ír a profil pinnelt al-verziójának törzsével.
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

config({ path: resolve(process.cwd(), '.env.local') })

const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
const testDirectUrl = process.env.DIRECT_URL_TEST?.trim()
if (!testDbUrl || !testDirectUrl) {
  console.error('Hiányzik DATABASE_URL_TEST / DIRECT_URL_TEST (.env.local) — kihagyva.')
  process.exit(1)
}
process.env.DATABASE_URL = testDbUrl
process.env.DIRECT_URL = testDirectUrl

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { PostgresBehaviorProfileRepository } = await import(
    '../src/repositories/postgres/behavior-profile-repository'
  )
  const { PostgresAgentRepository } = await import('../src/repositories/postgres/agent-repository')

  const profiles = new PostgresBehaviorProfileRepository()
  const agents = new PostgresAgentRepository()

  const adminId = (await prisma.user.findFirst({ where: { role: 'admin' } }))?.id
  let createdAdmin = false
  let userId = adminId
  if (!userId) {
    const u = await prisma.user.create({
      data: {
        email: `bp-test-${Date.now()}@example.com`,
        name: 'BP Test',
        role: 'admin',
        status: 'active',
        externalAuthId: `bp-test-${Date.now()}`,
      },
    })
    userId = u.id
    createdAdmin = true
  }

  let profileId: string | null = null
  let agentId: string | null = null
  let memoryId: string | null = null

  try {
    // 1) profil v1
    const profile = await profiles.create({ name: `Teszt profil ${Date.now()}`, body: 'V1 TÖRZS', approvedById: userId! })
    profileId = profile.id
    assert.equal(profile.currentVersion, 1)

    // 2) minimális agent, amely a profil v1-ét hivatkozza
    const memory = await prisma.memory.create({ data: {} })
    memoryId = memory.id
    const memoryVersion = await prisma.memoryVersion.create({
      data: { memoryId: memory.id, version: 1, content: '', status: 'active', source: 'test', approvedById: userId! },
    })
    await prisma.memory.update({ where: { id: memory.id }, data: { currentVersionId: memoryVersion.id } })

    const agent = await prisma.agent.create({
      data: {
        name: `BP teszt agent ${Date.now()}`,
        roleInstruction: 'teszt',
        behaviorProfile: 'V1 TÖRZS',
        modelConfig: { provider: 'chatgpt-oauth', model: 'gpt-test' },
        status: 'active',
        role: 'worker',
        currentVersion: 1,
        currentRoleInstructionVersion: 1,
        currentBehaviorProfileVersion: 1,
        currentBehaviorProfileId: profile.id,
        memoryId: memory.id,
      },
    })
    agentId = agent.id
    await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        version: 1,
        roleInstructionSnapshot: 'teszt',
        behaviorProfileSnapshot: 'V1 TÖRZS',
        roleInstructionVersion: 1,
        behaviorProfileVersion: 1,
        modelConfigSnapshot: { provider: 'chatgpt-oauth', model: 'gpt-test' },
        memoryVersionId: memoryVersion.id,
      },
    })

    // 3) profil v2 — a hivatkozó agent NEM változhat (I7)
    const upd = await profiles.update({ profileId: profile.id, body: 'V2 TÖRZS', approvedById: userId! })
    assert.equal(upd.version, 2)

    const afterUpdate = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })
    assert.equal(afterUpdate.behaviorProfile, 'V1 TÖRZS', 'N-AR-3 sérült: a profil-update csendben frissítette az agentet')
    assert.equal(afterUpdate.currentBehaviorProfileVersion, 1)
    assert.equal(afterUpdate.currentVersion, 1, 'profil-update nem írhat új agent-verziót')
    console.log('  OK  N-AR-3 profil-update nem frissíti csendben a hivatkozó agentet (I7)')

    const referrers = await profiles.listReferrers(profile.id)
    assert.equal(referrers.length, 1)
    assert.equal(referrers[0].pinnedVersion, 1)
    console.log('  OK  hivatkozó felderítve, pinnelt al-verzió = 1')

    // 4) befogadás → új agent-verzió a v2 törzsével
    const accepted = await agents.acceptBehaviorProfileUpdate({
      agentId: agent.id,
      profileId: profile.id,
      profileVersion: 2,
      profileBody: 'V2 TÖRZS',
    })
    assert.equal(accepted.agentVersion, 2)

    const afterAccept = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })
    assert.equal(afterAccept.behaviorProfile, 'V2 TÖRZS')
    assert.equal(afterAccept.currentBehaviorProfileVersion, 2)
    assert.equal(afterAccept.currentVersion, 2)

    const v2 = await prisma.agentVersion.findUniqueOrThrow({
      where: { agentId_version: { agentId: agent.id, version: 2 } },
    })
    assert.equal(v2.behaviorProfileSnapshot, 'V2 TÖRZS')
    assert.equal(v2.behaviorProfileVersion, 2)
    console.log('  OK  acceptBehaviorProfileUpdate új agent-verziót ír a v2 törzsével (kaszkád)')

    console.log('\nMinden behavior-profile kaszkád teszt zöld.')
  } finally {
    if (agentId) {
      await prisma.agentVersion.deleteMany({ where: { agentId } })
      await prisma.agent.deleteMany({ where: { id: agentId } })
    }
    if (memoryId) {
      await prisma.memory.update({ where: { id: memoryId }, data: { currentVersionId: null } }).catch(() => {})
      await prisma.memoryVersion.deleteMany({ where: { memoryId } })
      await prisma.memory.deleteMany({ where: { id: memoryId } })
    }
    if (profileId) {
      await prisma.behaviorProfileVersion.deleteMany({ where: { profileId } })
      await prisma.behaviorProfile.deleteMany({ where: { id: profileId } })
    }
    if (createdAdmin && userId) {
      await prisma.user.deleteMany({ where: { id: userId } })
    }
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(`\nFAIL: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
