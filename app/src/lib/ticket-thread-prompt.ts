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

export function buildThreadContextPrompt(input: {
  comments: TicketCommentWithAttachments[]
  originalTask: string
  maxChars?: number
}): string {
  const maxChars = input.maxChars ?? 12000
  const relevant = input.comments.filter((comment) =>
    ['human_comment', 'agent_answer', 'system_note'].includes(comment.kind),
  )
  const lastHuman = [...relevant].reverse().find((comment) => comment.kind === 'human_comment')
  const lastAgent = [...relevant].reverse().find((comment) => comment.kind === 'agent_answer')
  const tail = relevant.slice(-10)

  const sections: string[] = [
    `Eredeti feladat:\n${clip(input.originalTask.trim(), 2400)}`,
  ]
  if (lastHuman) {
    sections.push(`A felhasznalo legutobbi pontositasat most kulonosen vedd figyelembe:\n${renderComment(lastHuman, 1800)}`)
  }
  if (lastAgent) {
    sections.push(`Legutobbi agent-valasz, amit ne torolj, hanem folytass/javits:\n${renderComment(lastAgent, 1800)}`)
  }
  if (tail.length > 0) {
    sections.push(`Idorendi ticket-szal lenyomat:\n${tail.map((comment) => renderComment(comment, 1200)).join('\n\n')}`)
  }

  return clip(sections.join('\n\n---\n\n'), maxChars)
}
