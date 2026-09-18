export const CONTROL_PLANE_EMBED_SOURCE = 'enterprise-ai-control-plane'
export const CP_EMBED_READY_MESSAGE = { source: CONTROL_PLANE_EMBED_SOURCE, type: 'ready' } as const

export type ControlPlaneEmbedMessage = {
  source: typeof CONTROL_PLANE_EMBED_SOURCE
  type: string
  href?: string
}

export function isControlPlaneEmbedReadyMessage(value: unknown): value is ControlPlaneEmbedMessage {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return rec.source === CONTROL_PLANE_EMBED_SOURCE && rec.type === 'ready'
}
