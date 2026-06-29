/**
 * Sandbox connection-test adapter (Feature-spec — Provisioning-Assistant §8.4, §7.3,
 * F2-P-D). Egyetlen, szűk jogú, read-only próbahívást intéz a draft connector
 * `baseUrl`-jére / egy olvasó proposedTool-jára, mielőtt az admin aktiválhatna.
 *
 * BIZTONSÁGI MAG — defense-in-depth, mert a `config` megbízhatatlan külső inputból
 * (API-doksi) származik (OWASP LLM01):
 *   1. A tárolt config-on ÚJRA lefut a determinisztikus validátor; `failed` →
 *      semmilyen hálózati hívás nem indul.
 *   2. EGRESS DENY-BY-DEFAULT a hívás pillanatában: a feloldott URL host-ja KÖTELEZŐ
 *      módon a tenant allowliston legyen — szigorúbb, mint a validátor warn-szintje,
 *      mert itt tényleges kifelé menő kapcsolat jön létre (§3.2.1).
 *   3. SSRF-őr: tiltott host-minták (felhő-metaadat, localhost, nyers IP) → blokk.
 *   4. CSAK GET (read-only); write-tool SOHA nem hívódik. Átirányítás (3xx) tiltott
 *      (manual redirect), mert egy redirect a metaadat-hostra vihetne.
 *   5. A secret/token SOSEM az agentnél: legfeljebb egy injektálható non-prod token
 *      adapter (`resolveSandboxToken`) ad vissza értéket; a token SOHA nem kerül a
 *      `detail`-be vagy auditba.
 */
import {
  normalizeConnectorConfig,
  type ConnectorConfig,
  type ProposedTool,
} from './connector-config'
import { validateDraftConfig } from './draft-validator'
import type { SandboxConnectionTester } from './provisioning-service'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface HttpSandboxConnectionTesterDeps {
  /** A tenant engedélyezett egress-célhostjai (deny-by-default egress-policy, §7.2). */
  resolveEgressAllowlist: (tenantId: string | null) => Promise<string[]>
  /** Banki preset továbbadása a defense-in-depth validációhoz (allowlist-only). */
  resolveBankPreset?: (tenantId: string | null) => Promise<boolean>
  /**
   * Non-prod, szűk jogú sandbox-token feloldása az alias mögül (§8.4). A valódi
   * Secret Manager / Tool Broker MCP-proxy köti be; alapból nincs token (tokenless
   * próbahívás). A visszaadott érték SOSEM kerül naplóba.
   */
  resolveSandboxToken?: (input: {
    secretAlias: string | null
    tenantId: string | null
  }) => Promise<string | null>
  /** Injektálható fetch (teszthez); alapból a globális fetch. */
  fetchImpl?: FetchLike
  /** Próbahívás időkorlátja ms-ban (alapból 5000). */
  timeoutMs?: number
}

// SSRF-őr: ugyanaz a tiltott host-osztály, mint a determinisztikus validátorban
// (felhő-metaadat, localhost-osztály, nyers IP). A hívás pillanatában is védünk.
const FORBIDDEN_HOST_PATTERNS: RegExp[] = [
  /^\d{1,3}(\.\d{1,3}){3}$/, // nyers IPv4
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i,
  /(169\.254\.169\.254|metadata\.google\.internal)/i, // felhő-metaadat
  /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i, // ismert exfil-sink
]

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * A próbahívás célja: az első OLVASÓ (GET, path-paraméter nélküli) tool, különben a
 * `baseUrl` gyökere. Path-paramétert ({id}) tartalmazó toolt szándékosan kihagyunk —
 * nincs valódi azonosítónk, és nem akarunk találgatott erőforrást lekérni.
 */
function pickProbeUrl(config: ConnectorConfig): string {
  const readTool: ProposedTool | undefined = config.proposedTools.find(
    (t) => t.method === 'GET' && t.access === 'read' && !/[{}]/.test(t.path),
  )
  if (readTool) {
    const base = config.baseUrl.replace(/\/+$/, '')
    const path = readTool.path.startsWith('/') ? readTool.path : `/${readTool.path}`
    return `${base}${path}`
  }
  return config.baseUrl
}

function authHeaderFor(
  config: ConnectorConfig,
  token: string,
): Record<string, string> {
  switch (config.auth.type) {
    case 'api_key_header':
      return { [config.auth.headerName || 'X-Api-Key']: token }
    case 'bearer_token':
    case 'oauth2':
      return { Authorization: `Bearer ${token}` }
    case 'basic':
      return { Authorization: `Basic ${token}` }
    default:
      return {}
  }
}

export class HttpSandboxConnectionTester implements SandboxConnectionTester {
  constructor(private deps: HttpSandboxConnectionTesterDeps) {}

  async test(input: {
    config: ConnectorConfig
    secretAlias: string | null
    tenantId: string | null
  }): Promise<{ ok: boolean; statusCode?: number; detail?: string }> {
    // (0) A tárolt config-ot ÚJRA normalizáljuk — a hívás nem bízik a perzisztált alakban.
    let config: ConnectorConfig
    try {
      config = normalizeConnectorConfig(input.config)
    } catch {
      return { ok: false, detail: 'invalid_config' }
    }

    const [allowlist, bankPreset] = await Promise.all([
      this.deps.resolveEgressAllowlist(input.tenantId),
      this.deps.resolveBankPreset?.(input.tenantId) ?? Promise.resolve(false),
    ])

    // (1) Defense-in-depth: a determinisztikus validátor `failed`-je blokkol hívás előtt.
    const validation = validateDraftConfig(config, { egressAllowlist: allowlist, bankPreset })
    if (validation.status === 'failed') {
      return { ok: false, detail: 'blocked_by_validation' }
    }

    const probeUrl = pickProbeUrl(config)
    const probeHost = hostOf(probeUrl)
    if (!probeHost) {
      return { ok: false, detail: 'invalid_probe_url' }
    }

    // (2) Egress deny-by-default a hívás pillanatában (szigorúbb, mint a validátor warn).
    const allow = new Set(allowlist.map((h) => h.toLowerCase()))
    if (!allow.has(probeHost)) {
      return { ok: false, detail: 'egress_not_allowlisted' }
    }

    // (3) SSRF-őr a feloldott hoston.
    if (FORBIDDEN_HOST_PATTERNS.some((p) => p.test(probeHost))) {
      return { ok: false, detail: 'forbidden_host' }
    }

    // (4) Non-prod token feloldása (opcionális). A token SOHA nem kerül naplóba.
    let headers: Record<string, string> = { Accept: 'application/json' }
    const token = (await this.deps.resolveSandboxToken?.({
      secretAlias: input.secretAlias,
      tenantId: input.tenantId,
    })) ?? null
    if (token) {
      headers = { ...headers, ...authHeaderFor(config, token) }
    }

    const fetchImpl: FetchLike = this.deps.fetchImpl ?? (globalThis.fetch as FetchLike)
    if (!fetchImpl) {
      return { ok: false, detail: 'fetch_unavailable' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 5000)
    try {
      const res = await fetchImpl(probeUrl, {
        method: 'GET', // CSAK read-only
        headers,
        redirect: 'manual', // átirányítás tiltott (SSRF-redirect a metaadat-hostra)
        signal: controller.signal,
      })
      // manual redirect: a 3xx (vagy opaqueredirect) nem elfogadott siker.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return { ok: false, statusCode: res.status, detail: 'redirect_blocked' }
      }
      const ok = res.status >= 200 && res.status < 300
      return {
        ok,
        statusCode: res.status,
        detail: ok ? 'reachable' : `http_${res.status}`,
      }
    } catch (e) {
      // A hibaüzenet sanitizált — host/secret nem szivárog ki a `detail`-be.
      const detail =
        e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'request_failed'
      return { ok: false, detail }
    } finally {
      clearTimeout(timeout)
    }
  }
}
