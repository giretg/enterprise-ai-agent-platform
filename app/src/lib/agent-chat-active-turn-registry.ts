/**
 * In-process registry for active chat stream turns (Tier-1).
 * Explicit Stop a cancel API-n keresztül állítja a flaget — a fetch abort NEM cancel.
 */

type ActiveChatTurn = {
  conversationId: string
  cancelRequested: boolean
}

const activeTurns = new Map<string, ActiveChatTurn>()

export function registerActiveChatTurn(conversationId: string): void {
  activeTurns.set(conversationId, { conversationId, cancelRequested: false })
}

export function unregisterActiveChatTurn(conversationId: string): void {
  activeTurns.delete(conversationId)
}

export function requestChatTurnCancel(conversationId: string): boolean {
  const turn = activeTurns.get(conversationId)
  if (!turn) return false
  turn.cancelRequested = true
  return true
}

export function isChatTurnCancelRequested(conversationId: string): boolean {
  return activeTurns.get(conversationId)?.cancelRequested ?? false
}

export function hasActiveChatTurn(conversationId: string): boolean {
  return activeTurns.has(conversationId)
}
