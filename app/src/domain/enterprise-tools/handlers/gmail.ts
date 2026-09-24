import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import {
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_GET_THREAD_TOOL,
  GMAIL_LIST_DRAFTS_TOOL,
  GMAIL_LIST_LABELS_TOOL,
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_SEND_TOOL,
  GMAIL_TRASH_TOOL,
  type EnterpriseGmailTool,
} from '../tool-definitions'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function csv(value: unknown): string[] {
  return (optionalString(value) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function addressOf(entry: string): string {
  return (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase()
}

/** Címlista összefésülése, duplikátum és a saját cím nélkül. */
function mergeAddresses(lists: string[], exclude: Set<string>): string {
  const seen = new Set(exclude)
  const out: string[] = []
  for (const entry of lists.flatMap((list) => list.split(',')).map((e) => e.trim()).filter(Boolean)) {
    const address = addressOf(entry)
    if (seen.has(address)) continue
    seen.add(address)
    out.push(entry)
  }
  return out.join(', ')
}

type Compose = {
  to?: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  threadId?: string
  inReplyTo?: string
  references?: string
}

/**
 * Új levél vagy válasz mezői. Válasznál a szál, az In-Reply-To/References, a
 * „Re:" tárgy és (ha nincs `to`) a címzett az eredeti levélből jön.
 */
export async function resolveCompose(gmail: GmailApiClient, args: Record<string, unknown>): Promise<Compose> {
  const body = optionalString(args.body) ?? ''
  const to = optionalString(args.to)
  const cc = optionalString(args.cc)
  const bcc = optionalString(args.bcc)
  const replyToMessageId = optionalString(args.replyToMessageId)
  if (!replyToMessageId) {
    return { to, cc, bcc, subject: optionalString(args.subject) ?? '', body }
  }

  const original = await gmail.getReplyContext({ messageId: replyToMessageId })
  const originalSubject = original.subject.trim()
  const subject =
    optionalString(args.subject) ??
    (/^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`.trim())
  const sender = original.replyTo || original.from
  let replyTo = to ?? sender
  let replyCc = cc
  if (!to && args.replyAll === true) {
    const self = new Set<string>()
    // A saját cím az eredeti To/Cc-ben van; a feladónak válaszolunk, magunknak nem.
    const me = await gmail.getProfileEmail()
    if (me) self.add(me.toLowerCase())
    replyTo = mergeAddresses([sender, original.to], self)
    replyCc = mergeAddresses([original.cc, cc ?? ''], new Set([...self, ...csv(replyTo).map(addressOf)])) || undefined
  }
  const references = [original.references, original.messageIdHeader].filter(Boolean).join(' ')
  return {
    to: replyTo,
    cc: replyCc,
    bcc,
    subject,
    body,
    threadId: original.threadId || undefined,
    inReplyTo: original.messageIdHeader || undefined,
    references: references || undefined,
  }
}

export async function executeGmailTool(
  toolName: EnterpriseGmailTool | string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  const gmail = new GmailApiClient(accessToken)
  if (toolName === GMAIL_SEARCH_TOOL) {
    return gmail.search({
      query: optionalString(args.query) ?? '',
      maxResults: optionalNumber(args.maxResults),
    })
  }
  if (toolName === GMAIL_GET_MESSAGE_TOOL) {
    return gmail.getMessage({ id: optionalString(args.id) ?? '' })
  }
  if (toolName === GMAIL_GET_THREAD_TOOL) {
    return gmail.getThread({ threadId: optionalString(args.threadId) ?? '' })
  }
  if (toolName === GMAIL_LIST_LABELS_TOOL) {
    return gmail.listLabels()
  }
  if (toolName === GMAIL_LIST_DRAFTS_TOOL) {
    return gmail.listDrafts({ maxResults: optionalNumber(args.maxResults) })
  }
  if (toolName === GMAIL_SEND_TOOL) {
    const draftId = optionalString(args.draftId)
    if (draftId) return gmail.send({ draftId })
    return gmail.send(await resolveCompose(gmail, args))
  }
  if (toolName === GMAIL_CREATE_DRAFT_TOOL) {
    return gmail.createDraft(await resolveCompose(gmail, args))
  }
  if (toolName === GMAIL_MODIFY_LABELS_TOOL) {
    return gmail.modifyLabels({
      messageId: optionalString(args.messageId),
      threadId: optionalString(args.threadId),
      addLabelIds: csv(args.addLabelIds),
      removeLabelIds: csv(args.removeLabelIds),
    })
  }
  if (toolName === GMAIL_TRASH_TOOL) {
    return gmail.trash({
      messageId: optionalString(args.messageId),
      threadId: optionalString(args.threadId),
    })
  }
  throw new Error(`unsupported gmail tool: ${toolName}`)
}
