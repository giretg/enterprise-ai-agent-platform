/**
 * APG-17 runtime segéd — agent connector-kötésből entity resolution kontextus.
 */
import { effectiveConnectorRuntimeConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { connectorSupportsEntityResolution } from '@/domain/privacy/connector-privacy'
import { createHttpConnectorEntityResolver } from '@/domain/privacy/http-connector-entity-resolver'
import type { ConnectorEntityResolver } from '@/domain/privacy/entity-resolve-contract'
import type { UserInputEntityResolution } from '@/domain/privacy/user-input-resolver'
import { prisma } from '@/lib/db'

export type AgentConnectorBinding = {
  connector: {
    id: string
    type: string
    config: unknown
    secretAlias: string | null
  }
  agentSecretAlias: string | null
}

export function pickEntityResolutionBinding(
  bindings: AgentConnectorBinding[],
): AgentConnectorBinding | null {
  for (const binding of bindings) {
    const config = effectiveConnectorRuntimeConfig(binding.connector.config)
    if (connectorSupportsEntityResolution(config) && binding.connector.type === 'http_api') {
      return binding
    }
  }
  return null
}

export async function createConnectorEntityResolver(input: {
  binding: AgentConnectorBinding
  actingUserId?: string | null
  agentId: string
}): Promise<ConnectorEntityResolver | null> {
  if (input.binding.connector.type !== 'http_api') return null
  const config = effectiveConnectorRuntimeConfig(input.binding.connector.config)
  if (!connectorSupportsEntityResolution(config)) return null

  const effectiveAlias = input.binding.agentSecretAlias ?? input.binding.connector.secretAlias
  let defaultApiKey: string | undefined
  if (effectiveAlias) {
    try {
      defaultApiKey = await resolveConnectorApiKey(effectiveAlias)
    } catch {
      return null
    }
  }

  const actingUser = input.actingUserId
    ? await prisma.user.findUnique({
        where: { id: input.actingUserId },
        select: { email: true },
      })
    : null

  return createHttpConnectorEntityResolver({
    config,
    defaultApiKey,
    resolveApiKey: (secretAlias) => resolveConnectorApiKey(secretAlias),
    actingUserEmail: actingUser?.email ?? null,
    agentId: input.agentId,
  })
}

export async function buildUserInputEntityResolution(input: {
  bindings: AgentConnectorBinding[]
  agentId: string
  actingUserId?: string | null
}): Promise<UserInputEntityResolution | null> {
  const binding = pickEntityResolutionBinding(input.bindings)
  if (!binding) return null
  const resolver = await createConnectorEntityResolver({
    binding,
    actingUserId: input.actingUserId,
    agentId: input.agentId,
  })
  if (!resolver) return null
  return {
    connectorId: binding.connector.id,
    resolver,
    entityTypeHint: 'company',
  }
}
