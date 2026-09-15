'use client'

/**
 * Beágyazott agent-chat — a `postMessage` szerződés kliens-oldala (feature-spec
 * #481, D4). Betöltéskor `eai:ready`-t küld az openernek; onnantól csak az
 * allowlist-bejegyzés originjéről fogad `eai:context`-et, mindent mást némán eldob.
 */
import { useEffect, useState } from 'react'
import { AgentChatPanel, type ChatAgent } from '@/components/agents/agent-chat-panel'
import {
  EMBED_CONTEXT_MAX_BYTES,
  embeddedContextByteSize,
  type EmbeddedContext,
} from '@/lib/embed-apps'

export function EmbedChatWindow({
  agent,
  conversationId,
  appSlug,
  appOrigin,
}: {
  agent: ChatAgent
  conversationId: string
  appSlug: string
  appOrigin: string
}) {
  const [externalContext, setExternalContext] = useState<EmbeddedContext | null>(null)

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage({ type: 'eai:ready' }, appOrigin)
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== appOrigin) return
      const payload = event.data as unknown
      if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'eai:context') {
        return
      }
      const { label, data } = payload as { label?: unknown; data?: unknown }
      if (typeof label !== 'string' || data === undefined) return
      // Ugyanaz a bájt-mérce, mint a route-on: ami itt átmegy, ott nem bukik.
      if (embeddedContextByteSize({ label, data }) > EMBED_CONTEXT_MAX_BYTES) return
      setExternalContext({ appSlug, label, data })
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [appOrigin, appSlug])

  return (
    <div className="h-dvh">
      <AgentChatPanel
        agent={agent}
        open
        onClose={() => {}}
        embedded
        initialConversationId={conversationId}
        externalContext={externalContext}
      />
    </div>
  )
}
