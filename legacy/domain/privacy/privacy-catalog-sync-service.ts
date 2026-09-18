/**
 * Privacy-katalógus szinkron futtatása egy connectorra / egy tenantra (issue #320).
 *
 * A tiszta motor a `privacy-catalog-sync.ts`; itt jön hozzá a DB és az audit.
 * A szinkron a connector `config`-ját írja: a mezőjelölés a forrásé, a platform
 * csak tükrözi. Fail-closed: ha a katalógus érvénytelen vagy elérhetetlen, a
 * korábbi jelölés marad, és `privacy.catalog.sync.failed` audit keletkezik.
 */
import type { Prisma } from '@prisma/client'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import {
  syncConnectorPrivacyCatalog,
  type PrivacyCatalogFetcher,
  type PrivacyCatalogSyncOutcome,
} from '@/domain/privacy/privacy-catalog-sync'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import type { AuditRepository } from '@/repositories/interfaces'

export type PrivacyCatalogSyncActor = {
  /** `null` az ütemezett (rendszer) futásnál. */
  id: string | null
  type?: 'human' | 'system'
}

export type ConnectorPrivacyCatalogSyncRow = {
  id: string
  name: string
  type: string
  tenantId: string | null
  secretAlias: string | null
  config: unknown
}

export type ConnectorPrivacyCatalogSyncResult = {
  connectorId: string
  connectorName: string
  outcome: PrivacyCatalogSyncOutcome
}

export type PrivacyCatalogSyncDeps = {
  audit?: AuditRepository | null
  fetchCatalog?: PrivacyCatalogFetcher
  resolveApiKey?: (secretAlias: string) => Promise<string>
  persist?: (connectorId: string, config: Record<string, unknown>) => Promise<void>
}

async function persistConfig(connectorId: string, config: Record<string, unknown>): Promise<void> {
  await prisma.connector.update({
    where: { id: connectorId },
    data: { config: config as Prisma.InputJsonValue },
  })
}

/** Egy connector szinkronja: letöltés → validálás → mentés → audit. */
export async function syncPrivacyCatalogForConnectorRow(
  connector: ConnectorPrivacyCatalogSyncRow,
  actor: PrivacyCatalogSyncActor,
  deps: PrivacyCatalogSyncDeps = {},
): Promise<PrivacyCatalogSyncOutcome> {
  const resolveApiKey = deps.resolveApiKey ?? resolveConnectorApiKey
  let apiKey: string | undefined
  if (connector.secretAlias) {
    try {
      apiKey = await resolveApiKey(connector.secretAlias)
    } catch {
      // Titok nélkül is megpróbáljuk: a katalógus lehet nyilvános végpont is.
      apiKey = undefined
    }
  }

  const outcome = await syncConnectorPrivacyCatalog({
    connector: { type: connector.type, config: connector.config, secretAlias: connector.secretAlias },
    apiKey,
    resolveApiKey,
    fetchCatalog: deps.fetchCatalog,
  })

  if (outcome.status === 'applied') {
    await (deps.persist ?? persistConfig)(connector.id, outcome.config)
  }
  await recordSyncAudit(connector, actor, outcome, deps.audit)
  return outcome
}

async function recordSyncAudit(
  connector: ConnectorPrivacyCatalogSyncRow,
  actor: PrivacyCatalogSyncActor,
  outcome: PrivacyCatalogSyncOutcome,
  auditOverride?: AuditRepository | null,
): Promise<void> {
  if (auditOverride === null) return
  const audit = auditOverride ?? repositories.audit
  // A `no_change` nem kerül auditba: napi ütemezésnél ez csak zajt termelne.
  if (outcome.status === 'no_change') return
  try {
    await audit.append({
      action:
        outcome.status === 'applied' ? 'privacy.catalog.sync.applied' : 'privacy.catalog.sync.failed',
      actorType: actor.type === 'human' ? 'human' : 'system',
      actorId: actor.id,
      agentVersion: null,
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: `connector:${connector.id}`,
      outputRef: outcome.status === 'applied' ? `catalog_version:${outcome.catalogVersion}` : null,
      policyDecision: outcome.status === 'applied' ? 'catalog_applied' : 'catalog_rejected',
      metadata:
        outcome.status === 'applied'
          ? {
              catalog_version: outcome.catalogVersion,
              changes: outcome.changes,
              ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
            }
          : { reason: outcome.reason, detail: outcome.detail },
      tenantId: connector.tenantId,
    })
  } catch {
    // Az audit hibája ne bukassa el a szinkront — a kimenetet a hívó így is látja.
  }
}

export async function syncPrivacyCatalogForConnector(
  connectorId: string,
  actor: PrivacyCatalogSyncActor,
  deps: PrivacyCatalogSyncDeps = {},
): Promise<PrivacyCatalogSyncOutcome> {
  const connector = await prisma.connector.findUnique({
    where: { id: connectorId },
    select: { id: true, name: true, type: true, tenantId: true, secretAlias: true, config: true },
  })
  if (!connector) {
    return { status: 'failed', reason: 'not_http_api', detail: 'ismeretlen kapcsolat' }
  }
  return syncPrivacyCatalogForConnectorRow(connector as ConnectorPrivacyCatalogSyncRow, actor, deps)
}

/**
 * Ütemezett futás: minden aktív `http_api` kapcsolat. A katalógust nem publikáló
 * forrásokat NEM tekintjük hibának — a `http_error` / `unreachable` kimenet a
 * riportban látszik, de a jelölés érintetlen marad.
 */
export async function syncPrivacyCatalogsForActiveConnectors(
  actor: PrivacyCatalogSyncActor,
  deps: PrivacyCatalogSyncDeps & { tenantId?: string | null } = {},
): Promise<ConnectorPrivacyCatalogSyncResult[]> {
  const connectors = await prisma.connector.findMany({
    where: {
      type: 'http_api',
      lifecycleState: 'active',
      ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
    },
    select: { id: true, name: true, type: true, tenantId: true, secretAlias: true, config: true },
    orderBy: { createdAt: 'asc' },
  })

  const results: ConnectorPrivacyCatalogSyncResult[] = []
  for (const connector of connectors) {
    const outcome = await syncPrivacyCatalogForConnectorRow(
      connector as ConnectorPrivacyCatalogSyncRow,
      actor,
      deps,
    )
    results.push({ connectorId: connector.id, connectorName: connector.name, outcome })
  }
  return results
}
