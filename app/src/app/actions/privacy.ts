'use server'

import { z } from 'zod'
import { getAuthContext } from '@/auth/context'
import {
  PlatformAuthError,
  TenantAuthError,
  requirePlatformRole,
  requireTenantRole,
} from '@/auth/tenant-context'
import { hasMinimumRole } from '@/auth/types'
import { services } from '@/domain'
import { connectorHasPrivacyMetadata } from '@/domain/privacy/connector-privacy'
import { privacyConnectorEmptyState } from '@/domain/privacy/privacy-admin-copy'
import {
  PrivacyCategoryPolicyError,
  buildPrivacyPolicyEditorRows,
  type PrivacyCategoryPolicyPatch,
  type PrivacyEditorLayer,
} from '@/domain/privacy/privacy-category-policy'
import { runPrivacyDryRun } from '@/domain/privacy/privacy-dry-run'
import { prisma } from '@/lib/db'
import { fail, ok, type ActionResult } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'
import {
  dryRunPrivacyTextSchema,
  getPrivacyAdminViewSchema,
  setPrivacyCategoryPolicySchema,
  setPrivacyGatewayModeSchema,
} from '@/lib/validators/actions'
import { repositories } from '@/repositories/postgres'

export type PrivacyAdminView = {
  layer: PrivacyEditorLayer
  canEditPlatform: boolean
  canEditTenant: boolean
  canEditAgent: boolean
  isSuperadmin: boolean
  agentId: string | null
  tenantId: string | null
  platformMode: 'off' | 'observe' | 'enforce'
  tenantMode: 'off' | 'observe' | 'enforce' | null
  agentMode: 'off' | 'observe' | 'enforce' | null
  resolvedMode: 'off' | 'observe' | 'enforce'
  platformPolicy: Awaited<ReturnType<typeof services.platformSettings.getPrivacyCategoryPolicy>>
  tenantPolicy: Awaited<ReturnType<typeof services.platformSettings.getTenantPrivacyCategoryPolicy>>
  agentPolicy: Awaited<ReturnType<typeof services.platformSettings.getAgentPrivacyCategoryPolicy>>
  resolvedPolicy: Awaited<ReturnType<typeof services.platformSettings.resolvePrivacyCategoryPolicy>>
  rows: ReturnType<typeof buildPrivacyPolicyEditorRows>
  emptyState: ReturnType<typeof privacyConnectorEmptyState>
  legacyAllowSensitiveExternalModel: boolean
}

function privacyFail(e: unknown, fallback: string): ActionResult<never> {
  if (e instanceof PrivacyCategoryPolicyError) {
    if (e.code === 'secret_key_not_block') {
      return fail(
        'A jelszót, kulcsot vagy belépési tokent nem lehet álnévre cserélni vagy kiengedni — mindig tiltva marad.',
      )
    }
    if (e.code === 'allow_requires_superadmin') {
      return fail('Bankkártyaszám vagy IBAN külső modellnek küldését csak platform-admin engedélyezheti.')
    }
    if (e.code === 'allow_confirmation_required') {
      return fail('Bankkártyaszám vagy IBAN külső modellnek küldéséhez írd be: ALLOW_PAN_IBAN')
    }
    if (e.code === 'invalid_action') return fail('Ez a művelet ennél a kategóriánál nem választható.')
    if (e.code === 'invalid_category') return fail('Ismeretlen vagy érvénytelen kategória.')
    return fail(e.message)
  }
  if (e instanceof TenantAuthError || e instanceof PlatformAuthError) {
    return fail('Ehhez a beállításhoz nincs jogosultságod.')
  }
  if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? fallback)
  return fail(e instanceof Error ? e.message : fallback)
}

async function listPrivacyConnectors(tenantId: string | null) {
  const rows = await prisma.connector.findMany({
    where: {
      lifecycleState: 'active',
      ...(tenantId ? { OR: [{ tenantId: null }, { tenantId }] } : { tenantId: null }),
    },
    select: { id: true, name: true, config: true },
    orderBy: { name: 'asc' },
    take: 200,
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hasPrivacyMetadata: connectorHasPrivacyMetadata(row.config),
  }))
}

async function loadPrivacyAdminView(input: {
  layer: PrivacyEditorLayer
  tenantId: string | null
  agentId: string | null
  canEditPlatform: boolean
  canEditTenant: boolean
  canEditAgent: boolean
  superadmin: boolean
}): Promise<PrivacyAdminView> {
  const settings = services.platformSettings
  let legacyAllowSensitiveExternalModel = false
  if (input.agentId) {
    const agent = await repositories.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Az AI-munkatárs nem található.')
    legacyAllowSensitiveExternalModel = agent.allowSensitiveExternalModel
  }

  const [platformPolicy, tenantPolicy, agentPolicy, platformMode, tenantMode, agentMode, connectors] =
    await Promise.all([
      settings.getPrivacyCategoryPolicy(),
      input.tenantId
        ? settings.getTenantPrivacyCategoryPolicy(input.tenantId)
        : Promise.resolve({ categories: {}, custom: {}, updatedById: null, updatedAt: null }),
      input.agentId
        ? settings.getAgentPrivacyCategoryPolicy(input.agentId)
        : Promise.resolve({ categories: {}, custom: {}, updatedById: null, updatedAt: null }),
      settings.getPrivacyGatewayControls(),
      input.tenantId
        ? settings.getTenantPrivacyGatewayControls(input.tenantId)
        : Promise.resolve({ mode: null, updatedById: null, updatedAt: null }),
      input.agentId
        ? settings.getAgentPrivacyGatewayControls(input.agentId)
        : Promise.resolve({ mode: null, updatedById: null, updatedAt: null }),
      listPrivacyConnectors(input.tenantId),
    ])

  const resolvedPolicy = await settings.resolvePrivacyCategoryPolicy({
    tenantId: input.tenantId,
    agentId: input.agentId,
    legacyAllowSensitiveExternalModel,
  })
  const resolvedMode = await settings.resolvePrivacyGatewayMode({
    tenantId: input.tenantId,
    agentId: input.agentId,
  })

  return {
    layer: input.layer,
    canEditPlatform: input.canEditPlatform,
    canEditTenant: input.canEditTenant,
    canEditAgent: input.canEditAgent,
    isSuperadmin: input.superadmin,
    agentId: input.agentId,
    tenantId: input.tenantId,
    platformMode: platformMode.mode,
    tenantMode: tenantMode.mode,
    agentMode: agentMode.mode,
    resolvedMode,
    platformPolicy,
    tenantPolicy,
    agentPolicy,
    resolvedPolicy,
    rows: buildPrivacyPolicyEditorRows({
      platform: platformPolicy,
      tenant: tenantPolicy,
      agent: agentPolicy,
      legacyAllowSensitiveExternalModel,
      editingLayer: input.layer,
    }),
    emptyState: privacyConnectorEmptyState(connectors),
    legacyAllowSensitiveExternalModel,
  }
}

async function resolveEditorAccess(input: { agentId?: string; layer?: PrivacyEditorLayer }) {
  const ctx = await getAuthContext()
  if (!ctx) throw new TenantAuthError('NO_USER')
  const superadmin = isSuperadmin(ctx.platformRoles)
  const tenantId = ctx.activeTenantId
  const tenantAdmin =
    Boolean(tenantId && ctx.activeTenantRole && hasMinimumRole(ctx.activeTenantRole, 'admin')) ||
    superadmin
  const layer: PrivacyEditorLayer =
    input.layer ?? (input.agentId ? 'agent' : superadmin ? 'platform' : 'tenant')

  if (layer === 'platform' && !superadmin && input.layer === 'platform') {
    // olvasás OK; írás külön guard
  }
  if ((layer === 'tenant' || layer === 'agent' || input.agentId) && !tenantId && !superadmin) {
    throw new TenantAuthError('NO_TENANT')
  }
  if (input.agentId && tenantId) {
    const agent = await repositories.agents.findById(input.agentId, tenantId)
    if (!agent) throw new Error('Az AI-munkatárs nem található.')
  }

  return {
    ctx,
    superadmin,
    tenantId,
    tenantAdmin,
    layer,
    canEditPlatform: superadmin,
    canEditTenant: tenantAdmin,
    canEditAgent: tenantAdmin,
  }
}

export async function getPrivacyAdminView(input: {
  agentId?: string
  layer?: PrivacyEditorLayer
} = {}) {
  try {
    const parsed = getPrivacyAdminViewSchema.parse(input)
    const access = await resolveEditorAccess(parsed)
    const view = await loadPrivacyAdminView({
      layer: access.layer,
      tenantId: access.tenantId,
      agentId: parsed.agentId ?? null,
      canEditPlatform: access.canEditPlatform,
      canEditTenant: access.canEditTenant,
      canEditAgent: access.canEditAgent,
      superadmin: access.superadmin,
    })
    return ok(view)
  } catch (e) {
    return privacyFail(e, 'Nem sikerült betölteni az adatvédelmi beállításokat.')
  }
}

export async function setPrivacyCategoryPolicyAction(input: unknown) {
  try {
    const parsed = setPrivacyCategoryPolicySchema.parse(input)
    const access = await resolveEditorAccess(parsed)
    if (parsed.layer === 'platform') {
      await requirePlatformRole('superadmin')
    } else {
      await requireTenantRole('admin')
    }
    if (parsed.layer === 'agent' && !parsed.agentId) {
      return fail('Az AI-munkatárs azonosítója hiányzik.')
    }

    const actor = {
      actorId: access.ctx.user.id,
      isSuperadmin: access.superadmin,
      confirmation: parsed.confirmation,
    }
    const patch: PrivacyCategoryPolicyPatch = {
      categories: parsed.categories as PrivacyCategoryPolicyPatch['categories'],
      custom: parsed.custom as PrivacyCategoryPolicyPatch['custom'],
    }

    if (parsed.layer === 'platform') {
      await services.platformSettings.setPrivacyCategoryPolicy(patch, actor)
    } else if (parsed.layer === 'tenant') {
      if (!access.tenantId) return fail('Nincs aktív szervezet.')
      await services.platformSettings.setTenantPrivacyCategoryPolicy(access.tenantId, patch, actor)
    } else {
      await services.platformSettings.setAgentPrivacyCategoryPolicy(parsed.agentId!, patch, actor)
    }

    const view = await loadPrivacyAdminView({
      layer: parsed.layer,
      tenantId: access.tenantId,
      agentId: parsed.agentId ?? null,
      canEditPlatform: access.canEditPlatform,
      canEditTenant: access.canEditTenant,
      canEditAgent: access.canEditAgent,
      superadmin: access.superadmin,
    })
    return ok(view)
  } catch (e) {
    return privacyFail(e, 'Nem sikerült menteni a kategória-szabályt.')
  }
}

export async function setPrivacyGatewayModeAction(input: unknown) {
  try {
    const parsed = setPrivacyGatewayModeSchema.parse(input)
    const access = await resolveEditorAccess(parsed)
    if (parsed.layer === 'platform') {
      await requirePlatformRole('superadmin')
      if (parsed.mode == null) return fail('A platform üzemmódja nem lehet üres.')
      await services.platformSettings.setPrivacyGatewayControls(
        { mode: parsed.mode },
        access.ctx.user.id,
      )
    } else {
      await requireTenantRole('admin')
      if (parsed.layer === 'tenant') {
        if (!access.tenantId) return fail('Nincs aktív szervezet.')
        await services.platformSettings.setTenantPrivacyGatewayControls(
          access.tenantId,
          { mode: parsed.mode },
          access.ctx.user.id,
        )
      } else {
        if (!parsed.agentId) return fail('Az AI-munkatárs azonosítója hiányzik.')
        await services.platformSettings.setAgentPrivacyGatewayControls(
          parsed.agentId,
          { mode: parsed.mode },
          access.ctx.user.id,
        )
      }
    }

    const view = await loadPrivacyAdminView({
      layer: parsed.layer,
      tenantId: access.tenantId,
      agentId: parsed.agentId ?? null,
      canEditPlatform: access.canEditPlatform,
      canEditTenant: access.canEditTenant,
      canEditAgent: access.canEditAgent,
      superadmin: access.superadmin,
    })
    return ok(view)
  } catch (e) {
    return privacyFail(e, 'Nem sikerült menteni az üzemmódot.')
  }
}

export async function dryRunPrivacyText(input: unknown) {
  try {
    const parsed = dryRunPrivacyTextSchema.parse(input)
    const access = await resolveEditorAccess({ agentId: parsed.agentId })
    const settings = services.platformSettings
    let legacyAllowSensitiveExternalModel = false
    if (parsed.agentId) {
      const agent = await repositories.agents.findById(parsed.agentId, access.tenantId)
      if (!agent) return fail('Az AI-munkatárs nem található.')
      legacyAllowSensitiveExternalModel = agent.allowSensitiveExternalModel
    }
    const [policy, mode] = await Promise.all([
      settings.resolvePrivacyCategoryPolicy({
        tenantId: access.tenantId,
        agentId: parsed.agentId,
        legacyAllowSensitiveExternalModel,
      }),
      settings.resolvePrivacyGatewayMode({
        tenantId: access.tenantId,
        agentId: parsed.agentId,
      }),
    ])
    return ok(runPrivacyDryRun({ text: parsed.text, policy, mode }))
  } catch (e) {
    return privacyFail(e, 'A próba nem futott le.')
  }
}
