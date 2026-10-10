'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { services } from '@/domain/gateway-services'
import { getAuthContext } from '@/auth/context'
import { setActiveTenantCookie } from '@/auth/active-tenant-cookie'
import { SelfServiceTenantError } from '@/domain/tenant/tenant-service'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { TAX_ID_MAX_LENGTH } from '@/lib/tenant-policy'

/**
 * #830 Self-service cégindítás — a varázsló server actionjei.
 *
 * Szándékosan NINCS `requireTenantRole` / `requirePlatformRole`: a meghívó nélküli,
 * `pending` fiók is indíthat saját céget (D1+D6). A kapukat (ÁSZF, felfüggesztés,
 * assume, 5-ös limit) a `TenantService.provisionSelfService` kényszeríti ki.
 * A hibák `self_service:<kód>` alakúak — a UI üzleti szövegre fordítja.
 */

const createSelfServiceTenantSchema = z.object({
  displayName: z.string().max(200),
  legalName: z.string().max(400).optional(),
  taxId: z.string().max(TAX_ID_MAX_LENGTH * 2).optional(),
  termsAccepted: z.boolean(),
})

export async function createSelfServiceTenant(input: z.infer<typeof createSelfServiceTenantSchema>) {
  try {
    const ctx = await getAuthContext()
    if (!ctx) return fail('Unauthorized')
    const parsed = createSelfServiceTenantSchema.parse(input)
    const result = await services.tenants.provisionSelfService({
      userId: ctx.user.id,
      displayName: parsed.displayName,
      legalName: parsed.legalName ?? null,
      taxId: parsed.taxId ?? null,
      termsAccepted: parsed.termsAccepted,
      assumed: ctx.assumed,
    })
    await setActiveTenantCookie(result.tenant.id)
    revalidatePath('/', 'layout')
    return ok({ tenantId: result.tenant.id, displayName: result.tenant.displayName })
  } catch (e) {
    if (e instanceof SelfServiceTenantError) return fail(e.message)
    return fail(e instanceof Error ? e.message : 'Failed to create company')
  }
}

const acceptInvitationSchema = z.object({ invitationId: z.string().uuid() })

/** D8 „Csatlakozom": a saját e-mailre szóló meghívó beváltása, majd belépés abba a cégbe. */
export async function acceptOnboardingInvitation(input: { invitationId: string }) {
  try {
    const ctx = await getAuthContext()
    if (!ctx) return fail('Unauthorized')
    if (ctx.assumed) return fail('self_service:assumed_context')
    const { invitationId } = acceptInvitationSchema.parse(input)

    const user = await repositories.users.findById(ctx.user.id)
    if (!user) return fail('Unauthorized')
    if (user.status === 'suspended') return fail('self_service:user_suspended')

    const invitation = await repositories.invitations.findById(invitationId)
    // Idegen e-mailre szóló meghívó létezése se szivárogjon: ugyanaz a válasz, mint a nem létezőé.
    if (!invitation || invitation.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      return fail('invitation: not found')
    }

    await services.iam.acceptInvitationForSignedInUser({ invitationId, user })
    if (invitation.tenantId) await setActiveTenantCookie(invitation.tenantId)
    revalidatePath('/', 'layout')
    return ok({ tenantId: invitation.tenantId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to accept invitation')
  }
}
