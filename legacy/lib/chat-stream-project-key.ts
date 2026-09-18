import { effectiveWorkProjectKey } from '@/lib/work-project'

export type AssignableWorkProjectKey = (
  raw: string,
) => Promise<{ ok: true; key: string } | { ok: false; reason: string }>

export type ChatStreamProjectKeyResult =
  | { ok: true; key: string | undefined }
  | { ok: false; reason: string }

/**
 * Új beszélgetés és kulcsváltás csak kiosztható projektkulccsal mehet.
 * A beszélgetéshez már kötött kulcs archiválás után is marad — a névtér létezik.
 */
export async function resolveChatStreamProjectKey(input: {
  projectKey: unknown
  skip: boolean
  conversation: { projectKey: string | null } | null
  assignableKey: AssignableWorkProjectKey
}): Promise<ChatStreamProjectKeyResult> {
  if (input.skip) return { ok: true, key: undefined }
  if (typeof input.projectKey !== 'string') return { ok: true, key: undefined }
  const requested = input.projectKey.trim()
  if (!requested) return { ok: true, key: undefined }

  if (
    input.conversation &&
    effectiveWorkProjectKey(input.conversation.projectKey) === requested
  ) {
    return { ok: true, key: effectiveWorkProjectKey(input.conversation.projectKey) }
  }

  const assigned = await input.assignableKey(requested)
  if (!assigned.ok) return { ok: false, reason: assigned.reason }
  return { ok: true, key: assigned.key }
}
