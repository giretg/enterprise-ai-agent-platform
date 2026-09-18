export function ticketInputAttachmentDownloadUrl(ticketId: string, attachmentId: string): string {
  return `/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`
}
