/**
 * HTTP connector entity resolver (APG-17) — a forrásrendszer `POST /privacy/resolve` hívása.
 */
import {
  parseHttpApiConfig,
  HttpApiClient,
  type HttpApiConfig,
} from '@/domain/connector/http-api-client'
import { readEntityResolvePath } from '@/domain/privacy/connector-privacy'
import {
  parseEntityResolveResponse,
  type ConnectorEntityResolver,
  type EntityResolveRequest,
} from '@/domain/privacy/entity-resolve-contract'

export type HttpConnectorEntityResolverInput = {
  config: unknown
  resolveApiKey: (secretAlias: string) => Promise<string>
  defaultApiKey?: string
  actingUserEmail?: string | null
  agentId?: string | null
}

export function createHttpConnectorEntityResolver(
  input: HttpConnectorEntityResolverInput,
): ConnectorEntityResolver {
  const config = parseHttpApiConfig(input.config)
  const resolvePath = readEntityResolvePath(input.config)
  const client = new HttpApiClient(config, {
    defaultApiKey: input.defaultApiKey,
    resolveProfileApiKey: (_profile, secretAlias) => input.resolveApiKey(secretAlias),
  })

  return {
    async resolve(request: EntityResolveRequest) {
      const headers = buildResolveHeaders(config, input)
      const response = await client.request({
        method: 'POST',
        path: resolvePath,
        body: {
          text: request.text,
          ...(request.entityType ? { entity_type: request.entityType } : {}),
        },
        headers,
      })
      if (!response.ok) return { status: 'none' as const, candidates: [] }
      return parseEntityResolveResponse(response.body)
    },
  }
}

function buildResolveHeaders(
  config: HttpApiConfig,
  input: HttpConnectorEntityResolverInput,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const actingUser = input.actingUserEmail?.trim()
  if (actingUser) headers['X-Acting-User'] = actingUser
  if (input.agentId) headers['X-Agent-Id'] = input.agentId
  if (config.defaultActingUserEmail && !actingUser) {
    headers['X-Acting-User'] = config.defaultActingUserEmail
  }
  return headers
}
