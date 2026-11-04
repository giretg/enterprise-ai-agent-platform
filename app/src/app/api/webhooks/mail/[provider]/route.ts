import { repositories } from '@/repositories/postgres'
import { handleMailWebhookRequest } from '@/domain/inbound-mail/webhook-request'
import { verifyGoogleOidcToken } from '@/domain/inbound-mail/webhook-auth'
import { inboundMail } from '@/lib/inbound-mail/deps'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ provider: string }> }

/**
 * #1032 bejövő levél push-értesítései (AgentMail webhook, Gmail Pub/Sub, Microsoft Graph).
 * Clerk nélkül (`/api/webhooks(.*)`): minden szolgáltató saját aláírással / tokennel hitelesít.
 */
async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { provider } = await context.params
  const audience = process.env.GMAIL_PUSH_AUDIENCE?.trim()
  const email = process.env.GMAIL_PUSH_SERVICE_ACCOUNT?.trim()
  return handleMailWebhookRequest(provider, request, {
    watcher: inboundMail().watcher,
    verifyGoogleToken: (token) =>
      audience && email ? verifyGoogleOidcToken(token, { audience, email }) : Promise.resolve(false),
    audit: repositories.audit,
  })
}

export const POST = handle
export const GET = handle
