import { productionModelGatewayDeps } from '@/auth/model-gateway-deps'
import { handleChatCompletion } from '@/domain/model-gateway/proxy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** #769: a Hermes Managed Client egyetlen céges modell-kapuja (OpenAI chat_completions, SSE-vel). */
export async function POST(request: Request): Promise<Response> {
  return handleChatCompletion(productionModelGatewayDeps(), request)
}
