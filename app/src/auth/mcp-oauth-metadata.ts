import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { mcpResourceIdentifier } from './mcp-principal'

/** RFC 9728 metadata CORS — same headers as `@clerk/mcp-tools` `corsHeaders`. */
export const MCP_OAUTH_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
} as const

export function mcpOAuthCorsOptions(): Response {
  return new Response(null, { status: 200, headers: MCP_OAUTH_CORS_HEADERS })
}

export function mcpAuthNotConfigured(): Response {
  return Response.json(
    { error: { code: 'auth_not_configured', message: 'Authentication is not configured' } },
    { status: 503 },
  )
}

/**
 * RFC 9728 protected-resource document. Canonical `resource` is `{origin}/api/mcp`
 * (no tenant slug). Clerk fills `authorization_servers` from the publishable key.
 *
 * `@clerk/mcp-tools` is ESM-only; load it with dynamic import so tsx/CJS tests
 * and Next ESM both resolve the package exports.
 */
export async function mcpProtectedResourceMetadata(request: Request): Promise<Response> {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  if (!publishableKey) return mcpAuthNotConfigured()

  const { generateClerkProtectedResourceMetadata, corsHeaders } = await import('@clerk/mcp-tools/server')
  const origin = resolvePublicAppOrigin(request)
  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey,
    resourceUrl: mcpResourceIdentifier(origin),
    properties: {
      scopes_supported: ['openid', 'profile', 'email'],
      bearer_methods_supported: ['header'],
    },
  })

  return Response.json(metadata, {
    headers: {
      'Cache-Control': 'max-age=3600',
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

export async function mcpAuthorizationServerMetadata(): Promise<Response> {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  if (!publishableKey) return mcpAuthNotConfigured()

  const { fetchClerkAuthorizationServerMetadata, corsHeaders } = await import('@clerk/mcp-tools/server')
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey })
  return Response.json(metadata, {
    headers: {
      'Cache-Control': 'max-age=3600',
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}
