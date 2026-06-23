export function conversationWorkspaceFilesUrl(conversationId: string) {
  return `/api/v1/conversations/${conversationId}/workspace/files`
}

export async function uploadConversationWorkspaceFile(conversationId: string, file: File) {
  const form = new FormData()
  form.set('file', file)
  const res = await fetch(conversationWorkspaceFilesUrl(conversationId), { method: 'POST', body: form })
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(json.error ?? `Upload failed: HTTP ${res.status}`)
  }
  return res.json()
}
