/** #1028: levélküldés Microsoft Graph-on át egy bekötött (tenant-)postafiókból. Fix host, nincs SSRF-felület. */
const GRAPH_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail'

export async function sendMicrosoftMail(
  accessToken: string,
  message: { to: string; subject: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (accessToken.startsWith('stub-')) return
  const res = await fetchImpl(GRAPH_SEND_MAIL_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: 'Text', content: message.body },
        toRecipients: [{ emailAddress: { address: message.to } }],
      },
      saveToSentItems: true,
    }),
  })
  if (!res.ok) throw new Error(`microsoft_send_failed: HTTP ${res.status}`)
}
