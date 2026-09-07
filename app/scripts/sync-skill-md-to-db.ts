/**
 * OPS / local: docs/skills/*.SKILL.md → új aktív SkillVersion (raw SQL).
 *
 * FIGYELEM: megkerüli a SkillService write-gate-et (proposed → approved → active
 * + audit). Éles környezetben NEM helyettesíti a katalógus UI jóváhagyását.
 *
 * Futtatás (kötelező confirm):
 *   CONFIRM_SKILL_SYNC=1 npx tsx scripts/sync-skill-md-to-db.ts <skill-name>…
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import { validateSkill } from '../src/lib/skill/skill-validator'
import { computeSkillContentHash } from '../src/lib/skill/skill-content-hash'
import { signSkillVersion } from '../src/lib/crypto/hash-chain'
import { prisma } from '../src/lib/db'

const ACTOR_ID = process.env.SKILL_SYNC_ACTOR_ID?.trim()

async function syncOne(skillName: string, actorId: string) {
  const mdPath = resolve(__dirname, `../../docs/skills/${skillName}.SKILL.md`)
  const raw = readFileSync(mdPath, 'utf8')
  const parsed = parseSkillMd(raw, { url: `docs/skills/${skillName}.SKILL.md` })
  const validation = validateSkill({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    requires: parsed.suggestedRequires,
  })
  if (!validation.ok) {
    throw new Error(`${skillName}: validation failed: ${validation.errors.join(' · ')}`)
  }

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM skills WHERE name = ${skillName} LIMIT 1
  `
  const skillId = rows[0]?.id
  if (!skillId) throw new Error(`${skillName}: skill not found in DB`)

  const contentHash = computeSkillContentHash(parsed.content, parsed.suggestedRequires)
  const latest = await prisma.skillVersion.findFirst({
    where: { skillId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const nextVersion = (latest?.version ?? 0) + 1
  const versionId = randomUUID()

  await prisma.$executeRaw`
    UPDATE skills
    SET
      description = ${parsed.description},
      display_name = ${parsed.displayName}
    WHERE id = ${skillId}::uuid
  `
  await prisma.$executeRaw`
    INSERT INTO skill_versions (
      id, skill_id, version, content, requires, status, content_hash, created_at
    ) VALUES (
      ${versionId}::uuid,
      ${skillId}::uuid,
      ${nextVersion},
      ${JSON.stringify(parsed.content)}::jsonb,
      ${JSON.stringify(parsed.suggestedRequires)}::jsonb,
      'proposed'::"SkillVersionStatus",
      ${contentHash},
      NOW()
    )
  `

  const signature = signSkillVersion({
    skillVersionId: versionId,
    contentHash,
    approverId: actorId,
  })

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE skill_versions
      SET status = 'retired'::"SkillVersionStatus"
      WHERE skill_id = ${skillId}::uuid
        AND status = 'active'::"SkillVersionStatus"
    `
    await tx.$executeRaw`
      UPDATE skill_versions
      SET
        status = 'active'::"SkillVersionStatus",
        approved_by = ${actorId}::uuid,
        signature = ${signature}
      WHERE id = ${versionId}::uuid
    `

    const stale = await tx.$queryRaw<
      Array<{ agent_id: string; enabled: boolean }>
    >`
      SELECT as2.agent_id, as2.enabled
      FROM agent_skills as2
      JOIN skill_versions sv ON sv.id = as2.skill_version_id
      WHERE sv.skill_id = ${skillId}::uuid
        AND as2.skill_version_id <> ${versionId}::uuid
    `
    const byAgent = new Map<string, boolean>()
    for (const row of stale) {
      byAgent.set(row.agent_id, (byAgent.get(row.agent_id) ?? false) || row.enabled)
    }
    for (const [agentId, enabled] of byAgent) {
      await tx.$executeRaw`
        INSERT INTO agent_skills (agent_id, skill_version_id, enabled, assigned_by, created_at)
        VALUES (${agentId}::uuid, ${versionId}::uuid, ${enabled}, ${actorId}::uuid, NOW())
        ON CONFLICT (agent_id, skill_version_id)
        DO UPDATE SET enabled = EXCLUDED.enabled, assigned_by = EXCLUDED.assigned_by
      `
      await tx.$executeRaw`
        DELETE FROM agent_skills
        WHERE agent_id = ${agentId}::uuid
          AND skill_version_id IN (
            SELECT id FROM skill_versions
            WHERE skill_id = ${skillId}::uuid AND id <> ${versionId}::uuid
          )
      `
    }
  })

  console.log(`${skillName}: active v${nextVersion} (${versionId})`)
}

async function main() {
  if (process.env.CONFIRM_SKILL_SYNC !== '1') {
    console.error(
      'Refusing to run: set CONFIRM_SKILL_SYNC=1 (bypasses SkillService write-gate / audit).',
    )
    process.exit(1)
  }
  if (!ACTOR_ID) {
    console.error('Refusing to run: set SKILL_SYNC_ACTOR_ID to a real user UUID.')
    process.exit(1)
  }
  const names = process.argv.slice(2)
  if (names.length === 0) {
    console.error('Usage: CONFIRM_SKILL_SYNC=1 SKILL_SYNC_ACTOR_ID=<uuid> npx tsx scripts/sync-skill-md-to-db.ts <skill-name>…')
    process.exit(1)
  }
  for (const name of names) await syncOne(name, ACTOR_ID)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
