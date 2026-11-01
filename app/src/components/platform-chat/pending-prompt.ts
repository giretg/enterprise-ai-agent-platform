/**
 * Az Áttekintés oldal „Kérdezz…” mezőjéből a chat oldalra átadott első üzenet.
 * sessionStorage-ben utazik (nem az URL-ben), hogy a kérdés ne kerüljön böngésző-előzménybe / szervernaplóba.
 */
const KEY = 'platform-chat:pending'
const MAX_AGE_MS = 60_000

export type PendingPrompt = { agentId: string; text: string }

export function stashPendingPrompt(prompt: PendingPrompt): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...prompt, at: Date.now() }))
  } catch {
    // privát mód / tiltott tároló: a chat üres új beszélgetéssel nyílik
  }
}

export function takePendingPrompt(): PendingPrompt | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingPrompt> & { at?: number }
    if (typeof parsed.agentId !== 'string' || typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > MAX_AGE_MS) return null
    return { agentId: parsed.agentId, text: parsed.text }
  } catch {
    return null
  }
}
