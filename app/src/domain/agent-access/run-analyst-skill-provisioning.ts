/**
 * Globális „Futás-elemzés" skill + Futás-elemző hozzárendelés (RA-07 / #351).
 *
 * A skill `preferredMode: task` — a chat rövid marad, a munka a boardon fut.
 * Idempotens: provisioning / materializeRunAnalyst során hívható.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeSkillContentHash } from '@/lib/skill/skill-content'
import { signSkillVersion } from '@/lib/crypto/hash-chain'
import { parseSkillMd } from '@/lib/skill/skill-md-adapter'
import { validateSkill } from '@/lib/skill/skill-validator'
import { PostgresSkillRepository } from '@/repositories/postgres/skill-repository'

export const RUN_ANALYSIS_SKILL_NAME = 'futas-elemzes' as const

const SKILL_MD_PATH = resolve(
  __dirname,
  '../../../../docs/skills/futas-elemzes.SKILL.md',
)

function loadRunAnalysisSkillMd() {
  const raw = readFileSync(SKILL_MD_PATH, 'utf8')
  const parsed = parseSkillMd(raw, { url: 'docs/skills/futas-elemzes.SKILL.md' })
  const validation = validateSkill({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    requires: parsed.suggestedRequires,
  })
  if (!validation.ok) {
    throw new Error(
      `futas-elemzes skill validation failed: ${validation.errors.join(' · ')}`,
    )
  }
  return parsed
}

/**
 * Globális skill a katalógusban — aktív, aláírt verzióval. Tartalom-változáskor
 * új verzió + aktiválás (sync-skill-md mintája, provisioning write-gate nélkül).
 */
export async function ensureGlobalRunAnalysisSkill(actorId: string): Promise<{
  skillId: string
  activeVersionId: string
}> {
  const parsed = loadRunAnalysisSkillMd()
  const contentHash = computeSkillContentHash(parsed.content, parsed.suggestedRequires)
  const repo = new PostgresSkillRepository()

  let skill = await repo.findByNameInScope(RUN_ANALYSIS_SKILL_NAME, null)
  if (!skill) {
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.suggestedRequires,
    })
    const created = await repo.createSkill({
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description,
      catalogScope: 'global',
      tenantId: null,
      sourceType: 'authored',
      provenance: { origin: 'skill_md', sourceUrl: 'docs/skills/futas-elemzes.SKILL.md' },
      license: parsed.license,
      riskTier: validation.riskTier,
      content: parsed.content,
      requires: parsed.suggestedRequires,
      contentHash,
    })
    skill = created.skill
    const signature = signSkillVersion({
      skillVersionId: created.version.id,
      contentHash,
      approverId: actorId,
    })
    const { version } = await repo.approveVersion(created.version.id, {
      approverId: actorId,
      signature,
    })
    return { skillId: skill.id, activeVersionId: version.id }
  }

  await repo.updateDescription(skill.id, parsed.description)
  if (parsed.displayName !== undefined) {
    await repo.updateDisplayName(skill.id, parsed.displayName)
  }

  const active = await repo.getActiveVersion(skill.id)
  if (active && active.contentHash === contentHash) {
    return { skillId: skill.id, activeVersionId: active.id }
  }

  const version = await repo.addVersion({
    skillId: skill.id,
    content: parsed.content,
    requires: parsed.suggestedRequires,
    contentHash,
  })
  const signature = signSkillVersion({
    skillVersionId: version.id,
    contentHash,
    approverId: actorId,
  })
  const { version: activated } = await repo.approveVersion(version.id, {
    approverId: actorId,
    signature,
  })
  return { skillId: skill.id, activeVersionId: activated.id }
}

/** Aktív „Futás-elemzés" skill hozzárendelése a tenant Futás-elemző agentjéhez. */
export async function ensureRunAnalystSkillAssignment(input: {
  agentId: string
  actorId: string
}): Promise<{ skillVersionId: string; assigned: boolean }> {
  const { activeVersionId } = await ensureGlobalRunAnalysisSkill(input.actorId)
  const repo = new PostgresSkillRepository()
  const existing = await repo.findAssignment(input.agentId, activeVersionId)
  if (existing?.enabled) {
    return { skillVersionId: activeVersionId, assigned: false }
  }
  await repo.assign({
    agentId: input.agentId,
    skillVersionId: activeVersionId,
    assignedById: input.actorId,
  })
  return { skillVersionId: activeVersionId, assigned: true }
}

/** Provisioning egyszerre: skill + hozzárendelés. */
export async function ensureRunAnalystAnalysisSkill(input: {
  agentId: string
  actorId: string
}): Promise<{ skillVersionId: string }> {
  const result = await ensureRunAnalystSkillAssignment(input)
  return { skillVersionId: result.skillVersionId }
}
