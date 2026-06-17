export function readWikiTicketPayload(payload: Record<string, unknown>) {
  const question = typeof payload.question === 'string' ? payload.question.trim() : ''
  const followUpNotes = Array.isArray(payload.followUpNotes)
    ? payload.followUpNotes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
    : []
  const previousAnswer = typeof payload.answer === 'string' ? payload.answer.trim() : null

  return { question, followUpNotes, previousAnswer }
}

export function wikiSearchQuery(payload: Record<string, unknown>): string {
  const { question, followUpNotes } = readWikiTicketPayload(payload)
  if (followUpNotes.length === 0) return question
  return `${question} ${followUpNotes.join(' ')}`.trim()
}

export function wikiUserPrompt(payload: Record<string, unknown>): string {
  const { question, followUpNotes, previousAnswer } = readWikiTicketPayload(payload)
  const latestFollowUp = followUpNotes.at(-1)

  const sections = [`Eredeti kérdés:\n${question}`]

  if (previousAnswer) {
    sections.push(`Előző válasz (a felhasználó ezt pontosítani / javítani kéri):\n${previousAnswer}`)
  }

  if (latestFollowUp) {
    sections.push(`Pontosító kérés:\n${latestFollowUp}`)
  } else if (followUpNotes.length > 0) {
    sections.push(`Korábbi pontosítások:\n${followUpNotes.map((note, index) => `${index + 1}. ${note}`).join('\n')}`)
  }

  return `${sections.join('\n\n')}

Válaszolj magyarul, tömören. Adj vissza CSAK valid JSON-t ebben a formában:
{
  "answer": "...",
  "sources": [{"docId": "...", "sectionRef": "..."}],
  "rationale": "...",
  "confidence": "high|medium|low"
}`
}

export function appendWikiFollowUpNote(payload: Record<string, unknown>, note: string) {
  const trimmed = note.trim()
  const followUpNotes = Array.isArray(payload.followUpNotes)
    ? payload.followUpNotes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []

  return {
    ...payload,
    transitionNote: trimmed,
    followUpNotes: trimmed ? [...followUpNotes, trimmed] : followUpNotes,
  }
}

export function clearWikiAnswerFields(payload: Record<string, unknown>) {
  const next = { ...payload }
  delete next.answer
  delete next.sources
  delete next.rationale
  delete next.confidence
  delete next.retrievedSources
  return next
}
