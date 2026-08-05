import type { TicketCommentWithAttachments } from '@/repositories/interfaces'

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[levagva]`
}

function actorLabel(comment: TicketCommentWithAttachments): string {
  if (comment.authorDisplayName?.trim()) return comment.authorDisplayName.trim()
  if (comment.authorType === 'agent') return 'Agent'
  if (comment.authorType === 'system') return 'Rendszer'
  return 'Felhasznalo'
}

function kindLabel(kind: TicketCommentWithAttachments['kind']): string {
  if (kind === 'agent_answer') return 'agent valasz'
  if (kind === 'human_comment') return 'emberi komment'
  if (kind === 'system_note') return 'rendszer'
  return 'agent folyamat'
}

function attachmentLine(comment: TicketCommentWithAttachments): string {
  if (comment.attachments.length === 0) return ''
  const parts = comment.attachments.map((attachment) => {
    const extracted = attachment.document.extractedText?.trim()
    const preview = extracted
      ? `; kivonat: ${clip(extracted.replace(/\s+/g, ' '), 600)}`
      : ''
    return `- ${attachment.filename} (${attachment.mimeType ?? 'unknown'}${preview})`
  })
  return `\nCsatolmanyok:\n${parts.join('\n')}`
}

function renderComment(comment: TicketCommentWithAttachments, maxBodyChars: number): string {
  const body = clip(comment.body.trim() || '(ures)', maxBodyChars)
  return `[${comment.seq}] ${kindLabel(comment.kind)} - ${actorLabel(comment)}:\n${body}${attachmentLine(comment)}`
}

export function latestHumanTicketComment(comments: TicketCommentWithAttachments[]): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (comment.kind === 'human_comment' && comment.body.trim()) return comment.body.trim()
  }
  return null
}

/** Soft-resume szabályok handback / „folytasd” esetén — checkpoint a szál szövegéből. */
export const TICKET_CONTINUE_RULES = [
  'Ez FOLYTATÁS, nem új feladat: a legutóbbi agent-válasz „Elkészült / Nem készült el” részei a checkpointod.',
  'NE kezdd előlről a teljes discovery-t (teljes PDF újraolvasás, ugyanazok az API-lekérések), ha a checkpoint már tartalmazza az eredményt.',
  'A munkaterületen lévő deliverable fájlokat (xlsx/docx/pptx) NE töröld „újraépítéshez” — javítsd/bővítsd őket. Törléshez confirm:true kell.',
  'Nagy PDF-nél mindig page_range-dzsel dolgozz; ne olvasd be egyszerre a teljes dokumentumot.',
  'A „Nem készült el” listából vedd a következő konkrét lépést, és azzal folytasd.',
].join('\n')

/** Ticket → Megbeszélés (#219): chat-kontextus, nem ticket-handback. */
export const TICKET_DISCUSSION_RULES = [
  'Ez MEGBESZÉLÉS a felhasználóval egy meglévő feladatról — NEM ticket-handback és NEM ticket-folytatás a boardon.',
  'A ticket állapota, TicketComment szála és handback flow-ja NEM változik ebből a chatből.',
  'A ticket előzménye tájékoztató kontextus: belőle tájékozódj, a válaszod a chatben hangzik el.',
].join('\n')

export function buildThreadContextPrompt(input: {
  comments: TicketCommentWithAttachments[]
  originalTask: string
  maxChars?: number
  workspaceFiles?: string[]
  /** `discussion`: chat-megbeszélés (#219) — continue szabályok helyett megbeszélés-szabályok. */
  mode?: 'ticket' | 'discussion'
}): string {
  const maxChars = input.maxChars ?? 14000
  const mode = input.mode ?? 'ticket'
  const relevant = input.comments.filter((comment) =>
    ['human_comment', 'agent_answer', 'system_note'].includes(comment.kind),
  )
  const lastHuman = [...relevant].reverse().find((comment) => comment.kind === 'human_comment')
  const lastAgent = [...relevant].reverse().find((comment) => comment.kind === 'agent_answer')
  const isContinuation = Boolean(lastAgent)
  const tail = relevant.slice(-10)

  const sections: string[] = [
    `Eredeti feladat:\n${clip(input.originalTask.trim(), 2400)}`,
  ]
  if (mode === 'discussion') {
    sections.push(`Megbeszelesi szabalyok (kotelezo):\n${TICKET_DISCUSSION_RULES}`)
  } else if (isContinuation) {
    sections.push(`Folytatasi szabalyok (kotelezo):\n${TICKET_CONTINUE_RULES}`)
  }
  if (lastHuman) {
    sections.push(`A felhasznalo legutobbi pontositasat most kulonosen vedd figyelembe:\n${renderComment(lastHuman, 1800)}`)
  }
  if (lastAgent) {
    sections.push(`Legutobbi agent-valasz (CHECKPOINT — ne torold, hanem folytass/javits):\n${renderComment(lastAgent, 3200)}`)
  }
  const deliverables = (input.workspaceFiles ?? []).filter((path) =>
    /\.(xlsx|xlsm|docx|pptx)$/i.test(path) && !path.startsWith('.tool-results/'),
  )
  if (deliverables.length > 0) {
    sections.push(
      `Meglevo deliverable fajlok a munkateruleten (NE torold oket ujraepiteshez):\n` +
        deliverables.map((path) => `- ${path}`).join('\n'),
    )
  }
  if (tail.length > 0) {
    sections.push(`Idorendi ticket-szal lenyomat:\n${tail.map((comment) => renderComment(comment, 1200)).join('\n\n')}`)
  }

  return clip(sections.join('\n\n---\n\n'), maxChars)
}

/** Ticket → Megbeszélés (#219): a chat UI-ban látható előzmény (nem Message rekord). */
export type TicketDiscussionHistoryItem = {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  authorLabel: string
  createdAt: string
}

function historyRole(
  kind: TicketCommentWithAttachments['kind'],
): TicketDiscussionHistoryItem['role'] {
  if (kind === 'agent_answer' || kind === 'agent_progress') return 'agent'
  if (kind === 'system_note') return 'system'
  return 'user'
}

/**
 * A ticket-szál olvasható másolata a megbeszélés chatben. Nem perzisztál Message-ként —
 * csak megjelenítés; a modell továbbra is a system prompt prior kontextusát kapja.
 */
export function buildTicketDiscussionHistory(input: {
  comments: TicketCommentWithAttachments[]
  originalTask: string
  ticketCreatedAt?: Date | string | null
}): TicketDiscussionHistoryItem[] {
  const items: TicketDiscussionHistoryItem[] = []
  const task = input.originalTask.trim()
  if (task) {
    items.push({
      id: 'ticket-original-task',
      role: 'user',
      text: task,
      authorLabel: 'Eredeti feladat',
      createdAt:
        input.ticketCreatedAt instanceof Date
          ? input.ticketCreatedAt.toISOString()
          : typeof input.ticketCreatedAt === 'string'
            ? input.ticketCreatedAt
            : new Date(0).toISOString(),
    })
  }

  const relevant = input.comments.filter((comment) =>
    ['human_comment', 'agent_answer', 'system_note'].includes(comment.kind),
  )
  for (const comment of relevant) {
    const text = comment.body.trim()
    if (!text) continue
    // Ha az első emberi komment szó szerint az eredeti feladat, ne duplikáljuk.
    if (
      items.length === 1 &&
      comment.kind === 'human_comment' &&
      text === task
    ) {
      continue
    }
    items.push({
      id: comment.id,
      role: historyRole(comment.kind),
      text,
      authorLabel: actorLabel(comment),
      createdAt: comment.createdAt.toISOString(),
    })
  }
  return items
}
