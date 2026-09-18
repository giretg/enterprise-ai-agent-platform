import { verifyWebhook } from '@clerk/nextjs/webhooks'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { syncClerkUser, DomainNotAllowedError } from '@/auth/clerk-user-sync'
import { services } from '@/domain/gateway-services'
import { logger } from '@/lib/observability'

function userFromEvent(data: {
  id: string
  primary_email_address_id: string | null
  email_addresses: { id: string; email_address: string; verification: { status: string } | null }[]
  first_name: string | null
  last_name: string | null
  username: string | null
  public_metadata: unknown
}) {
  const primaryEmail = data.email_addresses.find((address) => address.id === data.primary_email_address_id)
  if (!primaryEmail || primaryEmail.verification?.status !== 'verified') return null
  const email = primaryEmail.email_address
  const name =
    [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || email
  const invitationId = (data.public_metadata as { enterpriseInvitationId?: unknown } | null)
    ?.enterpriseInvitationId
  return {
    externalAuthId: data.id,
    email,
    name,
    invitationId: typeof invitationId === 'string' ? invitationId : null,
  }
}

export async function POST(req: NextRequest) {
  let evt
  try {
    evt = await verifyWebhook(req)
  } catch (err) {
    logger.error({ event: 'clerk.webhook', error: String(err) }, 'Clerk webhook verification failed')
    return new Response('Verification failed', { status: 400 })
  }

  if (evt.type === 'user.created' || evt.type === 'user.updated') {
    const user = userFromEvent(evt.data)
    if (!user) {
      logger.info({ event: 'clerk.webhook', userId: evt.data.id }, 'Clerk webhook skipped: primary email is not verified')
      return new Response('OK', { status: 200 })
    }
    try {
      const synced = await syncClerkUser(prisma, user)
      if (user.invitationId) {
        await services.iam.redeemClerkInvitation({ invitationId: user.invitationId, user: synced })
      }
    } catch (err) {
      if (err instanceof DomainNotAllowedError) {
        // §7/B: az elutasítás + audit már megtörtént syncClerkUser-ben; a webhook
        // nem retry-oltatja Clerk-kel (200 OK), csak nincs mit tovább szinkronizálni.
        return new Response('OK', { status: 200 })
      }
      throw err
    }
  }

  if (evt.type === 'user.deleted') {
    // FK-k miatt nem törlünk — login-kor upsert továbbra is működik
    logger.info({ event: 'clerk.webhook', userId: evt.data.id }, 'Clerk user.deleted')
  }

  return new Response('OK', { status: 200 })
}
