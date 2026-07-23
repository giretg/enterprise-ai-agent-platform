'use server'

import { z } from 'zod'
import { getAuthContext } from '@/auth/context'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { fail, ok } from '@/lib/result'

/**
 * Telegram összekötés / visszavonás server-action réteg (Telegram feature-spec #70/#72, D12).
 *
 * - Az összekötést a felhasználó ÖNKISZOLGÁLÓ módon kéri (bármely aktív tag): aláírt, rövid
 *   élettartamú, egyszer felhasználható deep-link tokent kap, a szervezetére rögzítve (D2).
 * - A visszavonás azonnal fail-closed: saját kötést bárki, admin bármely szervezeti tagét.
 * - A profil-nézet a nyers külső azonosítót SOHA nem adja vissza — csak a csatorna típusát, a
 *   szervezetet, az összekötés idejét és az állapotot.
 */

const idSchema = z.string().uuid()

export type ChannelLinkView = {
  id: string
  channelType: string
  orgName: string | null
  linkedAt: string
  status: string
}

async function orgNameOf(tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null
  const tenant = await repositories.tenants.findById(tenantId)
  return tenant?.displayName ?? null
}

/** A webes „Telegram összekötése" gomb magja — a figyelmeztetést is visszaadja (a döntés hordozója). */
export async function startTelegramLink() {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('viewer')
    const res = await services.channelLinking.issueLinkToken({
      userId: ctx.user.id,
      tenantId: ctx.activeTenantId,
      channelType: 'telegram',
    })
    if (!res.ok) {
      return fail(
        res.reason === 'channel_disabled'
          ? 'A Telegram-csatorna jelenleg ki van kapcsolva. Kérd a rendszergazdát, hogy kapcsolja be.'
          : 'A platform-adminisztrátor még nem állította be a Telegram-botot, ezért az összekötés most nem indítható.',
      )
    }
    return ok({
      deepLink: res.deepLink,
      warning: res.warning,
      expiresAt: res.expiresAt.toISOString(),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült elindítani az összekötést.')
  }
}

/** Saját Telegram-kötés megszüntetése — azonnal fail-closed. */
export async function unlinkMyTelegram(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('viewer')
    const identityId = idSchema.parse(input)
    const identity = await repositories.channelIdentities.findById(identityId)
    if (!identity || identity.userId !== ctx.user.id) {
      return fail('Ez a Telegram-kötés nem a tiéd, vagy már nem létezik.')
    }
    const res = await services.channelLinking.revokeIdentity({
      identityId,
      actorUserId: ctx.user.id,
      scope: 'self',
    })
    if (!res.ok) return fail('A Telegram-kötés megszüntetése nem sikerült.')
    return ok({ id: identityId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült megszüntetni az összekötést.')
  }
}

/** Tenant-admin: bármely szervezeti tag Telegram-kötésének megszüntetése (kilépő kolléga). */
export async function adminUnlinkTelegram(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('admin')
    const identityId = idSchema.parse(input)
    const identity = await repositories.channelIdentities.findById(identityId)
    // Fail-closed: az admin CSAK a saját szervezetéhez tartozó kötést szüntetheti meg.
    if (!identity || identity.tenantId !== ctx.activeTenantId) {
      return fail('Ez a Telegram-kötés nem ehhez a szervezethez tartozik, vagy már nem létezik.')
    }
    const res = await services.channelLinking.revokeIdentity({
      identityId,
      actorUserId: ctx.user.id,
      scope: 'admin',
    })
    if (!res.ok) return fail('A Telegram-kötés megszüntetése nem sikerült.')
    return ok({ id: identityId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült megszüntetni az összekötést.')
  }
}

/** A saját csatorna-kötések a profil-nézethez (nyers külső id nélkül). */
export async function listMyChannelLinks(): Promise<ChannelLinkView[]> {
  const ctx = await getAuthContext()
  if (!ctx) return []
  const identities = await services.channelLinking.listUserIdentities(ctx.user.id)
  const views: ChannelLinkView[] = []
  for (const i of identities) {
    views.push({
      id: i.id,
      channelType: i.channelType,
      orgName: await orgNameOf(i.tenantId),
      linkedAt: i.linkedAt.toISOString(),
      status: i.status,
    })
  }
  return views
}

export type TenantChannelLinkView = ChannelLinkView & { userName: string; userEmail: string }

/** Tenant-admin nézet: a szervezet aktív Telegram-kötései (kihez tartoznak). */
export async function listTenantChannelLinks(): Promise<TenantChannelLinkView[]> {
  const ctx = await getAuthContext()
  if (!ctx || ctx.kind !== 'tenant' || ctx.activeTenantRole !== 'admin' || !ctx.activeTenantId) {
    return []
  }
  const rows = await repositories.channelIdentities.listByTenantWithUsers(ctx.activeTenantId)
  const orgName = await orgNameOf(ctx.activeTenantId)
  return rows.map((r) => ({
    id: r.id,
    channelType: r.channelType,
    orgName,
    linkedAt: r.linkedAt.toISOString(),
    status: r.status,
    userName: r.user.name,
    userEmail: r.user.email,
  }))
}

export type UserNotificationView = {
  id: string
  kind: string
  title: string
  body: string
  readAt: string | null
  createdAt: string
}

/** Saját platform-értesítések (pl. „Telegram-fiók összekötve"). */
export async function listMyNotifications(): Promise<UserNotificationView[]> {
  const ctx = await getAuthContext()
  if (!ctx) return []
  const rows = await repositories.userNotifications.listForUser(ctx.user.id, 20)
  return rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }))
}

/** Egy saját értesítés olvasottnak jelölése. */
export async function markMyNotificationRead(input: unknown) {
  try {
    const ctx = await getAuthContext()
    if (!ctx) return fail('Nincs bejelentkezett felhasználó.')
    const id = idSchema.parse(input)
    await repositories.userNotifications.markRead(id, ctx.user.id, new Date())
    return ok({ id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni az értesítést.')
  }
}
