/**
 * Skill `preferredMode: 'task'` → board-promóció (issue #161).
 *
 * A hosszú skill (tulajdoni-lap egyeztetés, nagy kutatás) nem attól lesz kész,
 * hogy a chat fordulóját 15 percre nyújtjuk: a felhasználó közben egy pörgő
 * jelzést néz, a lecsatlakozás kockázata nő, és a részeredmény a beszélgetésben
 * ragad. Ilyenkor ticketet nyitunk, a munka a boardon fut végig, a chat pedig
 * rövid marad — a felhasználó azonnal kap egy hivatkozást, ahol követheti.
 *
 * Ez a modul a DÖNTÉS és a SZÖVEG; a ticket felvétele a chat-runtime dolga.
 */

export type SkillTaskPromotionHints = {
  preferredMode?: 'chat' | 'task'
} | null | undefined

export type SkillTaskPromotionBinding = {
  conversationId: string
  sourceDocumentId: string | null
  attachmentDocumentIds: string[]
  ticketAttachments: Array<{
    documentId: string
    filename: string
    mimeType: string | null
    kind: 'file' | 'screenshot'
  }>
}

export type PromotedTaskAttachment = {
  documentId: string
  filename: string
  mimeType: string | null
  byteSize: number | null
}

function metadataByteSize(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).byteSize
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * A chat csatolmányait első osztályú ticket-csatolmányokká alakító szerződés.
 * A `sourceDocumentId` az egyfájlos legacy fogyasztókat tartja működésben.
 */
export function buildPromotedTaskAttachmentTransfer(
  documents: Array<{
    id: string
    filename: string
    mimeType?: string | null
    metadata?: unknown
  }>,
): { sourceDocumentId: string | null; attachments: PromotedTaskAttachment[] } {
  return {
    sourceDocumentId: documents[0]?.id ?? null,
    attachments: documents.map((document) => ({
      documentId: document.id,
      filename: document.filename,
      mimeType: document.mimeType ?? null,
      byteSize: metadataByteSize(document.metadata),
    })),
  }
}

/**
 * A chatből promótált ticket erőforrás-kapcsolatai.
 *
 * Minden dokumentum explicit ticket-csatolmány lesz; az első emellett a
 * ticket natív `sourceDocumentId` kapcsolatába is bekerül. A payload-lista
 * promptolási adat marad; jogosultságot önmagában nem ad.
 */
export function buildSkillTaskPromotionBinding(input: {
  conversationId: string
  documents: Array<{
    id: string
    filename: string
    mimeType: string | null
    kind: 'file' | 'screenshot'
  }>
}): SkillTaskPromotionBinding {
  const documents = [...new Map(input.documents.map((document) => [document.id, document])).values()]
  const attachmentDocumentIds = documents.map((document) => document.id)
  return {
    conversationId: input.conversationId,
    sourceDocumentId: attachmentDocumentIds[0] ?? null,
    attachmentDocumentIds,
    ticketAttachments: documents.map((document) => ({
      documentId: document.id,
      filename: document.filename,
      mimeType: document.mimeType,
      kind: document.kind,
    })),
  }
}

/** A promóció alapesetben a `/slash` úton betöltött skillre vonatkozik. */
export function shouldPromoteSkillRunToTask(input: {
  runtimeHints: SkillTaskPromotionHints
  loadedSkillNames: string[]
}): boolean {
  if (input.loadedSkillNames.length === 0) return false
  return input.runtimeHints?.preferredMode === 'task'
}

/** Ticket-cím a felhasználó kéréséből — rövid, kereshető, skill-névvel. */
export function buildSkillTaskTitle(input: {
  skillNames: string[]
  userText: string
  maxLength?: number
}): string {
  const max = input.maxLength ?? 120
  const skill = input.skillNames[0] ?? 'skill'
  const request = input.userText.replace(/\s+/g, ' ').trim()
  const base = request ? `${skill}: ${request}` : skill
  return base.length <= max ? base : `${base.slice(0, max - 1)}…`
}

/**
 * A chatben megjelenő válasz. Közérthető: mi történt, miért, hol folytatódik,
 * és mit tehet a felhasználó. A ticket hivatkozását a panel a `ticketRefId`
 * alapján kártyaként is kirakja — a szövegnek önmagában is állnia kell.
 */
export function buildSkillTaskPromotionMessage(input: {
  skillNames: string[]
  ticketTitle: string
  attachmentCount?: number
}): string {
  const skillList = input.skillNames.join(', ')
  const attachments = input.attachmentCount ?? 0
  const lines = [
    `Ez a feladat (${skillList}) hosszabb futású, ezért nem itt a chatben végzem el: felvettem a boardra, és ott dolgozom rajta végig.`,
    '',
    `**Feladat:** ${input.ticketTitle}`,
  ]
  if (attachments > 0) {
    lines.push(
      `**Csatolmány:** ${attachments} fájl átkerült a feladathoz — nem kell újra feltöltened.`,
    )
  }
  lines.push(
    '',
    'A feladat lapján követheted az állapotát, és ott kapod meg az eredményt is (a kész fájlokkal együtt). Ha közben kérdésem van, ott jelzem.',
    '',
    'Ha inkább itt, a chatben szeretnéd — kisebb részletre bontva —, írd meg, és úgy csináljuk.',
  )
  return lines.join('\n')
}
