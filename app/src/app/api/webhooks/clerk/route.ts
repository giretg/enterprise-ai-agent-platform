import { verifyWebhook } from '@clerk/nextjs/webhooks'
import type { UserRole } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'

function mapClerkRole(metadata: unknown): UserRole {
  const role = (metadata as { role?: string } | undefined)?.role
  if (role === 'admin' || role === 'approver' || role === 'operator' || role === 'viewer') {
    return role
  }
  return 'viewer'
}

function userFromEvent(data: {
  id: string
  email_addresses: { email_address: string }[]
  first_name: string | null
  last_name: string | null
  username: string | null
  public_metadata: unknown
}) {
  const email = data.email_addresses[0]?.email_address ?? 'unknown@local'
  const name =
    [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || email
  const role = mapClerkRole(data.public_metadata)
  return { externalAuthId: data.id, email, name, role }
}

export async function POST(req: NextRequest) {
  let evt
  try {
    evt = await verifyWebhook(req)
  } catch (err) {
    console.error('Clerk webhook verification failed:', err)
    return new Response('Verification failed', { status: 400 })
  }

  if (evt.type === 'user.created' || evt.type === 'user.updated') {
    const user = userFromEvent(evt.data)
    await prisma.user.upsert({
      where: { externalAuthId: user.externalAuthId },
      create: user,
      update: { email: user.email, name: user.name, role: user.role },
    })

    if (evt.type === 'user.created') {
      // Clerk-meghívóval érkezett regisztráció: a megfelelő in-app meghívót beváltottra
      // állítjuk, hogy a Meghívók lista a valóságot tükrözze (nincs külön token-beváltás).
      await prisma.invitation.updateMany({
        where: { email: user.email.toLowerCase(), status: 'pending' },
        data: { status: 'redeemed', redeemedAt: new Date() },
      })
    }
  }

  if (evt.type === 'user.deleted') {
    // FK-k miatt nem törlünk — login-kor upsert továbbra is működik
    console.info('Clerk user.deleted:', evt.data.id)
  }

  return new Response('OK', { status: 200 })
}
