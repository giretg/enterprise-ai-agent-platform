import { listAgents } from '@/app/actions/platform'
import { requireTenantRole } from '@/auth/tenant-context'
import { canStartVoiceCall, readVoiceConfig } from '@/domain/voice/config'
import { loadAgentProductLinks } from '@/lib/agent-product-links-loader'
import { hasMinimumRole } from '@/lib/iam-policy'
import { parsePlatformChatAgentParam } from '@/lib/platform-chat-href'
import { hasPlatformChatModelKey } from '@/lib/platform-chat-model-key'
import { PlatformChat } from '@/components/platform-chat/platform-chat'

/**
 * #1004 D6: beépített beszélgetés a munkatársakkal. Az oldal maga csak héj: a beszélgetés a külön
 * platform-chat worker HTTP-API-ján fut (D7), a chat-tokent a `/api/chat/session` adja.
 * `?agent=` a kártya / adatlap „Beszélgetés indítása” gombjától jön.
 */
export default async function PlatformChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; conversation?: string }>
}) {
  const ctx = await requireTenantRole('viewer')
  const query = await searchParams
  const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
  // Üres állapot (§2): kulcs nélkül csak az admin kap „Kulcs beállítása” gombot.
  const keyMissingForAdmin = isAdmin && !(await hasPlatformChatModelKey(ctx.activeTenantId))
  // A munkatárslistát a worker adja, a hang-beállítás viszont csak itt, a szerveren olvasható.
  const listed = await listAgents({ limit: 100 })
  const voiceCallStyles = listed.success
    ? Object.fromEntries(
        listed.data.filter((agent) => canStartVoiceCall(agent)).map((agent) => [agent.id, readVoiceConfig(agent.voiceConfig).callStyle]),
      )
    : {}
  const productLinks = listed.success ? await loadAgentProductLinks(ctx, listed.data) : {}
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Beszélgetés a munkatársakkal</h1>
      <PlatformChat
        isAdmin={isAdmin}
        keyMissingForAdmin={keyMissingForAdmin}
        voiceCallStyles={voiceCallStyles}
        productLinks={productLinks}
        initialAgentId={parsePlatformChatAgentParam(query.agent)}
        initialConversationId={parsePlatformChatAgentParam(query.conversation)}
      />
    </div>
  )
}
