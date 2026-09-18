import {
  mcpOAuthCorsOptions,
  mcpProtectedResourceMetadata,
} from '@/auth/mcp-oauth-metadata'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return mcpProtectedResourceMetadata(request)
}

export function OPTIONS(): Response {
  return mcpOAuthCorsOptions()
}
