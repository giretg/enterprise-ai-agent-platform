'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { parseCapabilitySet } from '@/domain/connector-self-update/capability-set'
import { SelfUpdateError } from '@/domain/connector-self-update/self-update-service'
import {
  buildConnectorSecretRef,
  deleteConnectorApiKey,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'
import { appendAuditInTransaction } from '@/repositories/postgres/audit-repository'
import {
  tenantSelfUpdateAutoApproveEnabled,
  withTenantSelfUpdateAutoApprove,
} from '@/domain/connector-self-update/tenant-settings'

const connectorIdSchema = z.object({ connectorId: z.string().uuid() })
const versionSchema = connectorIdSchema.extend({ versionId: z.string().uuid() })
const apiKeyField = z.string().trim().min(1).max(10_000)
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Opcionális: kulcs nélküli, publikus OpenAPI-nál üresen hagyható.
  apiKey: z.string().trim().max(10_000).optional(),
  specUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Csak https link használható.'),
})
const rotateApiKeySchema = connectorIdSchema.extend({ apiKey: apiKeyField })

function actionError(error: unknown, fallback: string) {
  if (error instanceof SelfUpdateError) return fail(error.message)
  if (error instanceof z.ZodError) return fail(error.issues[0]?.message ?? fallback)
  return fail(error instanceof Error ? error.message : fallback)
}

function actor(ctx: Awaited<ReturnType<typeof requireTenantRole>>) {
  return {
    id: ctx.user.id,
    tenantId: ctx.activeTenantId,
    // T2 SoD: sima admin/approver nem hagyhatja jóvá a saját linkjét; superadmin igen.
    sodExempt: isSuperadmin(ctx.platformRoles),
  }
}

/** UI-nak: a capability-set funkciólistája (jogosultság + végpont), titok nélkül. */
function capabilitiesFromSet(value: unknown) {
  const set = parseCapabilitySet(value)
  if (!set) return []
  return (set.proposedTools ?? []).map((tool) => ({
    name: tool.name,
    method: tool.method,
    path: tool.path,
    access: tool.access,
    description: tool.description ?? null,
  }))
}

function privacyFromSet(value: unknown) {
  const set = parseCapabilitySet(value)
  return set?.privacy ?? null
}

export async function listSelfUpdatingConnectors() {
  try {
    const ctx = await requireTenantRole('operator')
    const connectors = await prisma.connector.findMany({
      where: { tenantId: ctx.activeTenantId, connectorMode: 'self_updating' },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    const details = await Promise.all(
      connectors.map(({ id }) => services.selfUpdatingConnectors.detail(id, actor(ctx))),
    )
    const approverIds = [...new Set(details.flatMap(({ versions }) => versions.map((version) => version.approvedById).filter((id): id is string => Boolean(id))))]
    const approvers = approverIds.length
      ? await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })
      : []
    const approverNames = new Map(approvers.map((user) => [user.id, user.name]))
    const tenant = await prisma.tenant.findUnique({ where: { id: ctx.activeTenantId }, select: { settings: true } })
    return ok({
      tenantAutoApproveEnabled: tenantSelfUpdateAutoApproveEnabled(tenant?.settings),
      connectors: details.map(({ context, versions }) => ({
        id: context.connector.id,
        name: context.connector.name,
        specUrl: context.source.specUrl,
        urlApproved: Boolean(context.source.urlApprovedAt),
        trusted: Boolean(context.source.trustedAt),
        autoApproveEnabled: context.source.autoApprovePolicy?.enabled === true,
        lastSyncedAt: context.source.lastSyncedAt?.toISOString() ?? null,
        activeSpecVersionId: context.connector.activeSpecVersionId,
        privacy: privacyFromSet(
          versions.find((version) => version.id === context.connector.activeSpecVersionId)?.capabilitySet
            ?? versions.find((version) => version.status === 'proposed')?.capabilitySet,
        ),
        versions: versions.map((version) => {
          const includeCapabilities =
            version.id === context.connector.activeSpecVersionId || version.status === 'proposed'
          return {
            id: version.id,
            versionNo: version.versionNo,
            status: version.status,
            diffSummary: version.diffSummary,
            capabilities: includeCapabilities ? capabilitiesFromSet(version.capabilitySet) : [],
            privacy: includeCapabilities ? privacyFromSet(version.capabilitySet) : null,
            fetchedAt: version.fetchedAt.toISOString(),
            approvedAt: version.approvedAt?.toISOString() ?? null,
            approvedByName: version.approvedById ? approverNames.get(version.approvedById) ?? 'Ismeretlen kolléga' : 'Automatikus szabály',
          }
        }),
      })),
    })
  } catch (error) {
    return actionError(error, 'Nem sikerült betölteni az OpenAPI-kapcsolatokat.')
  }
}

export async function createSelfUpdatingConnector(input: unknown) {
  let connectorId: string | null = null
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = createSchema.parse(input)
    connectorId = randomUUID()
    const apiKey = parsed.apiKey?.trim() ? parsed.apiKey.trim() : null
    if (apiKey) await saveConnectorApiKey(connectorId, apiKey)
    const created = await services.selfUpdatingConnectors.create(
      {
        connectorId,
        name: parsed.name,
        specUrl: parsed.specUrl,
        secretAlias: apiKey ? buildConnectorSecretRef(connectorId) : null,
      },
      actor(ctx),
    )
    return ok({ connectorId: created.connector.id })
  } catch (error) {
    if (connectorId) await deleteConnectorApiKey(connectorId).catch(() => {})
    return actionError(error, 'Nem sikerült létrehozni az OpenAPI-kapcsolatot.')
  }
}

export async function approveSelfUpdatingSource(input: unknown) {
  try {
    const ctx = await requireTenantRole('approver')
    const { connectorId } = connectorIdSchema.parse(input)
    await services.selfUpdatingConnectors.approveUrl(connectorId, actor(ctx))
    return ok({ connectorId })
  } catch (error) { return actionError(error, 'Nem sikerült jóváhagyni a linket.') }
}

export async function trustSelfUpdatingPartner(input: unknown) {
  try {
    const ctx = await requireTenantRole('approver')
    const { connectorId } = connectorIdSchema.parse(input)
    await services.selfUpdatingConnectors.markTrusted(connectorId, actor(ctx))
    return ok({ connectorId })
  } catch (error) { return actionError(error, 'Nem sikerült megbízhatónak minősíteni a partnert.') }
}

export async function syncSelfUpdatingConnector(input: unknown) {
  try {
    const ctx = await requireTenantRole('operator')
    const { connectorId } = connectorIdSchema.parse(input)
    const result = await services.selfUpdatingConnectors.sync(connectorId, actor(ctx))
    if (result.kind === 'proposed') return ok({ kind: result.kind, autoApproved: result.autoApproved, versionId: result.version.id })
    return ok(result)
  } catch (error) { return actionError(error, 'Nem sikerült frissítést keresni.') }
}

export async function approveSelfUpdatingVersion(input: unknown) {
  try {
    const ctx = await requireTenantRole('approver')
    const { connectorId, versionId } = versionSchema.parse(input)
    const version = await services.selfUpdatingConnectors.approveVersion(connectorId, versionId, actor(ctx))
    return ok({ versionId: version.id })
  } catch (error) { return actionError(error, 'Nem sikerült átvenni a változásokat.') }
}

export async function rejectSelfUpdatingVersion(input: unknown) {
  try {
    const ctx = await requireTenantRole('approver')
    const { connectorId, versionId } = versionSchema.parse(input)
    const version = await services.selfUpdatingConnectors.rejectVersion(connectorId, versionId, actor(ctx))
    return ok({ versionId: version.id })
  } catch (error) { return actionError(error, 'Nem sikerült elutasítani a változásokat.') }
}

export async function rollbackSelfUpdatingVersion(input: unknown) {
  try {
    const ctx = await requireTenantRole('approver')
    const { connectorId, versionId } = versionSchema.parse(input)
    const version = await services.selfUpdatingConnectors.rollback(connectorId, versionId, actor(ctx))
    return ok({ versionId: version.id })
  } catch (error) { return actionError(error, 'Nem sikerült visszaállítani a korábbi állapotot.') }
}

export async function setSelfUpdatingAutoApprove(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = connectorIdSchema.extend({ enabled: z.boolean() }).parse(input)
    await services.selfUpdatingConnectors.updatePolicy(parsed.connectorId, { enabled: parsed.enabled }, actor(ctx))
    return ok({ connectorId: parsed.connectorId, enabled: parsed.enabled })
  } catch (error) { return actionError(error, 'Nem sikerült módosítani az automatikus átvételt.') }
}

export async function setTenantSelfUpdatingAutoApprove(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const { enabled } = z.object({ enabled: z.boolean() }).parse(input)
    await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.activeTenantId }, select: { settings: true } })
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withTenantSelfUpdateAutoApprove(tenant?.settings, enabled) },
      })
      await appendAuditInTransaction(tx, {
        actorType: 'human', actorId: ctx.user.id, agentVersion: null,
        action: 'tenant.self_update.policy.update', targetType: 'tenant', targetId: ctx.activeTenantId,
        modelUsed: null, inputRef: null, outputRef: null, policyDecision: 'allowed',
        metadata: { enabled }, tenantId: ctx.activeTenantId,
      })
    }, { timeout: 60_000 })
    return ok({ enabled })
  } catch (error) { return actionError(error, 'Nem sikerült módosítani a tenant beállítását.') }
}

/**
 * A `secretAlias` FORMÁJA mehet az auditba, az ÉRTÉKE nem (egy `env:NÉV` alias a futó
 * szolgáltatás konfigurációjára mutat — l. connector-secret-alias-policy).
 */
function secretAliasKind(alias: string | null): 'none' | 'connector_owned' | 'env' | 'secret_manager' | 'other' {
  const value = alias?.trim()
  if (!value) return 'none'
  if (value.startsWith('secret-ref:')) return 'connector_owned'
  if (value.startsWith('env:')) return 'env'
  if (value.startsWith('secret-manager:')) return 'secret_manager'
  return 'other'
}

/** Meglévő önfrissítő kapcsolat hozzáférési kulcsának cseréje (ugyanaz a secret-ref, mint létrehozáskor). */
export async function updateSelfUpdatingConnectorApiKey(input: unknown) {
  let apiKeySaved = false
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = rotateApiKeySchema.parse(input)
    const connector = await prisma.connector.findFirst({
      where: {
        id: parsed.connectorId,
        tenantId: ctx.activeTenantId,
        connectorMode: 'self_updating',
        // Forgalomból kivont (archived/blocked) kapcsolat nem kaphat friss, élő kulcsot:
        // a Tool Broker sem oldja fel (tool-broker-authorizer `connector_not_active`).
        lifecycleState: 'active',
      },
      select: { id: true, secretAlias: true },
    })
    if (!connector) return fail('Az OpenAPI-kapcsolat nem található, vagy nincs aktív állapotban.')

    const secretAlias = buildConnectorSecretRef(connector.id)
    const aliasRepointed = connector.secretAlias !== secretAlias
    // Előbb a titok kerül a saját slotba, utána vált át rá az alias: így egy félbeszakadt
    // csere sosem hagy üres slotra mutató kapcsolatot.
    await saveConnectorApiKey(connector.id, parsed.apiKey)
    apiKeySaved = true

    await prisma.$transaction(async (tx) => {
      if (aliasRepointed) {
        await tx.connector.update({ where: { id: connector.id }, data: { secretAlias } })
      }
      await appendAuditInTransaction(tx, {
        actorType: 'human', actorId: ctx.user.id, agentVersion: null,
        action: 'connector.self_update.api_key.rotate', targetType: 'connector', targetId: connector.id,
        modelUsed: null, inputRef: null, outputRef: null, policyDecision: 'allowed',
        // A puszta „kulcs cserélve" nem elég: az aliast a saját slotra átkötő csere leválasztja
        // a kapcsolatot egy korábbi, tenantra engedélyezett külső titokról — ez külön nyom.
        metadata: {
          secret_alias_repointed: aliasRepointed,
          previous_secret_alias_kind: secretAliasKind(connector.secretAlias),
        },
        tenantId: ctx.activeTenantId,
      })
    }, { timeout: 60_000 })
    return ok({ connectorId: connector.id })
  } catch (error) {
    // A titok-tárolóba kiírt kulcs nem állítható vissza (a régit sosem olvassuk be). Ilyenkor
    // NEM mondhatjuk, hogy nem történt csere: az admin újrapróbálna, és téves nyomon indulna.
    if (apiKeySaved) {
      return fail('Az új kulcs elmentve, de a naplózás nem sikerült — a csere audit-nyom nélkül maradt. Kérjük, jelezd az üzemeltetésnek.')
    }
    return actionError(error, 'Nem sikerült frissíteni a hozzáférési kulcsot.')
  }
}
