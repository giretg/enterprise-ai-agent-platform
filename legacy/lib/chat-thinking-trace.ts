export type ThinkingTraceState = Record<string, string>
export type ThinkingTraceControlState = 'loading' | 'enabled' | 'disabled'

export type ThinkingTraceDelta = {
  turnId: string
  delta: string
}

/** Kliensoldali D7 kapu: kikapcsolva az SSE thinking esemény nem módosíthat állapotot. */
export function appendThinkingDelta(
  current: ThinkingTraceState | undefined,
  event: ThinkingTraceDelta,
  controls: ThinkingTraceControlState,
): ThinkingTraceState | undefined {
  if (controls !== 'enabled') return current
  return {
    ...current,
    [event.turnId]: (current?.[event.turnId] ?? '') + event.delta,
  }
}

export function canStartThinkingTraceStream(controls: ThinkingTraceControlState): boolean {
  return controls !== 'loading'
}
