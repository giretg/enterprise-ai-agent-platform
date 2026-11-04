import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { loadOpenRouterTenantKey } from '@/lib/openrouter-tenant-key'

/**
 * #1004 D2: a platform-chathez a cég SAJÁT modellkulcsa kell (OpenRouter vagy OpenAI); a platform
 * env-kulcsa nem számít, az nem a cég költsége.
 */
export async function hasPlatformChatModelKey(tenantId: string): Promise<boolean> {
  const [openRouter, openAi] = await Promise.all([loadOpenRouterTenantKey(tenantId), loadOpenAiTenantKey(tenantId)])
  return Boolean(openRouter?.trim() || openAi?.trim())
}
