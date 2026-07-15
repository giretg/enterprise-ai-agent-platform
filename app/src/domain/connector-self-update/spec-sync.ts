/**
 * Önfrissítő connector — szinkron-motor (Dev-Spec §9, WP-2).
 *
 * A "Frissítés keresése" gomb mögötti letöltő + parse. Egyirányú, kapuzott adatáramlás:
 *   spec-URL ──(A4: egress-guard)──▶ nyers pillanatkép ──(OpenAPI-extractor)──▶ capability-set
 *
 * Invariánsok:
 *  - A4  — a letöltés a közös `guardEgressUrl`-en megy át (SSRF, séma, allowlist,
 *          redirect-pinning). A spec-URL hostja az EGYETLEN engedélyezett cél (host-pinning).
 *  - A5  — FAIL-CLOSED: ha a letöltés/parse elbukik, a hívó a RÉGI verziót tartja meg.
 *          A service sosem "félig" sikeres — vagy tiszta capability-set, vagy indokolt hiba.
 *  - A tartalmat ADATKÉNT parse-oljuk strukturált sémává; sosem tesszük nyers prózaként
 *    az agent kontextusába (§10/2). A nyers pillanatkép a bizonyíték (hash-sel).
 *
 * TISZTA-ish: nem ír auditba/DB-be. A `fetchImpl` és `resolveHostIps` injektálható,
 * így a determinisztikus tesztek hálózat nélkül futnak.
 */
import { createHash } from 'node:crypto'
import { guardEgressUrl, type EgressBlockReason } from '@/domain/net/egress-guard'
import {
  extractConnectorConfigFromOpenApiSpec,
  parseOpenApiDocument,
} from '@/domain/provisioning/openapi-config-extractor'
import type { CapabilitySet } from './capability-set'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type SpecSyncLimits = {
  maxBytes: number
  timeoutMs: number
}

export const DEFAULT_SPEC_SYNC_LIMITS: SpecSyncLimits = {
  // Az OpenAPI-specek nagyobbak lehetnek egy weboldalnál; de méret-cap kell (DoS/OOM).
  maxBytes: 5_242_880, // 5 MiB
  timeoutMs: 15_000,
}

/** A letöltéskor elfogadott tartalomtípusok (JSON/YAML/plain). HTML-t NEM parse-olunk. */
const ALLOWED_SPEC_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-yaml',
  'application/yaml',
  'text/yaml',
  'text/plain',
  'application/octet-stream', // sok szolgáltató így adja az openapi.json-t
])

export type SpecSyncFailReason =
  | EgressBlockReason // invalid_url | scheme_blocked | ssrf_blocked | egress_not_allowlisted
  | 'fetch_failed'
  | 'too_large'
  | 'content_type_blocked'
  | 'not_openapi'
  | 'parse_error'
  | 'empty_spec'
  | 'unsupported_auth'

export type SpecSyncResult =
  | {
      ok: true
      rawText: string
      rawHash: string
      capabilitySet: CapabilitySet
      host: string
    }
  | { ok: false; reason: SpecSyncFailReason; detail?: string }

export interface SpecSyncDeps {
  fetchImpl?: FetchLike
  resolveHostIps?: (host: string) => Promise<string[]>
  limits?: Partial<SpecSyncLimits>
}

/** SHA-256 a nyers tartalomról — a "változott-e?" döntés és a bizonyíték alapja (A4/A5). */
export function specContentHash(rawText: string): string {
  return createHash('sha256').update(rawText, 'utf8').digest('hex')
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function contentTypeAllowed(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return ALLOWED_SPEC_CONTENT_TYPES.has(base)
}

async function readCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort()
    return { ok: false }
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) return { ok: false }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(buf) }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      controller.abort()
      await reader.cancel().catch(() => {})
      return { ok: false }
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(merged) }
}

export class SpecSyncService {
  private limits: SpecSyncLimits

  constructor(private deps: SpecSyncDeps = {}) {
    this.limits = { ...DEFAULT_SPEC_SYNC_LIMITS, ...deps.limits }
  }

  /**
   * Letölti és capability-set-té parse-olja a spec-URL tartalmát. A `specUrl` a
   * connectorhoz JÓVÁHAGYOTT, oda-szögezett link (A4) — az egress-allowlist a hostja.
   * `providerHint` az extractor provider-slug tippje (a connector neve/providerje).
   */
  async sync(specUrl: string, providerHint?: string): Promise<SpecSyncResult> {
    const host = hostOf(specUrl)
    // Host-pinning: az EGYETLEN engedélyezett cél a spec-URL saját hostja.
    const guard = await guardEgressUrl({
      url: specUrl,
      allowlistHosts: host ? [host] : [],
      resolveHostIps: this.deps.resolveHostIps,
    })
    if (!guard.ok) return { ok: false, reason: guard.reason, detail: guard.detail }

    const download = await this.download(guard.url, guard.host)
    if (!download.ok) return download

    const rawText = download.text
    if (!rawText.trim()) return { ok: false, reason: 'empty_spec' }

    const document = await parseOpenApiDocument(rawText)
    // D1: az önfrissítő MVP kizárólag OpenAPI 3.x snapshotot fogad el. A közös
    // extractor a hagyományos provisioning miatt Swagger 2-t is tud, itt szűkítünk.
    if (!document || typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
      return { ok: false, reason: 'not_openapi' }
    }
    const extract = extractConnectorConfigFromOpenApiSpec(document, providerHint)
    if (!extract.ok) {
      // A5: hibás/üres/nem-OpenAPI spec → NEM veszünk át semmit (a régi marad érvényben).
      const reason: SpecSyncFailReason = extract.reason === 'not_openapi' ? 'not_openapi' : 'parse_error'
      return { ok: false, reason, detail: extract.reason }
    }
    if (extract.config.proposedTools.length === 0) {
      return { ok: false, reason: 'empty_spec', detail: 'no_operations' }
    }
    // A jelenlegi létrehozó-flow egyetlen API-kulcsot kezel. OAuthhoz külön
    // client/refresh credential migráció és consent kellene; ezt az MVP nem imitálja.
    if (extract.config.auth.type === 'oauth2') {
      return { ok: false, reason: 'unsupported_auth', detail: 'oauth_requires_credential_migration' }
    }

    // A spec letöltési hostja és az API célhostja két külön biztonsági határ.
    // A snapshot baseUrl-jét is ellenőrizzük, mielőtt egyáltalán proposal készülhet.
    const apiHost = hostOf(extract.config.baseUrl)
    const apiGuard = await guardEgressUrl({
      url: extract.config.baseUrl,
      allowlistHosts: apiHost && extract.config.egressHosts.includes(apiHost) ? [apiHost] : [],
      resolveHostIps: this.deps.resolveHostIps,
    })
    if (!apiGuard.ok) {
      return { ok: false, reason: apiGuard.reason, detail: `api_base_url:${apiGuard.detail ?? apiGuard.reason}` }
    }

    return {
      ok: true,
      rawText,
      rawHash: specContentHash(rawText),
      capabilitySet: extract.config,
      host: guard.host,
    }
  }

  private async download(
    url: string,
    host: string,
    hop = 0,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: SpecSyncFailReason; detail?: string }> {
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? (globalThis.fetch as FetchLike)
    if (!fetchImpl) return { ok: false, reason: 'fetch_failed', detail: 'fetch_unavailable' }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual', // idegen-host redirect tilos (A4 redirect-pinning)
        signal: controller.signal,
        headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain' },
        // SOSEM küldünk connector-secretet — a spec-URL publikus leírásra mutat.
      })

      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        const location = res.headers.get('location')
        if (!location || hop >= 1) return { ok: false, reason: 'fetch_failed', detail: 'redirect_blocked' }
        const target = new URL(location, url).toString()
        const guard = await guardEgressUrl({
          url: target,
          allowlistHosts: [host],
          resolveHostIps: this.deps.resolveHostIps,
        })
        if (!guard.ok || guard.host !== host) {
          return { ok: false, reason: 'fetch_failed', detail: 'redirect_blocked' }
        }
        clearTimeout(timeout)
        return this.download(guard.url, host, hop + 1)
      }

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: 'fetch_failed', detail: `http_${res.status}` }
      }

      const contentType = res.headers.get('content-type') ?? ''
      // Üres content-type-ot elfogadunk (sok statikus fájlkiszolgáló nem küld) — a parse dönt.
      if (contentType && !contentTypeAllowed(contentType)) {
        return { ok: false, reason: 'content_type_blocked', detail: contentType.split(';')[0]?.trim() }
      }

      const body = await readCapped(res, this.limits.maxBytes, controller)
      if (!body.ok) return { ok: false, reason: 'too_large' }
      return { ok: true, text: body.text }
    } catch (e) {
      const detail = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'request_failed'
      return { ok: false, reason: 'fetch_failed', detail }
    } finally {
      clearTimeout(timeout)
    }
  }
}
