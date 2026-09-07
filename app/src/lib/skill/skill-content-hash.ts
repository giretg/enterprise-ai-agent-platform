import { computeDiffHash } from '@/lib/crypto/hash-chain'
import { attachmentsFingerprint, type SkillAttachment } from './skill-attachments'
import type { SkillContent, SkillRequirement } from './skill-content'

/**
 * Skill-verzió tartalom-hash (aláírás / verzió-diff, WP-7).
 *
 * Szándékosan NEM a `skill-content.ts`-ben él: azt a katalógus UI kliens
 * komponens importálja, a hash-chain pedig import-időben `resolveSecret`-et
 * hív. Prod böngészőben a WRITE_GATE_SECRET nincs (nem NEXT_PUBLIC_), ezért
 * a modul kiértékelése eldőlne — a Skill-katalógus „Valami félresiklott”.
 */
export function computeSkillContentHash(
  content: SkillContent,
  requires: SkillRequirement[],
  attachments: SkillAttachment[] = [],
): string {
  // A melléklet-ujjlenyomat CSAK akkor kerül a kanonikus alakba, ha van melléklet:
  // így a mező bevezetése előtt aláírt verziók hash-e bitre változatlan marad.
  const attachmentPart =
    attachments.length > 0 ? { attachments: attachmentsFingerprint(attachments) } : {}
  const canonical = JSON.stringify({
    ...attachmentPart,
    content: {
      instructions: content.instructions,
      triggerKeywords: content.triggerKeywords,
      parameters: content.parameters.map((p) => ({ name: p.name, description: p.description })),
      runtimeHints: content.runtimeHints ?? null,
    },
    requires: [...requires]
      .map((r) => ({ toolName: r.toolName, reason: r.reason }))
      .sort((a, b) => a.toolName.localeCompare(b.toolName)),
  })
  return computeDiffHash(canonical)
}
