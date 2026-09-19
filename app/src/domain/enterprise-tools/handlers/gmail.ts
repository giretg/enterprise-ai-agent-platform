import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import { GMAIL_GET_MESSAGE_TOOL, GMAIL_SEARCH_TOOL, type EnterpriseGmailTool } from '../tool-definitions'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
  throw new Error(`unsupported gmail tool: ${toolName}`)
}
