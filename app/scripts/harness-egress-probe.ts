/**
 * S4 spike — harness konténerből külső egress probe (N4 governance proof).
 * Exit 0: a tiltott probe URL nem elérhető (várt deny-by-default viselkedés).
 * Exit 1: a probe URL elérhető → egress szivárgás.
 *
 * Futtatás Dockerben:
 *   docker run --rm wiki-harness:local npm run harness:egress-probe
 */
import { collectAllowedHarnessHosts, evaluateEgressAllowlist, probeExternalEgress } from '../src/harness/egress-guard'

async function main() {
  const probeUrl = process.env.HARNESS_EGRESS_PROBE_URL?.trim() || 'https://example.com'
  const allowed = collectAllowedHarnessHosts(process.env)
  const decision = evaluateEgressAllowlist(probeUrl, allowed)

  console.log(`[egress-probe] probe=${probeUrl}`)
  console.log(`[egress-probe] allowlist=${[...allowed].join(', ')}`)

  if (decision.allowed) {
    console.log('[egress-probe] SKIP: probe URL is on harness allowlist')
    process.exit(0)
  }

  const result = await probeExternalEgress(probeUrl)
  if (result.reachable) {
    console.error(
      `[egress-probe] FAIL: external URL reachable (status=${result.status ?? 'unknown'}) — egress deny-by-default sérül`,
    )
    process.exit(1)
  }

  console.log(`[egress-probe] OK: external URL blocked/unreachable (${result.error ?? 'no response'})`)
}

main().catch((error) => {
  console.error('[egress-probe] fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
