import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { computeSkillContentHash } from '@/lib/skill/skill-content-hash'
import {
  SKILL_PRODUCER_DESCRIPTION,
  SKILL_PRODUCER_DISPLAY_NAME,
  SKILL_PRODUCER_NAME,
  skillProducerContent,
} from '@/lib/skill/skill-producer'

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}

/**
 * A kiadott gyártó skill sor. Idempotens.
 * ponytail: a kód a szöveg forrása — katalógusbeli átírás a következő híváskor felülíródik.
 * Ha tenant-saját szöveget akarnak, arra a tenant saját gyártó skillje való.
 */
export async function ensurePublishedProducerSkill(): Promise<'created' | 'updated' | 'present'> {
  const content = skillProducerContent()
  const requires: Prisma.InputJsonValue = []
  const contentHash = computeSkillContentHash(content, [], [])
  const existing = await prisma.skill.findFirst({
    where: { tenantId: null, name: SKILL_PRODUCER_NAME },
    include: { versions: { orderBy: { version: 'desc' } } },
  })
  if (!existing) {
    try {
      await prisma.skill.create({
        data: {
          name: SKILL_PRODUCER_NAME,
          displayName: SKILL_PRODUCER_DISPLAY_NAME,
          description: SKILL_PRODUCER_DESCRIPTION,
          catalogScope: 'global',
          tenantId: null,
          kind: 'published',
          sourceType: 'authored',
          provenance: { origin: 'authored', via: 'platform' },
          license: null,
          riskTier: 't0',
          producesSkills: true,
          versions: {
            create: {
              version: 1,
              content: content as unknown as Prisma.InputJsonValue,
              requires,
              contentHash,
              status: 'active',
            },
          },
        },
      })
      return 'created'
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      return 'present'
    }
  }

  const drifted =
    !existing.producesSkills ||
    existing.description !== SKILL_PRODUCER_DESCRIPTION ||
    existing.displayName !== SKILL_PRODUCER_DISPLAY_NAME ||
    existing.kind !== 'published' ||
    existing.catalogScope !== 'global'
  if (drifted) {
    await prisma.skill.update({
      where: { id: existing.id },
      data: {
        producesSkills: true,
        description: SKILL_PRODUCER_DESCRIPTION,
        displayName: SKILL_PRODUCER_DISPLAY_NAME,
        kind: 'published',
        catalogScope: 'global',
        riskTier: 't0',
      },
    })
  }
  const active = existing.versions.find((version) => version.status === 'active')
  if (active && active.contentHash !== contentHash) {
    await prisma.skillVersion.update({
      where: { id: active.id },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        requires,
        contentHash,
      },
    })
    return 'updated'
  }
  return drifted ? 'updated' : 'present'
}

const memo = globalThis as { publishedProducerSkill?: Promise<void> }

/** Folyamatonként egyszer. Új deploy új folyamat, ott újra lefut. */
export function ensurePublishedProducerSkillOnce(): Promise<void> {
  memo.publishedProducerSkill ??= ensurePublishedProducerSkill().then(
    () => undefined,
    (err: unknown) => {
      memo.publishedProducerSkill = undefined
      throw err
    },
  )
  return memo.publishedProducerSkill
}
