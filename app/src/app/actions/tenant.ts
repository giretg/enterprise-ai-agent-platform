'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { services } from '@/domain'
import { getAuthContext, ACTIVE_TENANT_COOKIE } from '@/auth/context'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { decideSwitch, TENANT_AUDIT_ACTIONS } from '@/lib/tenant-policy'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'

const ACTIVE_TENANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 nap

async function setActiveTenantCookie(tenantId: string) {
  const store = await cookies()
  store.set(ACTIVE_TENANT_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_TENANT_COOKIE_MAX_AGE,
  })
}

// ── Tenant-váltás / assume / exit (§5.3, §9.1) ──────────────────────────────

const switchTenantSchema = z.object({ tenantId: z.string().uuid() })

/**
 * Aktív tenant kiválasztása (§5.3). Tenant-tag csak SAJÁT active membershipre
 * válthat; superadmin bármely tenantot "assume" módban választhat, audit mellett.
 */
export async function switchTenant(input: { tenantId: string }) {
  try {
    const { tenantId } = switchTenantSchema.parse(input)
    const ctx = await getAuthContext()
    if (!ctx) return fail('Unauthorized')

    const decision = decideSwitch({
      targetTenantId: tenantId,
      memberships: ctx.memberships,
      platformRoles: ctx.platformRoles,
    })
    if (!decision.allow) return fail(`tenant switch denied: ${decision.reason}`)

    const tenant = await repositories.tenants.findById(tenantId)
    if (!tenant) return fail('tenant: not found')

    await setActiveTenantCookie(tenantId)

    if (decision.mode === 'assume') {
      await services.tenants.recordAssumeTenant({ superadminId: ctx.user.id, tenantId })
    } else {
      await repositories.audit.append({
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: TENANT_AUDIT_ACTIONS.switch,
        targetType: 'tenant',
        targetId: tenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'switched',
        metadata: { tenantId },
        tenantId,
      })
    }

    revalidatePath('/', 'layout')
    return ok({ tenantId, mode: decision.mode })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to switch tenant')
  }
}

/** Superadmin kilépése az assumed tenantból ⇒ platform-kontextus (§5.3). */
export async function exitTenant() {
  try {
    const ctx = await getAuthContext()
    if (!ctx) return fail('Unauthorized')

    const store = await cookies()
    const current = store.get(ACTIVE_TENANT_COOKIE)?.value
    store.delete(ACTIVE_TENANT_COOKIE)

    if (ctx.assumed && current) {
      await services.tenants.recordExitTenant({ superadminId: ctx.user.id, tenantId: current })
    }

    revalidatePath('/', 'layout')
    return ok({ exited: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to exit tenant')
  }
}

/** A fejléc tenant-switcheréhez: a hívó választható tenantjai + platform-mód. */
export async function getTenantSwitcherState() {
  try {
    const ctx = await getAuthContext()
    if (!ctx) return fail('Unauthorized')

    const membershipTenantIds = ctx.memberships
      .filter((m) => m.status === 'active')
      .map((m) => m.tenantId)
    const tenants = await Promise.all(membershipTenantIds.map((id) => repositories.tenants.findById(id)))

    return ok({
      activeTenantId: ctx.activeTenantId,
      assumed: ctx.assumed,
      kind: ctx.kind,
      isSuperadmin: ctx.platformRoles.includes('superadmin'),
      tenants: tenants
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => ({ id: t.id, slug: t.slug, displayName: t.displayName, status: t.status })),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load tenant switcher')
  }
}

// ── Tenant lifecycle — platform-szintű (§7, §10) ────────────────────────────

const createTenantSchema = z.object({
  slug: z.string().min(2),
  displayName: z.string().min(1),
  legalName: z.string().optional(),
  domainAllowlist: z.array(z.string()).optional(),
  initialAdminUserId: z.string().uuid().optional(),
})

export async function createTenant(input: z.infer<typeof createTenantSchema>) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = createTenantSchema.parse(input)
    const tenant = await services.tenants.createTenant({
      slug: parsed.slug,
      displayName: parsed.displayName,
      legalName: parsed.legalName ?? null,
      domainAllowlist: parsed.domainAllowlist,
      createdById: ctx.user.id,
      initialAdminUserId: parsed.initialAdminUserId ?? null,
    })
    revalidatePath('/control-plane/platform/tenants')
    return ok(tenant)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create tenant')
  }
}

const tenantIdSchema = z.object({ tenantId: z.string().uuid() })

export async function listTenants() {
  try {
    await requirePlatformRole('platform_auditor')
    const tenants = await services.tenants.listTenants()
    return ok(tenants)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tenants')
  }
}

export async function suspendTenant(input: { tenantId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const { tenantId } = tenantIdSchema.parse(input)
    const t = await services.tenants.suspendTenant({ tenantId, actorId: ctx.user.id })
    revalidatePath('/control-plane/platform/tenants')
    return ok(t)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend tenant')
  }
}

export async function reactivateTenant(input: { tenantId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const { tenantId } = tenantIdSchema.parse(input)
    const t = await services.tenants.reactivateTenant({ tenantId, actorId: ctx.user.id })
    revalidatePath('/control-plane/platform/tenants')
    return ok(t)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reactivate tenant')
  }
}

export async function offboardTenant(input: { tenantId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const { tenantId } = tenantIdSchema.parse(input)
    const t = await services.tenants.offboardTenant({ tenantId, actorId: ctx.user.id })
    revalidatePath('/control-plane/platform/tenants')
    return ok(t)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to offboard tenant')
  }
}

export async function archiveTenant(input: { tenantId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const { tenantId } = tenantIdSchema.parse(input)
    const t = await services.tenants.archiveTenant({ tenantId, actorId: ctx.user.id })
    revalidatePath('/control-plane/platform/tenants')
    return ok(t)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to archive tenant')
  }
}

// ── Platform IAM — platform-szintű (§9.3) ───────────────────────────────────

const TENANT_LIFECYCLE_AUDIT_ACTIONS = [
  'tenant.create',
  'tenant.suspend',
  'tenant.offboard',
  'tenant.archive',
  'tenant.reactivate',
  'tenant.assume',
  'tenant.switch',
  'tenant.exit',
  'platform.role.grant',
  'platform.role.revoke',
]

/** Platform-tagok (superadmin / operator / auditor) listája — §9.3 platform IAM. */
export async function listPlatformMembers() {
  try {
    await requirePlatformRole('platform_auditor')
    const members = await services.tenants.listPlatformMembers()
    return ok(members)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list platform members')
  }
}

/** Platform-szintű assume/switch/lifecycle audit-napló — §9.3, §13/5. */
export async function getPlatformAuditTrail(input?: { limit?: number }) {
  try {
    await requirePlatformRole('platform_auditor')
    const entries = await repositories.audit.findMany({
      action: TENANT_LIFECYCLE_AUDIT_ACTIONS,
      limit: input?.limit ?? 100,
    })
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load platform audit trail')
  }
}

const grantPlatformRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['superadmin', 'platform_operator', 'platform_auditor']),
})

export async function grantPlatformRole(input: z.infer<typeof grantPlatformRoleSchema>) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = grantPlatformRoleSchema.parse(input)
    const membership = await services.tenants.grantPlatformRole({
      userId: parsed.userId,
      role: parsed.role,
      actorId: ctx.user.id,
    })
    revalidatePath('/control-plane/platform/iam')
    return ok(membership)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to grant platform role')
  }
}

export async function revokePlatformRole(input: z.infer<typeof grantPlatformRoleSchema>) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = grantPlatformRoleSchema.parse(input)
    // Önkizárás elleni védelem: a superadmin ne vonja meg saját utolsó superadmin jogát.
    if (parsed.userId === ctx.user.id && parsed.role === 'superadmin') {
      const members = await services.tenants.listPlatformMembers()
      const otherSuperadmins = members.filter(
        (m) => m.role === 'superadmin' && m.status === 'active' && m.userId !== ctx.user.id,
      )
      if (otherSuperadmins.length === 0) {
        return fail('lockout: last active superadmin cannot be removed')
      }
    }
    await services.tenants.revokePlatformRole({
      userId: parsed.userId,
      role: parsed.role,
      actorId: ctx.user.id,
    })
    revalidatePath('/control-plane/platform/iam')
    return ok({ revoked: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke platform role')
  }
}

// ── Tenant membership — tenant-admin (§8.1) ─────────────────────────────────

export async function listTenantMembers() {
  try {
    const ctx = await requireTenantRole('admin')
    const members = await services.tenants.listMembers(ctx.activeTenantId)
    return ok(members)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list members')
  }
}

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'approver', 'operator', 'viewer']),
})

export async function addTenantMember(input: z.infer<typeof addMemberSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = addMemberSchema.parse(input)
    const membership = await services.tenants.addMember({
      tenantId: ctx.activeTenantId,
      userId: parsed.userId,
      role: parsed.role,
      status: 'active',
      actorId: ctx.user.id,
    })
    revalidatePath('/control-plane/iam')
    return ok(membership)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to add member')
  }
}

const changeMemberRoleSchema = z.object({
  targetUserId: z.string().uuid(),
  newRole: z.enum(['admin', 'approver', 'operator', 'viewer']),
})

export async function changeTenantMemberRole(input: z.infer<typeof changeMemberRoleSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = changeMemberRoleSchema.parse(input)
    const membership = await services.tenants.changeMemberRole({
      tenantId: ctx.activeTenantId,
      targetUserId: parsed.targetUserId,
      newRole: parsed.newRole,
      actorId: ctx.user.id,
    })
    revalidatePath('/control-plane/iam')
    return ok(membership)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to change member role')
  }
}

export async function suspendTenantMember(input: { targetUserId: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const { targetUserId } = z.object({ targetUserId: z.string().uuid() }).parse(input)
    const membership = await services.tenants.suspendMember({
      tenantId: ctx.activeTenantId,
      targetUserId,
      actorId: ctx.user.id,
    })
    revalidatePath('/control-plane/iam')
    return ok(membership)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend member')
  }
}
