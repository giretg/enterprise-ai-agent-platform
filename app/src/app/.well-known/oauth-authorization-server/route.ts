import {
  mcpAuthorizationServerMetadata,
  mcpOAuthCorsOptions,
} from '@/auth/mcp-oauth-metadata'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return mcpAuthorizationServerMetadata()
}

export function OPTIONS(): Response {
  return mcpOAuthCorsOptions()
}
