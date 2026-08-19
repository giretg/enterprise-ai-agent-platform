import type { ToolHandler, ToolHandlerArgs } from './tool-handler'
import {
  paginateHttpApiGet,
  resolveHttpApiPaginatePlan,
  undocumentedPaginationQueryParams,
  type HttpApiPaginateQuery,
} from '@/domain/connector/http-api-paginate'
import { findHttpApiEndpoint, parseHttpApiConfig } from '@/domain/connector/http-api-client'
import { buildHttpApiLikelyPaginatedHint } from '@/domain/connector/http-api-prompt'
import { requiresHttpApiGetAll } from '@/lib/http-api-pagination-signals'

const HTTP_TOOLS = new Set(['http_api_get', 'http_api_get_all', 'http_api_request'])

/**
 * Generikus HTTP API connector (http_api_get / http_api_get_all / http_api_request).
 * user_delegated (auto-consent oauth2) módban a per-user grant access-tokenjét
 * injektáljuk Bearerként — SOHA nem a connector secretAlias-át (az a client_secret).
 * A tényleges hívás a keret `executeHttpApiTool` metódusában él.
 */
export const httpApiHandler: ToolHandler = {
  id: 'http_api',
  handles(tool) {
    return HTTP_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (
      input.tool !== 'http_api_get' &&
      input.tool !== 'http_api_get_all' &&
      input.tool !== 'http_api_request'
    ) {
      throw new Error(`http_api handler received ${input.tool}`)
    }
    if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
    const delegatedAccessToken =
      authorization.connector.authMode === 'user_delegated'
        ? await ctx.resolveDelegatedAccessToken(input, authorization)
        : undefined

    // Tulajdonosi/partneri nyilvántartásból egyetlen oldal nem kész adat:
    // ne csak hinteljünk, hanem még az első oldal lekérése előtt tereljük a
    // végiglapozó eszközre. Így nem jöhet létre félrevezető egyeztetési Excel.
    if (input.tool === 'http_api_get' && requiresHttpApiGetAll(input.args.path)) {
      return {
        ok: false,
        status: 400,
        body: null,
        hint:
          `A(z) "${input.args.path}" teljes nyilvántartásnak tűnik. ` +
          'Ehhez kötelező a http_api_get_all; a sima http_api_get csak egy oldalt adhat vissza.',
      }
    }

    if (input.tool === 'http_api_get_all') {
      const config = parseHttpApiConfig(authorization.connector.config)
      const endpoint = findHttpApiEndpoint(config, 'GET', input.args.path)
      const plan = resolveHttpApiPaginatePlan({
        pagination: endpoint?.pagination,
        pageParam: input.args.pageParam,
        pageSizeParam: input.args.pageSizeParam,
        pageSize: input.args.pageSize,
        startPage: input.args.startPage,
        maxPages: input.args.maxPages,
        arrayPath: input.args.arrayPath,
      })
      if (!plan) {
        return {
          ok: false,
          path: input.args.path,
          pageCount: 0,
          itemCount: 0,
          items: [],
          error:
            'A végponthoz nincs megbízható lapozási szerződés. ' +
            'Frissítsd a connector OpenAPI snapshotját, adj meg endpoint.pagination konfigurációt, ' +
            'vagy legacy API-nál explicit pageParam értéket.',
        }
      }
      const undocumented = undocumentedPaginationQueryParams(plan, endpoint?.queryParams)
      if (undocumented.length > 0) {
        return {
          ok: false,
          path: input.args.path,
          pageCount: 0,
          itemCount: 0,
          items: [],
          error: `A lapozási szerződés nem dokumentált query paramétert használ: ${undocumented.join(', ')}.`,
        }
      }
      const outcome = await paginateHttpApiGet({
        plan,
        path: input.args.path,
        baseUrl: config.baseUrl,
        baseQuery: input.args.query,
        fetchPage: async (query: HttpApiPaginateQuery, path) => {
          const page = await ctx.executeHttpApiTool(
            {
              ...input,
              tool: 'http_api_get',
              args: {
                connectorId: input.args.connectorId,
                path: path ?? input.args.path,
                continuationOf: plan.kind === 'next_link' ? input.args.path : undefined,
                query,
                headers: input.args.headers,
              },
            },
            authorization.connector!,
            actingTenantId,
            actingUserId,
            authorization.agentSecretAlias,
            delegatedAccessToken,
          )
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
          path: input.args.path,
          pageCount: outcome.pageCount,
          itemCount: outcome.items.length,
          items: outcome.items,
          error: outcome.error,
        }
      }
      return {
        ok: true,
        path: input.args.path,
        pageCount: outcome.pageCount,
        itemCount: outcome.items.length,
        items: outcome.items,
        provenance: {
          sourceTool: 'http_api_get_all',
          paginationComplete: outcome.paginationComplete,
          strategy: outcome.strategy,
          stopReason: outcome.stopReason,
        },
      }
    }

    const result = await ctx.executeHttpApiTool(
      input,
      authorization.connector,
      actingTenantId,
      actingUserId,
      authorization.agentSecretAlias,
      delegatedAccessToken,
    )

    // Sima get + ownership/névsor: ha egy oldalnyi kerek darabszám jön,
    // tereld get_all-ra mielőtt a modell extract→egyeztetést futtatna.
    if (input.tool === 'http_api_get' && result && typeof result === 'object' && result.ok !== false) {
      const pageHint = buildHttpApiLikelyPaginatedHint({
        path: input.args.path,
        body: result.body,
      })
      if (pageHint) {
        return { ...result, hint: [result.hint, pageHint].filter(Boolean).join(' ') }
      }
    }

    return result
  },
}
