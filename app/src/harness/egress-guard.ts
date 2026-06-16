export type EgressDecision = { allowed: true } | { allowed: false; reason: string }

export function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function collectAllowedHarnessHosts(env: Record<string, string | undefined>): Set<string> {
  const hosts = new Set<string>()
  const candidates = [
    env.MODEL_GATEWAY_URL,
    env.PLATFORM_API_URL,
    env.HARNESS_CALLBACK_URL,
    env.OPENAI_BASE_URL,
  ]

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    const normalized = candidate.includes('://') ? candidate : `https://${candidate}`
    const host = parseHost(normalized.replace('{ticketId}', '00000000-0000-4000-8000-000000000000'))
    if (host) hosts.add(host)
  }

  // Lokális harness → host platform (Docker Desktop / Colima)
  hosts.add('host.docker.internal')
  hosts.add('localhost')
  hosts.add('127.0.0.1')

  return hosts
}

export function evaluateEgressAllowlist(url: string, allowedHosts: Set<string>): EgressDecision {
  const host = parseHost(url)
  if (!host) return { allowed: false, reason: 'invalid_url' }
  if (allowedHosts.has(host)) return { allowed: true }
  return { allowed: false, reason: `host_not_allowed:${host}` }
}

export class EgressPolicyViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressPolicyViolation'
  }
}

/**
 * S4 spike — deny-by-default egress proof a harness indulása előtt.
 * Ha a tiltott probe URL elérhető, a futás meghiúsul (N4 governance).
 * GCP-n a VPC/firewall az igazi enforcement; ez a runtime sanity check.
 */
export async function assertEgressDenyByDefault(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (env.HARNESS_EGRESS_ENFORCE !== 'true') return

  const probeUrl = env.HARNESS_EGRESS_PROBE_URL?.trim() || 'https://example.com'
  const allowed = collectAllowedHarnessHosts(env)
  const decision = evaluateEgressAllowlist(probeUrl, allowed)
  if (decision.allowed) return

  const controller = new AbortController()
  const timeoutMs = Number.parseInt(env.HARNESS_EGRESS_PROBE_TIMEOUT_MS ?? '3000', 10)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchFn(probeUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    })
    if (response.status > 0) {
      throw new EgressPolicyViolation(
        `Egress policy violation: blocked probe ${probeUrl} was reachable (status ${response.status})`,
      )
    }
  } catch (error) {
    if (error instanceof EgressPolicyViolation) throw error
    // Network error / abort → a probe host valószínűleg nem elérhető (várt S4 viselkedés).
  } finally {
    clearTimeout(timer)
  }
}

export type EgressProbeResult = {
  probeUrl: string
  reachable: boolean
  status?: number
  error?: string
}

export async function probeExternalEgress(
  probeUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<EgressProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(probeUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    })
    return { probeUrl, reachable: true, status: response.status }
  } catch (error) {
    return {
      probeUrl,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
