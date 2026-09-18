function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing harness env for wiki ticket process: ${name}`)
  return value
}

export class HarnessProcessError extends Error {
  constructor(
    message: string,
    readonly category: 'permanent' | 'transient',
  ) {
    super(message)
    this.name = 'HarnessProcessError'
  }
}

/**
 * Provider-független wiki ticket feldolgozás: a platform WikiAgentRuntime-ját hívja
 * HTTP-n keresztül (ugyanaz az út, mint local-wiki launcher).
 */
export async function runWikiTicketProcessViaPlatform(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const platformApiUrl = requireEnv(env, 'PLATFORM_API_URL').replace(/\/$/, '')
  const apiKey = requireEnv(env, 'HARNESS_AGENT_API_KEY')
  const ticketId = requireEnv(env, 'TICKET_ID')
  const agentId = requireEnv(env, 'AGENT_ID')

  const response = await fetchImpl(
    `${platformApiUrl}/api/v1/harness/tickets/${encodeURIComponent(ticketId)}/process`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ agentId }),
    },
  )

  const raw = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (
    !contentType.includes('application/json') &&
    raw.trimStart().startsWith('<')
  ) {
    throw new Error(
      `Platform HTML választ adott JSON helyett (${response.status}). ` +
        'A /api/v1/harness/tickets/.../process végpont valószínűleg nincs deployolva — ' +
        'futtasd: npm run deploy. Localban: HARNESS_LAUNCHER_MODE=local-wiki (Docker harness nélkül).',
    )
  }

  let payload: { success?: boolean; error?: string; category?: 'permanent' | 'transient' }
  try {
    payload = JSON.parse(raw) as {
      success?: boolean
      error?: string
      category?: 'permanent' | 'transient'
    }
  } catch {
    throw new Error(
      `Platform válasz nem értelmezhető JSON-ként (${response.status}): ${raw.slice(0, 200)}`,
    )
  }

  if (!response.ok || !payload.success) {
    const category =
      payload.category ?? (response.status >= 400 && response.status < 500 ? 'permanent' : 'transient')
    throw new HarnessProcessError(
      payload.error ?? `Wiki ticket process failed: ${response.status}`,
      category,
    )
  }
}

export function shouldRunWikiTicketProcess(env: Record<string, string | undefined>): boolean {
  return (env.HARNESS_MODE ?? 'wiki') === 'wiki'
}
