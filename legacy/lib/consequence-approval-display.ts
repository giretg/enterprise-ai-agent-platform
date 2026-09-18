import {
  EXTERNAL_DATA_CLOSE,
  EXTERNAL_DATA_OPEN,
  EXTERNAL_DATA_WARNING,
} from '@/domain/tool-broker/tool-result-envelope'

const APPROVAL_CONTINUATION_PREFIX = '[Jóváhagyás a felületen]'
const APPROVAL_CONTINUATION_DISPLAY = '✅ Jóváhagyva — a művelet lefutott.'

/** Optimista buborék vagy perzisztált jóváhagyás-folytatás user-üzenet. */
export function isApprovalContinuationMessage(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith(APPROVAL_CONTINUATION_PREFIX) ||
    trimmed.startsWith('✅ Jóváhagyva —')
  )
}

export function approvalContinuationDisplayText(text: string): string {
  if (text.trimStart().startsWith('✅ Jóváhagyva —')) return text.trim()
  return APPROVAL_CONTINUATION_DISPLAY
}

/** A modellnek szánt, becsomagolt tartalom — csak adminnak jelenik meg. */
export function extractApprovalContinuationTechnicalDetails(text: string): string | null {
  if (!text.includes(APPROVAL_CONTINUATION_PREFIX)) return null
  const openIdx = text.indexOf(EXTERNAL_DATA_OPEN)
  const closeIdx = text.indexOf(EXTERNAL_DATA_CLOSE)
  if (openIdx >= 0 && closeIdx > openIdx) {
    const warning = text.includes(EXTERNAL_DATA_WARNING) ? `${EXTERNAL_DATA_WARNING}\n\n` : ''
    const body = text.slice(openIdx + EXTERNAL_DATA_OPEN.length, closeIdx).trim()
    return `${warning}${EXTERNAL_DATA_OPEN}\n${body}\n${EXTERNAL_DATA_CLOSE}`
  }
  const afterHeader = text.slice(text.indexOf('\n') + 1).trim()
  const footerIdx = afterHeader.indexOf('NE futtasd újra')
  const body = footerIdx >= 0 ? afterHeader.slice(0, footerIdx).trim() : afterHeader
  return body || null
}
