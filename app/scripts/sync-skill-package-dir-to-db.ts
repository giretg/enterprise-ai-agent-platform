/**
 * OPS: docs/skills/<skill-name>/ könyvtár → új aktív SkillVersion (mellékletekkel).
 *
 * Futtatás:
 *   CONFIRM_SKILL_SYNC=1 SKILL_SYNC_ACTOR_ID=<uuid> npx tsx scripts/sync-skill-package-dir-to-db.ts <skill-name>
 */
import './load-env'

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import { buildSkillPackage } from '../src/lib/skill/skill-package-adapter'
import { parseSkillContent } from '../src/lib/skill/skill-content'
import { findInjectionPatterns, validateSkill } from '../src/lib/skill/skill-validator'
import { services } from '../src/domain'
import { prisma } from '../src/lib/db'

const ACTOR_ID = process.env.SKILL_SYNC_ACTOR_ID?.trim()

function walkDir(root: string, base = root): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) {
      out.push(...walkDir(full, base))
      continue
    }
    const rel = relative(base, full).replace(/\\/g, '/')
    out.push({ path: rel, bytes: readFileSync(full) })
  }
  return out
}

async function main() {
  if (process.env.CONFIRM_SKILL_SYNC !== '1') {
    console.error('Refusing to run: set CONFIRM_SKILL_SYNC=1')
    process.exit(1)
  }
  if (!ACTOR_ID) {
    console.error('Refusing to run: set SKILL_SYNC_ACTOR_ID')
    process.exit(1)
  }

  const skillName = process.argv[2]?.trim()
  if (!skillName) {
    console.error('Usage: CONFIRM_SKILL_SYNC=1 SKILL_SYNC_ACTOR_ID=<uuid> npx tsx scripts/sync-skill-package-dir-to-db.ts <skill-name>')
    process.exit(1)
  }

  const dir = join(__dirname, `../../docs/skills/${skillName}`)
  const pkg = buildSkillPackage(walkDir(dir))
  const parsed = parseSkillMd(pkg.skillMdRaw, { url: `docs/skills/${skillName}/SKILL.md` })

  const skill = await prisma.skill.findFirst({ where: { name: skillName } })
  if (!skill) throw new Error(`Skill not found: ${skillName}`)

  const active = await prisma.skillVersion.findFirst({
    where: { skillId: skill.id, status: 'active' },
    orderBy: { version: 'desc' },
  })
  const activeContent = active ? parseSkillContent(active.content) : null
  const content = {
    ...parsed.content,
    ...((parsed.content.runtimeHints ?? activeContent?.runtimeHints)
      ? { runtimeHints: parsed.content.runtimeHints ?? activeContent?.runtimeHints }
      : {}),
  }

  const validation = validateSkill({
    name: parsed.name,
    description: parsed.description,
    content,
    requires: parsed.suggestedRequires,
    attachmentPaths: pkg.attachments.map((attachment) => attachment.path),
  })
  if (!validation.ok) {
    throw new Error(`validation failed: ${validation.errors.join(' · ')}`)
  }

  const attachments = []
  const skipped = [...pkg.skipped]
  for (const attachment of pkg.attachments) {
    const hits = findInjectionPatterns(attachment.text)
    if (hits.length > 0) {
      skipped.push({ path: attachment.path, reason: 'injection_pattern', bytes: attachment.bytes })
      continue
    }
    attachments.push(attachment)
  }

  const actor = {
    actorId: ACTOR_ID,
    actorTenantId: skill.tenantId,
    isPlatformAdmin: skill.tenantId === null,
  }
  const proposed = await services.skills.proposeVersion({
    skillId: skill.id,
    content,
    requires: parsed.suggestedRequires,
    attachments,
    actor,
  })
  await services.skills.approveVersion({ versionId: proposed.versionId, actor })

  console.log(
    `${skillName}: active v${proposed.version} (${proposed.versionId}) · ${attachments.length} attachment` +
      (skipped.length ? ` · skipped ${skipped.length}` : ''),
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
