/**
 * Skill törlése: a használó agentek listája a figyelmeztetéshez, a törlés a használt
 * skillt is engedi (hozzárendelések leválnak), idegen tenant skilljét nem.
 * Futtatás: npm run test:skill-delete
 */
import assert from 'node:assert/strict'
import { SkillAccessError, SkillService } from '../src/domain/skill/skill-service'

const TENANT = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const SKILL = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'

function build(users: Array<{ id: string; name: string }>) {
  const deleted: string[] = []
  const repo = {
    findById: async (id: string) => (id === SKILL ? { id, tenantId: TENANT, versions: [] } : null),
    listAgentsUsingSkill: async () => users,
    deleteSkill: async (id: string) => void deleted.push(id),
  }
  const service = new SkillService(repo as never, {} as never, {} as never)
  return { service, deleted }
}

const actor = (actorTenantId: string) => ({ actorTenantId, isPlatformAdmin: false }) as never

async function main() {
  const used = build([{ id: 'a1', name: 'Réka' }, { id: 'a2', name: 'Elemér' }])
  assert.deepEqual(
    (await used.service.getSkillUsage({ skillId: SKILL, actor: actor(TENANT) })).map((a) => a.name),
    ['Réka', 'Elemér'],
  )
  const res = await used.service.deleteSkill({ skillId: SKILL, actor: actor(TENANT) })
  assert.equal(res.detachedAgentCount, 2)
  assert.deepEqual(used.deleted, [SKILL], 'használt skill is törölhető')

  const unused = build([])
  assert.equal((await unused.service.deleteSkill({ skillId: SKILL, actor: actor(TENANT) })).detachedAgentCount, 0)

  const foreign = build([])
  await assert.rejects(
    foreign.service.deleteSkill({ skillId: SKILL, actor: actor(OTHER) }),
    SkillAccessError,
  )
  assert.deepEqual(foreign.deleted, [], 'idegen tenant nem törölhet')
  console.log('✅ skill-delete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
