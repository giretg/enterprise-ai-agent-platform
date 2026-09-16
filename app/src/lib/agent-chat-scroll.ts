/** px a lista alján — ennél közelebb „rá van csatolva" a chat görgetés. */
export const CHAT_SCROLL_PIN_THRESHOLD_PX = 80

export function isChatPinnedToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = CHAT_SCROLL_PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}
