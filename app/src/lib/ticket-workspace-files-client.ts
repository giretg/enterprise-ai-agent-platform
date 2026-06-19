export function ticketWorkspaceFilesUrl(ticketId: string) {
  return `/api/v1/tickets/${ticketId}/workspace/files`
}

export async function uploadTicketWorkspaceFile(ticketId: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(ticketWorkspaceFilesUrl(ticketId), { method: 'POST', body: form })
  const json = (await res.json()) as { success: boolean; error?: string }
  if (!json.success) throw new Error(json.error ?? 'Feltöltés sikertelen')
}

export async function uploadTicketWorkspaceFiles(ticketId: string, files: File[]) {
  for (const file of files) {
    await uploadTicketWorkspaceFile(ticketId, file)
  }
}
