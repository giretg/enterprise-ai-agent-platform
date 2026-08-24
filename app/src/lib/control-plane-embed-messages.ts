export const CP_EMBED_READY_MESSAGE = 'cp-embed-ready' as const

export type ControlPlaneEmbedMessage = { type: typeof CP_EMBED_READY_MESSAGE }

export function isControlPlaneEmbedReadyMessage(
  data: unknown,
): data is ControlPlaneEmbedMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as { type: unknown }).type === CP_EMBED_READY_MESSAGE
  )
}
