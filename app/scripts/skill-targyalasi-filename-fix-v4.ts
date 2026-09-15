/**
 * Egyszeri javítás: targyalasi-felkeszito skill v4 — slug-szabály a fájlnévbe
 * + a file_write által visszaadott path szó szerinti idézése.
 * Futtatás: npx tsx scripts/skill-targyalasi-filename-fix-v4.ts
 *
 * A v3 aktív verziót NEM írjuk felül: új proposed v4 készül, majd a
 * repository approve-útján (retire + agent-migráció) aktiváljuk — a
 * skill-service approveVersion-jével egyenértékű, audit-nyommal.
 */
import './load-env'

import { prisma } from '../src/lib/db'
import { computeSkillContentHash } from '../src/lib/skill/skill-content-hash'
import { signSkillVersion } from '../src/lib/crypto/hash-chain'
import { PostgresSkillRepository } from '../src/repositories/postgres/skill-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'

const SKILL_ID = '0f342368-aa00-41fc-9d37-69cd13ae0975'
const APPROVER_ID = '48506262-02ed-4172-9ed6-4cbeb841ff8c' // admin@excellence.ai

const OLD_STEP6 =
  '6. Mentsd `targyalasi-felkeszito-<ugyfel-rovid-nev>-<YYYY-MM-DD>.html` néven, majd ellenőrizd fájl-előnézetben és nyomtatási nézetben.'
const NEW_STEP6 =
  '6. Mentsd `targyalasi-felkeszito-<slug>-<YYYY-MM-DD>.html` néven, ahol a <slug> kisbetűs, ékezet nélküli rövid név (pl. spar, vino-trade; max 40 karakter, csak [a-z0-9-]). Teljes jogi cégnevet, szóközt, pontot és ékezetes karaktert a fájlnévbe TILOS tenni. A válaszodban a `file_write` által visszaadott `path` mezőt szó szerint, backtickben idézd — a fájlnevet sose rekonstruáld fejből. Mentés után ellenőrizd fájl-előnézetben és nyomtatási nézetben.'

async function main() {
  const skill = await prisma.skill.findUnique({ where: { id: SKILL_ID } })
  if (!skill) throw new Error(`Skill not found: ${SKILL_ID}`)

  const active = await prisma.skillVersion.findFirst({
    where: { skillId: SKILL_ID, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!active || active.version !== 3) {
    throw new Error(
      `Várt aktív v3, ehelyett: ${active ? `v${active.version} (${active.status})` : 'nincs aktív'}. Állj le, nézd meg kézzel.`,
    )
  }

  const content = active.content as unknown as {
    instructions: string[]
    triggerKeywords: string[]
    parameters: Array<{ name: string; description: string }>
    runtimeHints?: unknown
  }
  const requires = (active.requires as unknown as Array<{ toolName: string; reason: string }>) ?? []
  const idx = content.instructions.findIndex((s) => s.includes(OLD_STEP6))
  if (idx === -1) throw new Error('A v3 6. lépés szövege nem található — a skill közben változott, állj le.')

  const instructions = [...content.instructions]
  instructions[idx] = instructions[idx].replace(OLD_STEP6, NEW_STEP6)
  const newContent = { ...content, instructions }
  const contentHash = computeSkillContentHash(
    {
      instructions,
      triggerKeywords: content.triggerKeywords,
      parameters: content.parameters,
      runtimeHints: content.runtimeHints as never,
    },
    requires,
  )

  const skills = new PostgresSkillRepository()
  const audit = new PostgresAuditRepository()

  const proposed = await skills.addVersion({
    skillId: SKILL_ID,
    content: newContent as never,
    requires: requires as never,
    contentHash,
  })
  console.log(`proposed: v${proposed.version} (${proposed.id})`)

  await audit.append({
    actorType: 'human',
    actorId: APPROVER_ID,
    agentVersion: null,
    action: 'skill.version.proposed',
    targetType: 'skill',
    targetId: SKILL_ID,
    modelUsed: null,
    inputRef: null,
    outputRef: `v${proposed.version}`,
    policyDecision: 'proposed',
    tenantId: skill.tenantId,
    metadata: { skillVersionId: proposed.id, contentHash, reason: 'filename-slug-fix' },
  })

  const signature = signSkillVersion({
    skillVersionId: proposed.id,
    contentHash,
    approverId: APPROVER_ID,
  })
  const { version, agentMigrations } = await skills.approveVersion(proposed.id, {
    approverId: APPROVER_ID,
    signature,
  })
  console.log(`active: v${version.version} (${version.id}), agent-migrációk: ${agentMigrations.length}`)

  await audit.append({
    actorType: 'human',
    actorId: APPROVER_ID,
    agentVersion: null,
    action: 'skill.version.approved',
    targetType: 'skill',
    targetId: SKILL_ID,
    modelUsed: null,
    inputRef: proposed.id,
    outputRef: `v${version.version}`,
    policyDecision: 'active',
    tenantId: skill.tenantId,
    metadata: { skillVersionId: version.id, contentHash, signature, reason: 'filename-slug-fix' },
  })

  console.log('Kész: v3 retired, v4 active.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
