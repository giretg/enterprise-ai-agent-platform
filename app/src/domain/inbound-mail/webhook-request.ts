/**
 * #1032 `/api/webhooks/mail/<provider>` HTTP-szerződése — transzport-független, tesztelhető.
 * - agentmail: Svix-aláírás (a postafiókhoz tartozó titokkal) → 401 hamis aláírásnál.
 * - google: Pub/Sub push, Google OIDC ID token (audience + service account) → 401 hiányzó/rossz tokennél.
 * - microsoft: Graph validációs kérés (`validationToken` visszaküldése), értesítésnél clientState.
 */
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { readBoundedText, RequestTooLargeError } from '@/lib/request-body'
import { decodeGmailPush } from './providers'
import type { MailboxWatcher } from './watcher'

export const MAX_WEBHOOK_BYTES = 256 * 1024

export type WebhookDeps = {
  watcher: Pick<MailboxWatcher, 'handleAgentMailWebhook' | 'handleGmailPush' | 'handleGraphNotifications'>
  verifyGoogleToken: (token: string) => Promise<boolean>
  audit?: AuditSink
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

async function rejected(deps: WebhookDeps, provider: string, reason: string) {
  await writeAudit(deps.audit, {
    actorType: 'system',
    action: 'inbound_mail.webhook_rejected',
    targetType: 'mail_webhook',
    targetId: provider,
    policyDecision: 'denied',
    metadata: { rejectCode: reason },
  }).catch(() => {})
}

export async function handleMailWebhookRequest(provider: string, request: Request, deps: WebhookDeps): Promise<Response> {
  const url = new URL(request.url)
  if (provider === 'microsoft' && url.searchParams.has('validationToken')) {
    // Graph feliratkozáskor ezt kéri: a tokent nyers szövegként, 10 mp-en belül.
    return new Response(url.searchParams.get('validationToken') ?? '', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  let body: string
  try {
    body = await readBoundedText(request, MAX_WEBHOOK_BYTES)
  } catch (error) {
    if (error instanceof RequestTooLargeError) return json(413, { error: 'too_large' })
    throw error
  }

  if (provider === 'agentmail') {
    const result = await deps.watcher.handleAgentMailWebhook({
      connectorId: url.searchParams.get('c'),
      body,
      svixId: request.headers.get('svix-id') ?? request.headers.get('webhook-id'),
      svixTimestamp: request.headers.get('svix-timestamp') ?? request.headers.get('webhook-timestamp'),
      svixSignature: request.headers.get('svix-signature') ?? request.headers.get('webhook-signature'),
    })
    if (result.status === 401) await rejected(deps, provider, 'bad_signature')
    return json(result.status, result.status === 200 ? { ok: true, created: result.created } : { error: result.status === 401 ? 'invalid_signature' : 'bad_request' })
  }

  if (provider === 'google') {
    const token = /^Bearer\s+(\S+)/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token || !(await deps.verifyGoogleToken(token).catch(() => false))) {
      await rejected(deps, provider, 'bad_oidc_token')
      return json(401, { error: 'unauthenticated' })
    }
    let payload: unknown = null
    try {
      payload = JSON.parse(body)
    } catch {
      // lent
    }
    const push = decodeGmailPush(payload)
    // Rossz formátumú üzenetet nyugtázunk (200), különben a Pub/Sub a végtelenségig újraküldi.
    if (!push) return json(200, { ok: true, created: 0 })
    const created = await deps.watcher.handleGmailPush(push)
    return json(200, { ok: true, created })
  }

  if (provider === 'microsoft') {
    let payload: unknown = null
    try {
      payload = JSON.parse(body)
    } catch {
      return json(400, { error: 'bad_request' })
    }
    const result = await deps.watcher.handleGraphNotifications(payload)
    if (result.valid === 0 && result.invalid > 0) {
      await rejected(deps, provider, 'bad_client_state')
      return json(401, { error: 'invalid_client_state' })
    }
    return json(202, { ok: true, created: result.created })
  }

  return json(404, { error: 'not_found' })
}
