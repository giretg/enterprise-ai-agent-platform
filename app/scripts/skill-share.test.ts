/**
 * Skill megosztása superadminként (platform-szintre / másik tenantba):
 * SkillService.shareSkill domain-szabályai, in-memory repóval.
 */
import assert from 'node:assert/strict'
import { SkillService } from '../src/domain/skill/skill-service'

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

void check('shareSkill: platform-admin aktív verzióból független másolatot ad (platform / tenant)', async () => {
  const source = {
    id: 's1',
    name: 'health-intake',
    displayName: null,
    description: 'd',
    catalogScope: 'tenant',
    tenantId: 't1',
    kind: 'tenant',
    sourceType: 'authored',
    provenance: { origin: 'authored' },
    license: null,
    riskTier: 'low',
    producesSkills: false,
    versions: [
      { id: 'v2', version: 2, status: 'proposed', content: {}, requires: [], attachments: null, contentHash: 'h2' },
      { id: 'v1', version: 1, status: 'active', content: { body: 'x' }, requires: [], attachments: null, contentHash: 'h1' },
    ],
  }
  const created: Array<Record<string, unknown>> = []
  const approved: string[] = []
  const taken = new Set<string>(['t3'])
  const skillsRepo = {
    findById: async (id: string) => (id === 's1' ? source : null),
    findByNameInScope: async (_name: string, tenantId: string | null) =>
      tenantId && taken.has(tenantId) ? { id: 'x', name: 'health-intake' } : null,
    createSkill: async (input: Record<string, unknown>) => {
      created.push(input)
      return { skill: { id: `copy${created.length}` }, version: { id: `cv${created.length}` } }
    },
    approveVersion: async (versionId: string) => {
      approved.push(versionId)
      return { version: { id: versionId }, agentMigrations: [] }
    },
  }
  const svc = new SkillService(skillsRepo as never, {} as never, {} as never)
  const admin = { actorId: 'u1', actorTenantId: 't1', isPlatformAdmin: true }

  await assert.rejects(
    svc.shareSkill({ skillId: 's1', target: { kind: 'platform' }, actor: { ...admin, isPlatformAdmin: false } }),
    /platform-admin/,
  )
  await assert.rejects(
    svc.shareSkill({ skillId: 's1', target: { kind: 'platform' }, actor: { ...admin, actorTenantId: 't9' } }),
    /not found/,
  )
  await assert.rejects(
    svc.shareSkill({ skillId: 's1', target: { kind: 'tenant', tenantId: 't3' }, actor: admin }),
    /cél-tenantban már van/,
  )
  await assert.rejects(
    svc.shareSkill({ skillId: 's1', target: { kind: 'tenant', tenantId: 't1' }, actor: admin }),
    /már ebben a tenantban/,
  )

  const pub = await svc.shareSkill({ skillId: 's1', target: { kind: 'platform' }, actor: admin })
  assert.equal(pub.skillId, 'copy1')
  assert.equal(created[0].kind, 'published')
  assert.equal(created[0].catalogScope, 'global')
  assert.equal(created[0].tenantId, null)
  assert.equal(created[0].contentHash, 'h1')
  assert.deepEqual(created[0].content, { body: 'x' })
  assert.equal(created[0].producesSkills, false)
  assert.deepEqual((created[0].provenance as { sharedFrom: unknown }).sharedFrom, {
    skillId: 's1',
    tenantId: 't1',
    version: 1,
    sharedBy: 'u1',
  })

  await svc.shareSkill({ skillId: 's1', target: { kind: 'tenant', tenantId: 't2' }, actor: admin })
  assert.equal(created[1].kind, 'tenant')
  assert.equal(created[1].catalogScope, 'tenant')
  assert.equal(created[1].tenantId, 't2')
  assert.deepEqual(approved, ['cv1', 'cv2'])

  source.versions = source.versions.filter((v) => v.status !== 'active')
  await assert.rejects(
    svc.shareSkill({ skillId: 's1', target: { kind: 'platform' }, actor: admin }),
    /aktív/,
  )
})
