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

/** I/O-mentes, közös prompt-összeállító a chat-, task- és tool-loop runtime-hoz. */
export function assembleGatewayMessages(segments: PromptSegments): GatewayMessage[] {
  return [
    ...segments.stablePreamble,
    ...(segments.stablePostamble ?? []),
    ...(segments.variableContext ?? []),
    ...(segments.history ?? []),
    ...(segments.toolTail ?? []),
  ]
}
