/**
 * HITL confirm copy for the linked Gmail/Drive account execute will use.
 * Kept free of gateway/enterprise imports so unit tests stay dependency-light.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Hungarian MCP/chat confirm suffix — empty when account was not selected. */
export function linkedAccountConfirmSuffix(args: Record<string, unknown>): string {
  const account = str(args.account).trim()
  return account ? `fiók: ${account}` : ''
}

/** Gmail compose / draft send target line for write-confirm chat messages. */
export function gmailComposeConfirmTarget(args: Record<string, unknown>): string {
  if (str(args.draftId)) {
    return ['Gmail piszkozat elküldése: ' + str(args.draftId), linkedAccountConfirmSuffix(args)]
      .filter(Boolean)
      .join(', ')
  }
  const parts = [
    str(args.replyToMessageId)
      ? `Gmail válasz a(z) ${str(args.replyToMessageId)} levélre${args.replyAll === true ? ' (mindenkinek)' : ''}`
      : 'Gmail új levél',
    linkedAccountConfirmSuffix(args),
    str(args.to) ? `címzett: ${str(args.to)}` : str(args.replyToMessageId) ? 'címzett: az eredeti feladó' : '',
    str(args.cc) ? `másolat: ${str(args.cc)}` : '',
    str(args.bcc) ? `titkos másolat: ${str(args.bcc)}` : '',
    str(args.subject) ? `tárgy: ${str(args.subject)}` : '',
  ]
  return parts.filter(Boolean).join(', ')
}

export function gmailItemConfirmTarget(args: Record<string, unknown>): string {
  const item = str(args.threadId)
    ? `Gmail levélváltás ${str(args.threadId)}`
    : `Gmail levél ${str(args.messageId)}`
  const account = linkedAccountConfirmSuffix(args)
  return account ? `${item}, ${account}` : item
}
