import { handleMcpRequest } from '@/auth/mcp-server'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ tenantSlug: string }> }

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { tenantSlug } = await context.params
  return handleMcpRequest(request, tenantSlug)
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { tenantSlug } = await context.params
  return handleMcpRequest(request, tenantSlug)
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { tenantSlug } = await context.params
  return handleMcpRequest(request, tenantSlug)
}
