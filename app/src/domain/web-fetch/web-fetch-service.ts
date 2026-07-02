/**
 * Platform-szintű `web_fetch` (WS-D) — kontrollált, deny-by-default tartalom-letöltés
 * (Feature-spec — WebFetch-Egress §7, „A" réteg). A platform EGYETLEN új kimenő-hálózati
 * felülete. Minden §7.2 kontroll itt, sorrendben fut; a döntések determinisztikusak
 * (nem az LLM-re bízottak). A közös SSRF/allowlist-védelem a `egress-guard` modulból jön.
 *
 * A service PURE-ish: nem ír auditba és nem számol budgetet — a hívó (Tool Broker / a
 * felfedező hurok) a visszaadott `WebFetchAuditMeta`-ból naplóz és a budget-számlálót
 * ő vezeti. Így a determinisztikus tesztek (WF-*) DB és hálózat nélkül futnak (fake fetch).
 */
import { createHash } from 'node:crypto'
import { guardEgressUrl } from '@/domain/net/egress-guard'
import { sanitizeFetchedContent } from './content-sanitize'
import {
  DEFAULT_WEB_FETCH_LIMITS,
  WEB_FETCH_ALLOWED_CONTENT_TYPES,
  type WebFetchAuditMeta,
  type WebFetchBudget,
  type WebFetchLimits,
  type WebFetchResult,
  type WebFetchSourceType,
} from './web-fetch-types'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface WebFetchServiceDeps {
  /** Injektálható fetch (teszthez); alapból a globális fetch. */
  fetchImpl?: FetchLike
  /**
   * DNS-feloldó a rebinding-ellenőrzéshez (§7.2/4). Ha nincs megadva, csak a host-minta
   * alapú SSRF-szűrés fut. Élesben a node `dns` réteg köti be.
   */
  resolveHostIps?: (host: string) => Promise<string[]>
  limits?: Partial<WebFetchLimits>
}

export type WebFetchRequest = {
  url: string
  /** A megengedett forrás-URL-ek — a web_search official/vendor_doc találatai (§7.2/2). */
  allowedSourceUrls: Iterable<string>
  /** A megengedett cél-hostnevek (§7.2/5): allowlist + a search domain-policy hostjai. */
  allowlistHosts: Iterable<string>
  sourceType?: WebFetchSourceType
  /** Globális kill-switch (§7.2/1). false → web_fetch_disabled. */
  enabled: boolean
  /** Fetch-budget (§7.2/11); a számlálót a hívó vezeti, itt csak kapuzunk. */
  budget?: WebFetchBudget
}

function hashPrefix(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function normalizeUrl(url: string): string | null {
  try {
    return new URL(url).toString()
  } catch {
    return null
  }
}

function contentTypeAllowed(contentType: string): boolean {
  const base = contentType.split(';')[0]!.trim().toLowerCase()
  return (WEB_FETCH_ALLOWED_CONTENT_TYPES as readonly string[]).includes(base)
}

/** A body streamelt olvasása méret-cappal (§7.2/9). Túllépéskor abort + `too_large`. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  // Gyors elutasítás a Content-Length alapján (ha megbízható).
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort()
    return { ok: false }
  }

  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) return { ok: false }
    return { ok: true, bytes: buf }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        await reader.cancel().catch(() => {})
        return { ok: false }
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return { ok: true, bytes: merged }
}

export class WebFetchService {
  private limits: WebFetchLimits

  constructor(private deps: WebFetchServiceDeps = {}) {
    this.limits = { ...DEFAULT_WEB_FETCH_LIMITS, ...deps.limits }
  }

  /**
   * A §7.2 kontrollok sorrendben:
   *  1. kill-switch → web_fetch_disabled
   *  2. csak beszélgetésbeli (search-eredmény) URL → url_not_in_conversation
   * 11. fetch-budget → fetch_budget_exceeded
   *  3–5. egress-guard (séma, SSRF, allowlist)
   *  6. redirect: manual (idegen host → redirect_blocked; max 1 azonos-host ugrás)
   *  7. GET + AbortController timeout
   *  8. content-type allowlist
   *  9. méret-cap (streamelt)
   * 10. sanitizálás + hossz-limit
   */
  async fetch(req: WebFetchRequest): Promise<WebFetchResult> {
    // (1) Kill-switch.
    if (!req.enabled) return { ok: false, reason: 'web_fetch_disabled' }

    // (2) Csak a beszélgetésben (web_search-találatokban) már szereplő URL tölthető le.
    const normalized = normalizeUrl(req.url)
    if (!normalized) return { ok: false, reason: 'invalid_url' }
    const allowedNorm = new Set<string>()
    for (const u of req.allowedSourceUrls) {
      const n = normalizeUrl(u)
      if (n) allowedNorm.add(n)
    }
    if (!allowedNorm.has(normalized)) {
      return { ok: false, reason: 'url_not_in_conversation' }
    }

    // (11) Fetch-budget (a számlálás a hívóé; itt csak kapuzunk).
    if (req.budget) {
      const b = req.budget
      if (b.perDiscoveryUsed >= b.perDiscoveryMax || b.perAgentDayUsed >= b.perAgentDayMax) {
        return { ok: false, reason: 'fetch_budget_exceeded' }
      }
    }

    // (3–5) egress-guard: séma, SSRF host-minta, feloldás-utáni privát IP, allowlist.
    const guard = await guardEgressUrl({
      url: normalized,
      allowlistHosts: req.allowlistHosts,
      resolveHostIps: this.deps.resolveHostIps,
    })
    if (!guard.ok) return { ok: false, reason: guard.reason, detail: guard.detail }

    return this.performFetch(guard.url, guard.host, req)
  }

  private async performFetch(
    url: string,
    host: string,
    req: WebFetchRequest,
    hop = 0,
  ): Promise<WebFetchResult> {
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? (globalThis.fetch as FetchLike)
    if (!fetchImpl) return { ok: false, reason: 'fetch_failed', detail: 'fetch_unavailable' }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET', // (7) CSAK GET
        redirect: 'manual', // (6) idegen-host redirect tilos
        signal: controller.signal,
        headers: { Accept: WEB_FETCH_ALLOWED_CONTENT_TYPES.join(', ') },
        // (7.3) SOSEM küldünk tenant-secretet/cookie-t/auth-fejlécet — a doksi publikus.
      })

      // (6) Redirect-kezelés: idegen hostra tilos. Max 1 azonos-host ugrás, újra átfuttatva.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        const location = res.headers.get('location')
        if (!location || hop >= 1) return { ok: false, reason: 'redirect_blocked' }
        const target = new URL(location, url).toString()
        const guard = await guardEgressUrl({
          url: target,
          allowlistHosts: req.allowlistHosts,
          resolveHostIps: this.deps.resolveHostIps,
        })
        if (!guard.ok || guard.host !== host) return { ok: false, reason: 'redirect_blocked' }
        clearTimeout(timeout)
        return this.performFetch(guard.url, host, req, hop + 1)
      }

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: 'fetch_failed', detail: `http_${res.status}` }
      }

      // (8) Content-type allowlist.
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentTypeAllowed(contentType)) {
        return { ok: false, reason: 'content_type_blocked', detail: contentType.split(';')[0]?.trim() }
      }

      // (9) Méret-cap (streamelt).
      const body = await readBodyCapped(res, this.limits.maxBytes, controller)
      if (!body.ok) return { ok: false, reason: 'too_large' }

      const raw = new TextDecoder('utf-8', { fatal: false }).decode(body.bytes)

      // (10) Sanitizálás + hossz-limit.
      const text = sanitizeFetchedContent({
        raw,
        contentType,
        maxContentChars: this.limits.maxContentChars,
      })

      return {
        ok: true,
        host,
        sourceType: req.sourceType,
        contentType: contentType.split(';')[0]!.trim().toLowerCase(),
        bytes: body.bytes.byteLength,
        contentHash: hashPrefix(text),
        urlHash: hashPrefix(url),
        text,
      }
    } catch (e) {
      const detail = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'request_failed'
      return { ok: false, reason: 'fetch_failed', detail }
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * `web_fetch` jogosultság-kapu (§7.4, WF-N9). A `web_fetch` NEM kerül az általános
 * agent-tool-katalógusba: kizárólag `web_fetch` capabilityvel hívható, amit deny-by-default
 * csak web-egress role agent kap meg (a seed). Más agent → TOOL_NOT_AUTHORIZED.
 */
export function authorizeWebFetch(input: {
  capabilities: readonly string[]
}): { allowed: true } | { allowed: false; reason: 'TOOL_NOT_AUTHORIZED' } {
  return input.capabilities.includes('web_fetch')
    ? { allowed: true }
    : { allowed: false, reason: 'TOOL_NOT_AUTHORIZED' }
}

/**
 * Audit-metaadat egy fetch-eredményből (§11.1) — SOSEM tartalmaz nyers URL-t/tartalmat
 * (WF-N10). A nyers URL-t a hívó adja át külön, hogy a service kimenete önmagában is hash-only.
 */
export function toWebFetchAuditMeta(input: {
  urlHash: string
  host?: string
  sourceType?: WebFetchSourceType
  result: WebFetchResult
}): WebFetchAuditMeta {
  if (input.result.ok) {
    return {
      urlHash: input.result.urlHash,
      host: input.result.host,
      sourceType: input.result.sourceType,
      bytes: input.result.bytes,
      contentHash: input.result.contentHash,
      status: 'ok',
    }
  }
  return {
    urlHash: input.urlHash,
    host: input.host ?? 'unknown',
    sourceType: input.sourceType,
    bytes: 0,
    status: 'blocked',
    reason: input.result.reason,
  }
}
