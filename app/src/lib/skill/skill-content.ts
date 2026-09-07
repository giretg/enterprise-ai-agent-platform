import { z } from 'zod'

/**
 * Kanonikus belső skill-séma (spec §D6). A tárolt `SkillVersion.content` és
 * `SkillVersion.requires` JSON mezők tipizált vetülete. Az `SKILL.md` és minden
 * későbbi import-formátum ERRE a sémára képez; ez a natív reprezentáció.
 *
 * Kliens-komponens is importálja (skill-katalógus UI). Ne húzz ide node:crypto /
 * hash-chain / secret-resolver importot — a tartalom-hash a
 * `skill-content-hash.ts`-ben él.
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
/** Skillhez kötött feladat csatolmány-leírása — a feladat-indító űrlapon jelenik meg. */
export const SKILL_ATTACHMENT_DESCRIPTION_MAX = 500

export const skillParameterSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).default(''),
})

/**
 * A runtime-hint megengedett tartományai — EGY forrás a sémának, a katalógus
 * UI-nak és a loop-clampnek. Ha itt tágítunk, mindhárom helyen tágul.
 */
export const SKILL_RUNTIME_HINT_LIMITS = {
  maxWallClockMs: { min: 10_000, max: 3_600_000 },
  maxToolCalls: { min: 5, max: 500 },
} as const

/**
 * Kemény runtime-hint a tool-loop guardokhoz (nem prompt-szöveg).
 * Chat alap: 180s / 60 tool; hosszú skill felülírhatja — a loop clampeli.
 * `preferredMode: 'task'` a hosszú futás board/ticket ágra terelését kéri
 * (l. `resolveSkillTaskPromotion`).
 */
export const skillRuntimeHintsSchema = z.object({
  maxWallClockMs: z
    .number()
    .int()
    .min(SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.min)
    .max(SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.max)
    .optional(),
  maxToolCalls: z
    .number()
    .int()
    .min(SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.min)
    .max(SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.max)
    .optional(),
  preferredMode: z.enum(['chat', 'task']).optional(),
  /**
   * Csatolható-e fájl a skillhez kötött feladathoz (#199). HIÁNYZÓ ÉRTÉK =
   * ENGEDETT — a meglévő skillek viselkedése változatlan marad. Bináris döntés:
   * nincs „kötelező csatolmány" állapot.
   */
  allowAttachments: z.boolean().optional(),
  /**
   * Szabad szöveges útmutató a várt csatolmányról — a feladat-indító űrlapon a
   * fájlfeltöltés fölött jelenik meg. Csak akkor értelmes, ha a csatolás engedett.
   */
  attachmentDescription: z.string().max(SKILL_ATTACHMENT_DESCRIPTION_MAX).optional(),
})

export const skillContentSchema = z.object({
  instructions: z.array(z.string().min(1)).default([]),
  triggerKeywords: z.array(z.string().min(1)).default([]),
  parameters: z.array(skillParameterSchema).default([]),
  runtimeHints: skillRuntimeHintsSchema.optional(),
})

export const skillRequirementSchema = z.object({
  toolName: z.string().min(1).max(200),
  reason: z.string().max(1_000).default(''),
})

export const skillRequiresSchema = z.array(skillRequirementSchema).default([])

export type SkillParameter = z.infer<typeof skillParameterSchema>
export type SkillRuntimeHints = z.infer<typeof skillRuntimeHintsSchema>
export type SkillContent = z.infer<typeof skillContentSchema>
export type SkillRequirement = z.infer<typeof skillRequirementSchema>

/**
 * Egy forrás MINDEN csatolmány-kapuhoz (#199): korlátozott feladat-modál, normál
 * feladat-űrlap, `createBoardTicket` és a workspace-feltöltő endpoint. Hiányzó
 * érték = engedett — a mező bevezetése előtt írt skillek viselkedése változatlan.
 */
export function skillAllowsAttachments(
  hints: SkillRuntimeHints | null | undefined,
): boolean {
  return hints?.allowAttachments !== false
}

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

function clampToRange(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * Szerkesztői bemenet a megengedett tartományba húzása. A séma a tartományon
 * KÍVÜLI értéket elutasítaná — a katalógus UI-ban ez nyers zod-hibaként érne
 * földet; a clamp helyette a legközelebbi érvényes keretet adja, amit a
 * szerkesztő azonnal lát a mezőben. Üres / értelmezhetetlen mező kimarad.
 */
export function clampSkillRuntimeHints(
  input: {
    maxWallClockMs?: number | null
    maxToolCalls?: number | null
    preferredMode?: 'chat' | 'task' | null
    allowAttachments?: boolean | null
    attachmentDescription?: string | null
  } | null
  | undefined,
): SkillRuntimeHints | undefined {
  if (!input) return undefined
  const maxWallClockMs =
    typeof input.maxWallClockMs === 'number' && Number.isFinite(input.maxWallClockMs)
      ? clampToRange(input.maxWallClockMs, SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs)
      : undefined
  const maxToolCalls =
    typeof input.maxToolCalls === 'number' && Number.isFinite(input.maxToolCalls)
      ? clampToRange(input.maxToolCalls, SKILL_RUNTIME_HINT_LIMITS.maxToolCalls)
      : undefined
  const preferredMode = input.preferredMode ?? undefined
  // A csatolmány-flag alapértéke ENGEDETT, ezért csak a tiltást tároljuk el.
  // A `true` elhagyása visszafelé kompatibilis hasht és tisztább diffet ad.
  const allowAttachments = input.allowAttachments === false ? false : undefined
  const attachmentDescriptionRaw =
    typeof input.attachmentDescription === 'string'
      ? input.attachmentDescription.trim()
      : ''
  const attachmentDescription =
    allowAttachments !== false && attachmentDescriptionRaw
      ? attachmentDescriptionRaw.slice(0, SKILL_ATTACHMENT_DESCRIPTION_MAX)
      : undefined
  if (
    maxWallClockMs == null &&
    maxToolCalls == null &&
    preferredMode == null &&
    allowAttachments == null &&
    attachmentDescription == null
  ) {
    return undefined
  }
  return {
    ...(maxWallClockMs != null ? { maxWallClockMs } : {}),
    ...(maxToolCalls != null ? { maxToolCalls } : {}),
    ...(preferredMode != null ? { preferredMode } : {}),
    ...(allowAttachments != null ? { allowAttachments } : {}),
    ...(attachmentDescription != null ? { attachmentDescription } : {}),
  }
}

/**
 * Több skill hint aggregálása: wallclock / tool-büdzsé → maximum;
 * preferredMode → 'task' nyer, ha bármelyik kéri;
 * allowAttachments → a LEGSZIGORÚBB nyer: egyetlen tiltó skill is letiltja a
 * csatolást, különben egy megengedő skill kiválasztásával meg lehetne kerülni a
 * másikon beállított tiltást.
 */
export function aggregateSkillRuntimeHints(
  hintsList: Array<SkillRuntimeHints | null | undefined>,
): SkillRuntimeHints | undefined {
  let maxWallClockMs: number | undefined
  let maxToolCalls: number | undefined
  let preferredMode: 'chat' | 'task' | undefined
  let allowAttachments: boolean | undefined
  for (const hints of hintsList) {
    if (!hints) continue
    if (hints.allowAttachments === false) allowAttachments = false
    if (typeof hints.maxWallClockMs === 'number') {
      maxWallClockMs =
        maxWallClockMs == null
          ? hints.maxWallClockMs
          : Math.max(maxWallClockMs, hints.maxWallClockMs)
    }
    if (typeof hints.maxToolCalls === 'number') {
      maxToolCalls =
        maxToolCalls == null ? hints.maxToolCalls : Math.max(maxToolCalls, hints.maxToolCalls)
    }
    if (hints.preferredMode === 'task') preferredMode = 'task'
    else if (hints.preferredMode === 'chat' && preferredMode == null) preferredMode = 'chat'
  }
  if (
    maxWallClockMs == null &&
    maxToolCalls == null &&
    preferredMode == null &&
    allowAttachments == null
  ) {
    return undefined
  }
  return {
    ...(maxWallClockMs != null ? { maxWallClockMs } : {}),
    ...(maxToolCalls != null ? { maxToolCalls } : {}),
    ...(preferredMode != null ? { preferredMode } : {}),
    ...(allowAttachments != null ? { allowAttachments } : {}),
  }
}

export function parseSkillRequires(value: unknown): SkillRequirement[] {
  const parsed = skillRequiresSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return []
}
