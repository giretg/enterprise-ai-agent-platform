import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Level-2 mellékletek (skill-catalog-phase2-spec §P2-D8, a Fázis 1 D7 progresszív
 * betöltésének harmadik szintje).
 *
 * A progresszió: Level-0 (név+leírás) MINDIG a promptban → Level-1 (instrukciók)
 * `load_skill`-lel → Level-2 (melléklet-fájlok) `load_skill_attachment`-tel. Minden
 * szint külön, auditált aktus; a melléklet nulla bájt a kontextusban, amíg valaki
 * kifejezetten nem kéri.
 *
 * A melléklet SZÖVEG, nem futtatható artefakt. A csomag-importáló a kód-fájlokat
 * kihagyja (l. `skill-package-adapter`), így ide referencia-dokumentum,
 * adat-táblázat és sablon kerül — ezek a Fázis 1 „a skill instrukció, nem kód"
 * elvét nem sértik.
 */

/** Egy melléklet maximális mérete. Efölött a fájl kimarad az importból. */
export const SKILL_ATTACHMENT_MAX_BYTES = 128 * 1024
/** Az összes melléklet együttes maximális mérete egy skill-verzióban. */
export const SKILL_ATTACHMENTS_TOTAL_MAX_BYTES = 512 * 1024
/** Egy skill-verzió maximális melléklet-darabszáma. */
export const SKILL_ATTACHMENT_MAX_COUNT = 20
/**
 * Betöltéskor (Level-2) a promptba engedett maximális karakterszám. A tárolt
 * melléklet ennél nagyobb lehet — ilyenkor csonkolva, EXPLICIT jelzéssel megy át,
 * hogy a modell tudja: nem a teljes fájlt látja.
 */
export const SKILL_ATTACHMENT_LOAD_MAX_CHARS = 30_000

export const skillAttachmentSchema = z.object({
  /** A skill gyökeréhez relatív útvonal, pl. `references/tax-rules.md`. */
  path: z.string().min(1).max(300),
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  /** A nyers bájtok SHA-256-ja — provenience és verzió-diff. */
  sha256: z.string(),
})

export const skillAttachmentsSchema = z.array(skillAttachmentSchema).default([])

export type SkillAttachment = z.infer<typeof skillAttachmentSchema>

/** Fail-safe olvasás tárolt Json-ből: hibás alak → üres lista (nem dob prompt-építés közben). */
export function parseSkillAttachments(value: unknown): SkillAttachment[] {
  const parsed = skillAttachmentsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

export function hashAttachmentBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A melléklet-lista determinista ujjlenyomata — a `contentHash` ezt is bevonja. */
export function attachmentsFingerprint(attachments: SkillAttachment[]): string[] {
  return [...attachments]
    .map((a) => `${a.path}:${a.sha256}`)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Level-2 betöltési szöveg. A csonkolás EXPLICIT — a modell nem hiheti azt, hogy a
 * teljes fájlt látja, mert abból csendes, rossz következtetés lesz.
 */
export function formatAttachmentForPrompt(attachment: SkillAttachment): string {
  const truncated = attachment.text.length > SKILL_ATTACHMENT_LOAD_MAX_CHARS
  const body = truncated
    ? attachment.text.slice(0, SKILL_ATTACHMENT_LOAD_MAX_CHARS)
    : attachment.text
  const header = `# Skill-melléklet: ${attachment.path}`
  const notice = truncated
    ? `\n\n[CSONKOLVA — a melléklet ${attachment.text.length} karakter, ebből az első ${SKILL_ATTACHMENT_LOAD_MAX_CHARS} látható.]`
    : ''
  return `${header}\n\n${body}${notice}`
}

/** Level-1 betöltéskor a melléklet-lista (nem a tartalom!) megy át a modellnek. */
export function formatAttachmentIndex(
  attachments: SkillAttachment[],
  /** A Level-1 instrukció-szöveg: ha relatív mellékletre hivatkozik, de nincs csatolva, jelezzük. */
  instructionsText?: string,
): string {
  if (attachments.length === 0) {
    // Mért eset (2026-09-15, tárgyalási felkészítő): az instrukció
    // `references/…` és `assets/…` fájlokra mutatott, a verzióhoz nem volt
    // csatolmány → a modell 3 file_glob-bal kereste a munkaterületen, majd a
    // hiányra hivatkozott. Egy sor megspórolja a keresést.
    const missing = [
      ...new Set(
        [...(instructionsText ?? '').matchAll(/\]\(((?:references|assets)\/[^)#]+)/g)].map((m) => m[1]),
      ),
    ]
    if (missing.length === 0) return ''
    return (
      `A skill instrukciója mellékletekre hivatkozik (${missing.join(', ')}), de ehhez a ` +
      `skill-verzióhoz NINCS csatolmány. Ne keresd őket a munkaterületen és ne hivatkozz a ` +
      `hiányukra — az instrukció önmagában elegendő keret.`
    )
  }
  const lines = attachments.map((a) => `- ${a.path} (${Math.ceil(a.bytes / 1024)} KB)`)
  return (
    `A skillhez tartozó mellékletek (a tartalmuk NINCS betöltve — ha kell, ` +
    `a load_skill_attachment eszközzel kérd le őket útvonal szerint):\n${lines.join('\n')}`
  )
}
