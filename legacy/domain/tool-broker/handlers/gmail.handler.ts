import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const GMAIL_TOOLS = new Set([
  'gmail_search',
  'gmail_get_message',
  'mailbox_count',
  'gmail_create_draft',
  'gmail_send',
])

/**
 * Gmail delegált eszközök. A gmail_send emberi-jóváhagyás kapuja a KERETBEN
 * (invoke) dől el; ide már csak a jóváhagyott hívás jut el. A hozzáférési token
 * a user-delegált grantból oldódik fel (`resolveDelegatedAccessToken`).
 */
export const gmailHandler: ToolHandler = {
  id: 'gmail',
  handles(tool) {
    return GMAIL_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization }: ToolHandlerArgs) {
    const accessToken = await ctx.resolveDelegatedAccessToken(input, authorization)
    const gmail = new GmailApiClient(accessToken)

    if (input.tool === 'gmail_search') {
      const res = await gmail.search(input.args)
      return { messages: res.messages }
    }
    if (input.tool === 'gmail_get_message') {
      return gmail.getMessage(input.args)
    }
    if (input.tool === 'mailbox_count') {
      const query = input.args.query ?? ''
      const res = await gmail.count({
        query,
        labelIds: input.args.labelIds,
        includeSpamTrash: input.args.includeSpamTrash,
      })
      return { count: res.count, query }
    }
    if (input.tool === 'gmail_create_draft') {
      return gmail.createDraft(input.args)
    }
    if (input.tool === 'gmail_send') {
      return gmail.send(input.args)
    }
    throw new Error(`Unknown delegated tool: ${input.tool}`)
  },
}
