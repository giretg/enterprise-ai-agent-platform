import type { GatewayMessage } from '@/domain/gateway/model-gateway'

/**
 * A providernek küldött prompt cache-határai. A stabil preamble-be kizárólag
 * agent-szintű, hívások között bájt-azonos üzenet kerülhet.
 */
export type PromptSegments = {
  stablePreamble: GatewayMessage[]
  /** Tool-loop statikus blokkjai után következő, de még stabil policy üzenetek. */
  stablePostamble?: GatewayMessage[]
  variableContext?: GatewayMessage[]
  history?: GatewayMessage[]
  toolTail?: GatewayMessage[]
}

/**
 * A stabil zóna utolsó üzenetére teszi a cache-határt. Ez a *jelölés*
 * providerfüggetlen és tartalom-semleges (a `content` bájtra változatlan): a
 * Gateway fordítja le annak a providernek, amelyik explicit cache-API-t vár
 * (`cache_control`), a többinél az automatikus prefix-cache él tovább.
 *
 * A bemenetet nem mutáljuk — a hívók ugyanazokat a szegmens-tömböket építik
 * fordulónként újra, és egy megjelölt üzenet visszaszivárgása a hívó
 * állapotába csendben elrontaná a következő kör határát.
 */
function markCacheBoundary(stable: GatewayMessage[]): GatewayMessage[] {
  let boundary = -1
  for (let i = stable.length - 1; i >= 0; i--) {
    const message = stable[i]!
    // Csak system/user szöveges üzenet lehet határ: a tool-eredmény és a
    // tool-hívásos assistant üzenet nem stabil prefix-vég.
    if (message.role !== 'system' && message.role !== 'user') continue
    if (!message.content.trim()) continue
    boundary = i
    break
  }
  if (boundary < 0) return stable
  return stable.map((message, i) => (i === boundary ? { ...message, cacheBoundary: true } : message))
}

/** I/O-mentes, közös prompt-összeállító a chat-, task- és tool-loop runtime-hoz. */
export function assembleGatewayMessages(segments: PromptSegments): GatewayMessage[] {
  const stable = markCacheBoundary([
    ...segments.stablePreamble,
    ...(segments.stablePostamble ?? []),
  ])
  return [
    ...stable,
    ...(segments.variableContext ?? []),
    ...(segments.history ?? []),
    ...(segments.toolTail ?? []),
  ]
}
