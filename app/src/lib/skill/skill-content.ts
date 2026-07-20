import { z } from 'zod'
import { computeDiffHash } from '@/lib/crypto/hash-chain'

/**
 * Kanonikus belső skill-séma (spec §D6). A tárolt `SkillVersion.content` és
 * `SkillVersion.requires` JSON mezők tipizált vetülete. Az `SKILL.md` és minden
 * későbbi import-formátum ERRE a sémára képez; ez a natív reprezentáció.
 *
 * A puha rész (`instructions`, `triggerKeywords`, `parameters`) promptba
 * injektálódik; a kemény rész (`requires` capability-manifeszt) a Tool Brokerrel
 * kerül kikényszerítésre — a szöveg maga tehetetlen (D1).
 */

// Level-0 index leírás méret-limit (token-ökonómia, spec §5). A description a
// promptban MINDIG jelen van minden hozzárendelt skillre, ezért kordában tartjuk —
// a törzs ezzel szemben csak `load_skill`-re töltődik (§D7).
//
// Az érték a kanonikus `SKILL.md` formátum leírás-limitje (1024). Korábban 500 volt,
// ami a szabvány ALATT vágott: érvényes, trigger-gazdag leírású skilleket utasított
// vissza pusztán azért, mert felsorolták, mikor kell őket előhívni. Egy interop
// formátumot implementálunk — nem vághatunk szűkebben nála.
export const SKILL_DESCRIPTION_MAX = 1024
// Egy skill teljes instrukció-törzsének (Level-1) méret-limitje karakterben.
export const SKILL_INSTRUCTIONS_MAX = 20_000
export const SKILL_NAME_MAX = 120

export const skillParameterSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).default(''),
})

export const skillContentSchema = z.object({
  instructions: z.array(z.string().min(1)).default([]),
  triggerKeywords: z.array(z.string().min(1)).default([]),
  parameters: z.array(skillParameterSchema).default([]),
})

export const skillRequirementSchema = z.object({
  toolName: z.string().min(1).max(200),
  reason: z.string().max(1_000).default(''),
})

export const skillRequiresSchema = z.array(skillRequirementSchema).default([])

export type SkillParameter = z.infer<typeof skillParameterSchema>
export type SkillContent = z.infer<typeof skillContentSchema>
export type SkillRequirement = z.infer<typeof skillRequirementSchema>

/** Provenience (spec §D6/§D14) — forrás + eredeti hash + formátum, auditáláshoz. */
export const skillProvenanceSchema = z
  .object({
    origin: z.enum(['skill_md', 'authored', 'distilled']).optional(),
    sourceUrl: z.string().optional(),
    sourceId: z.string().optional(), // conversation/ticket id desztillációnál
    originalHash: z.string().optional(), // importált bájt-hash
    format: z.string().optional(),
  })
  .passthrough()

export type SkillProvenance = z.infer<typeof skillProvenanceSchema>

/**
 * Biztonságos parse egy tárolt Json-értékből. Hibás/hiányzó mezőket a séma
 * default-ekkel pótol; teljesen érvénytelen alak esetén üres skill-tartalmat ad
 * (fail-safe — nem dob a prompt-összeállítás közben).
 */
export function parseSkillContent(value: unknown): SkillContent {
  const parsed = skillContentSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return { instructions: [], triggerKeywords: [], parameters: [] }
}

export function parseSkillRequires(value: unknown): SkillRequirement[] {
  const parsed = skillRequiresSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return []
}

/**
 * Determinista tartalom-hash a content + requires felett (aláíráshoz és
 * verzió-diffhez, WP-7). A kulcsokat rendezetten szerializáljuk, hogy a hash a
 * mezők sorrendjétől független legyen.
 */
export function computeSkillContentHash(content: SkillContent, requires: SkillRequirement[]): string {
  const canonical = JSON.stringify({
    content: {
      instructions: content.instructions,
      triggerKeywords: content.triggerKeywords,
      parameters: content.parameters.map((p) => ({ name: p.name, description: p.description })),
    },
    requires: [...requires]
      .map((r) => ({ toolName: r.toolName, reason: r.reason }))
      .sort((a, b) => a.toolName.localeCompare(b.toolName)),
  })
  return computeDiffHash(canonical)
}
