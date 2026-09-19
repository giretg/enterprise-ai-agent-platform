import { randomUUID } from 'node:crypto'
import {
  findHttpApiEndpoint,
  HttpApiClient,
  HttpApiError,
  parseHttpApiConfig,
  resolveConnectorApiKey,
  type HttpApiConfig,
} from '@/domain/connector/http-api-client'
import {
  paginateHttpApiGet,
  resolveHttpApiPaginatePlan,
  type HttpApiPaginateQuery,
} from '@/domain/connector/http-api-paginate'
import { requiresHttpApiGetAll } from '@/lib/http-api-pagination-signals'
import type { LiveConnectorRow } from '../authorize-tool-call'
import {
  HTTP_API_GET_ALL_TOOL,
  HTTP_API_GET_TOOL,
  HTTP_API_REQUEST_TOOL,
  type EnterpriseHttpTool,
} from '../tool-definitions'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function scalarQuery(value: unknown): HttpApiPaginateQuery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const query: HttpApiPaginateQuery = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      query[key] = entry
    }
  }
  return Object.keys(query).length > 0 ? query : undefined
}

function parseBody(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new HttpApiError('body must be valid JSON', 'invalid_args')
  }
}

async function defaultApiKey(
  connector: LiveConnectorRow,
  delegatedAccessToken?: string,
): Promise<string | undefined> {
  if (delegatedAccessToken) return delegatedAccessToken
  if (connector.secretAlias) return resolveConnectorApiKey(connector.secretAlias)
  return undefined
}

function clientFor(config: HttpApiConfig, apiKey: string | undefined): HttpApiClient {
  return new HttpApiClient(config, {
    defaultApiKey: apiKey,
    resolveProfileApiKey: (_profile, secretAlias) => resolveConnectorApiKey(secretAlias),
  })
}

export async function executeHttpApiTool(
  toolName: EnterpriseHttpTool | string,
  args: Record<string, unknown>,
  connector: LiveConnectorRow,
  delegatedAccessToken?: string,
): Promise<unknown> {
  if (
    toolName !== HTTP_API_GET_TOOL &&
    toolName !== HTTP_API_GET_ALL_TOOL &&
    toolName !== HTTP_API_REQUEST_TOOL
  ) {
    throw new Error(`unsupported http_api tool: ${toolName}`)
  }

  const path = optionalString(args.path) ?? ''
  if (toolName === HTTP_API_GET_TOOL && requiresHttpApiGetAll(path)) {
    return {
      ok: false,
      status: 400,
      body: null,
      hint:
        `A(z) "${path}" teljes nyilvántartásnak tűnik. ` +
        'Ehhez kötelező a http_api_get_all; a sima http_api_get csak egy oldalt adhat vissza.',
    }
  }

  const config = parseHttpApiConfig(connector.config)
  const apiKey = await defaultApiKey(connector, delegatedAccessToken)
  const client = clientFor(config, apiKey)
  const callId = randomUUID()
  const agentId = optionalString(args.agentId) ?? ''
  const context = {
    agent: { id: agentId },
    connector: { id: connector.id, name: connector.name ?? connector.id },
    tenant: connector.tenantId ? { id: connector.tenantId } : null,
    defaultActingUserEmail: config.defaultActingUserEmail,
    call: {
      id: callId,
      idempotencyKey: optionalString(args.idempotencyKey) ?? callId,
    },
    now: { iso: new Date().toISOString() },
  }

  if (toolName === HTTP_API_GET_ALL_TOOL) {
    const endpoint = findHttpApiEndpoint(config, 'GET', path)
    const plan = resolveHttpApiPaginatePlan({
      pagination: endpoint?.pagination,
      pageSize: optionalNumber(args.pageSize),
      maxPages: optionalNumber(args.maxPages),
    })
    if (!plan) {
      return {
        ok: false,
        path,
        pageCount: 0,
        itemCount: 0,
        items: [],
        error:
          'A végponthoz nincs megbízható lapozási szerződés. ' +
          'Frissítsd a connector OpenAPI snapshotját, vagy add meg az endpoint.pagination konfigurációt.',
      }
    }
    const outcome = await paginateHttpApiGet({
      plan,
      path,
      baseUrl: config.baseUrl,
      baseQuery: scalarQuery(args.query),
      fetchPage: async (query, pagePath) => {
        const page = await client.request({
          method: 'GET',
          path: pagePath ?? path,
          continuationOf: plan.kind === 'next_link' ? path : undefined,
          query,
          context,
        })
        return {
          ok: page.ok,
          status: page.status,
          body: page.body,
          hint: page.hint,
          linkHeader: page.linkHeader,
        }
      },
    })
    if (!outcome.ok) {
      return {
        ok: false,
        path,
        pageCount: outcome.pageCount,
        itemCount: outcome.items.length,
        items: outcome.items,
        error: outcome.error,
      }
    }
    return {
      ok: true,
      path,
      pageCount: outcome.pageCount,
      itemCount: outcome.items.length,
      items: outcome.items,
      provenance: {
        sourceTool: HTTP_API_GET_ALL_TOOL,
        paginationComplete: outcome.paginationComplete,
        strategy: outcome.strategy,
        stopReason: outcome.stopReason,
      },
    }
  }

  if (toolName === HTTP_API_GET_TOOL) {
    return client.request({
      method: 'GET',
      path,
      query: scalarQuery(args.query),
      context,
    })
  }

  return client.request({
    method: optionalString(args.method) ?? 'POST',
    path,
    query: scalarQuery(args.query),
    body: parseBody(args.body),
    context,
  })
}
