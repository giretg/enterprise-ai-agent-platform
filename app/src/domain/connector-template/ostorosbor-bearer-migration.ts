import type { ConnectorConfig } from '@/domain/provisioning/connector-config'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from './custom-template-seeds'
import { materializeConnectorConfig } from './materializer'
import { parseTemplateDescriptor } from './template-descriptor'

const OSTOROSBOR_TEMPLATE_KEYS = new Set([
  'ostorosbor-crm-sales-delegated',
  'ostorosbor-crm-service-insight',
])

type MigrationConnector = {
  id?: string
  type: string
  lifecycleState: string
  secretAlias?: string | null
  config: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function templateKeyOf(config: Record<string, unknown>): string | null {
  const provenance = isRecord(config.provenance) ? config.provenance : null
  const provenanceKey = provenance?.templateKey
  if (typeof provenanceKey === 'string' && OSTOROSBOR_TEMPLATE_KEYS.has(provenanceKey)) {
    return provenanceKey
  }
  return typeof config.provider === 'string' && OSTOROSBOR_TEMPLATE_KEYS.has(config.provider)
    ? config.provider
    : null
}

function hasLegacyAuthorizationAuth(config: Record<string, unknown>): boolean {
  const auth = isRecord(config.auth) ? config.auth : null
  if (!auth) return false
  return (
    (auth.type === 'api_key_header' &&
      String(auth.headerName ?? '').toLowerCase() === 'authorization') ||
    (auth.scheme === 'header' && String(auth.header ?? '').toLowerCase() === 'authorization')
  )
}

export function isOstorosborBearerMigrationCandidate(connector: MigrationConnector): boolean {
  if (connector.type !== 'http_api' || connector.lifecycleState !== 'active') return false
  if (!isRecord(connector.config)) return false
  return Boolean(templateKeyOf(connector.config)) && hasLegacyAuthorizationAuth(connector.config)
}

function selectedEndpointNames(config: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(config.proposedTools)) return undefined
  const names = config.proposedTools
    .filter(isRecord)
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  return names.length > 0 ? [...new Set(names)] : undefined
}

export function rematerializeOstorosborConnectorConfig(
  connector: MigrationConnector & { id: string },
): ConnectorConfig {
  if (!isOstorosborBearerMigrationCandidate(connector) || !isRecord(connector.config)) {
    throw new Error(`connector is not an active Ostorosbor bearer-migration candidate: ${connector.id}`)
  }

  const templateKey = templateKeyOf(connector.config)!
  const rawDescriptor = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find(
    (descriptor) => descriptor.key === templateKey,
  )
  if (!rawDescriptor) throw new Error(`Ostorosbor template not found: ${templateKey}`)
  const descriptor = parseTemplateDescriptor(rawDescriptor)

  const baseUrl = connector.config.baseUrl
  if (typeof baseUrl !== 'string') throw new Error(`connector has no baseUrl: ${connector.id}`)
  const crmHost = new URL(baseUrl).host
  const auth = isRecord(connector.config.auth) ? connector.config.auth : {}
  const suggestedAlias = auth.secretAliasSuggested
  const apiKeyAlias =
    connector.secretAlias ??
    (typeof suggestedAlias === 'string' ? suggestedAlias : null) ??
    `secret-ref:connector/${connector.id}`
  const provenance = isRecord(connector.config.provenance) ? connector.config.provenance : {}
  const actingUserEmail =
    typeof connector.config.defaultActingUserEmail === 'string' &&
    connector.config.defaultActingUserEmail.trim()
      ? connector.config.defaultActingUserEmail.trim()
      : 'unknown@configure-in-provisioning.local'

  return materializeConnectorConfig(
    descriptor,
    {
      authMethodKind: 'bearer',
      instanceValues: { crmHost, actingUserEmail },
      selectedEndpoints: selectedEndpointNames(connector.config),
    },
    { apiKey: apiKeyAlias },
    {
      templateId: typeof provenance.templateId === 'string' ? provenance.templateId : undefined,
      templateKey,
      templateVersion:
        typeof provenance.templateVersion === 'number' ? provenance.templateVersion : 1,
      templateOrigin: provenance.templateOrigin === 'builtin' ? 'builtin' : 'custom',
      materializedAt: new Date().toISOString(),
    },
  )
}

export async function applyMigrationWithSecretCompensation(input: {
  originalSecret?: string
  strippedSecret?: string
  saveSecret: (value: string) => Promise<void>
  updateConfig: () => Promise<void>
}): Promise<void> {
  const shouldRotateSecret =
    input.originalSecret !== undefined && input.strippedSecret !== undefined
  if (shouldRotateSecret) await input.saveSecret(input.strippedSecret!)
  try {
    await input.updateConfig()
  } catch (updateError) {
    if (shouldRotateSecret) {
      try {
        await input.saveSecret(input.originalSecret!)
      } catch (rollbackError) {
        throw new AggregateError(
          [updateError, rollbackError],
          'connector config update and secret compensation both failed',
        )
      }
    }
    throw updateError
  }
}
