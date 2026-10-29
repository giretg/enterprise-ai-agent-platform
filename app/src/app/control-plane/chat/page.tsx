import { requireTenantRole } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/lib/iam-policy'
import { parsePlatformChatAgentParam } from '@/lib/platform-chat-href'
import { loadOpenRouterTenantKey } from '@/lib/openrouter-tenant-key'
import { PlatformChat } from '@/components/platform-chat/platform-chat'

/**
 * #1004 D6: beépített beszélgetés a munkatársakkal. Az oldal maga csak héj: a beszélgetés a külön
 * platform-chat worker HTTP-API-ján fut (D7), a chat-tokent a `/api/chat/session` adja.
 * `?agent=` a kártya / adatlap „Beszélgetés indítása” gombjától jön.
 */
export default async function PlatformChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>
}) {
  const ctx = await requireTenantRole('viewer')
  const query = await searchParams
  const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
  // Üres állapot (§2): kulcs nélkül csak az admin kap „Kulcs beállítása” gombot.
  const keyMissingForAdmin = isAdmin && !(await loadOpenRouterTenantKey(ctx.activeTenantId))?.trim()
  return (
    <div className="space-y-3">
      <h1 className="sr-only">Beszélgetés a munkatársakkal</h1>
      <PlatformChat
        isAdmin={isAdmin}
        keyMissingForAdmin={keyMissingForAdmin}
        initialAgentId={parsePlatformChatAgentParam(query.agent)}
      />
    </div>
  )
}
