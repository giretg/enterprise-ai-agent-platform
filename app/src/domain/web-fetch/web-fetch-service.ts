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
import { extractHtmlPdfLinks } from './extract-html-links'
import { normalizeFetchUrl } from './normalize-fetch-url'
import { sanitizeFetchedContent } from './content-sanitize'
import {
  DEFAULT_WEB_FETCH_LIMITS,
  WEB_FETCH_ALLOWED_CONTENT_TYPES,
  WEB_FETCH_PDF_CONTENT_TYPE,
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
  /** Injektálható PDF-olvasó (teszthez); alapból a munkaterületi `pdfRead`. */
  readPdf?: (buffer: Buffer) => Promise<{
    text: string
    numPages: number
    truncated: boolean
    notice: string | null
  }>
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
  /** Egyszeri felülírás a service alap maxContentChars limitjére (pl. admin API-doksi letöltés). */
  maxContentChars?: number
  /**
   * Hívásonkénti extra elfogadott content-type (pl. `application/pdf` a kutatási ágon).
   * A megosztott `WEB_FETCH_ALLOWED_CONTENT_TYPES` nem bővül — a provisioning Accept-je
   * bit-azonos marad, ha ez a mező nincs megadva.
   */
  allowedContentTypes?: readonly string[]
  /** Audit: ez a fetch HTML→PDF hop volt-e. */
  hop?: boolean
}

function hashPrefix(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function normalizeUrl(url: string): string | null {
  return normalizeFetchUrl(url)
}

function effectiveAllowedContentTypes(extra?: readonly string[]): string[] {
  return [...new Set([...WEB_FETCH_ALLOWED_CONTENT_TYPES, ...(extra ?? [])])]
}

function contentTypeBase(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase()
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  return allowed.includes(contentTypeBase(contentType))
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF

function isPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.byteLength) return false
  return PDF_MAGIC.every((b, i) => bytes[i] === b)
}

function urlPathIsPdf(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

const EMPTY_PDF_NOTICE =
  'A PDF-ből nem sikerült szöveget kinyerni (kép-alapú, jelszavas vagy sérült fájl lehet).'

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

    const allowedTypes = effectiveAllowedContentTypes(req.allowedContentTypes)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET', // (7) CSAK GET
        redirect: 'manual', // (6) idegen-host redirect tilos
        signal: controller.signal,
        headers: { Accept: allowedTypes.join(', ') },
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

      // (8) Content-type allowlist — a típus-őr a bájtokon is fut (%PDF mágia).
      const contentType = res.headers.get('content-type') ?? ''
      const headerBase = contentTypeBase(contentType)

      // (9) Méret-cap (streamelt) — a mágiához a nyers bájt kell, UTF-8 dekódolás ELŐTT.
      const body = await readBodyCapped(res, this.limits.maxBytes, controller)
      if (!body.ok) return { ok: false, reason: 'too_large' }

      const pdfAllowed = allowedTypes.includes(WEB_FETCH_PDF_CONTENT_TYPE)
      const magic = isPdfMagic(body.bytes)
      const headerIsPdf = headerBase === WEB_FETCH_PDF_CONTENT_TYPE || headerBase === 'application/x-pdf'
      const treatAsPdf =
        pdfAllowed &&
        magic &&
        (headerIsPdf ||
          (urlPathIsPdf(url) &&
            (headerBase === '' ||
              headerBase === 'text/html' ||
              headerBase === 'application/octet-stream' ||
              headerBase === 'binary/octet-stream')))

      if (headerIsPdf && (!pdfAllowed || !magic)) {
        return { ok: false, reason: 'content_type_blocked', detail: headerBase || WEB_FETCH_PDF_CONTENT_TYPE }
      }
      if (treatAsPdf) {
        return this.extractPdf({ bytes: body.bytes, url, host, req })
      }
      if (!contentTypeAllowed(contentType, allowedTypes) || headerIsPdf) {
        return { ok: false, reason: 'content_type_blocked', detail: headerBase }
      }

      const raw = new TextDecoder('utf-8', { fatal: false }).decode(body.bytes)
      const links = /^text\/html\b/i.test(contentType) ? extractHtmlPdfLinks(raw, url) : undefined

      // (10) Sanitizálás + hossz-limit. A nyers HTML nem hagyja el a service-t.
      const maxContentChars = req.maxContentChars ?? this.limits.maxContentChars
      const { text, truncated } = sanitizeFetchedContent({
        raw,
        contentType,
        maxContentChars,
      })

      return {
        ok: true,
        host,
        sourceType: req.sourceType,
        contentType: headerBase,
        bytes: body.bytes.byteLength,
        contentHash: hashPrefix(text),
        urlHash: hashPrefix(url),
        text,
        truncated,
        links,
      }
    } catch (e) {
      const detail = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'request_failed'
      return { ok: false, reason: 'fetch_failed', detail }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async extractPdf(input: {
    bytes: Uint8Array
    url: string
    host: string
    req: WebFetchRequest
  }): Promise<WebFetchResult> {
    const maxContentChars = input.req.maxContentChars ?? this.limits.maxContentChars
    let text = ''
    let truncated = false
    let notice: string | undefined
    let pageCount: number | undefined
    try {
      const result = await this.readPdf(Buffer.from(input.bytes))
      text = result.text
      truncated = result.truncated
      notice = result.notice ?? undefined
      pageCount = result.numPages
    } catch {
      notice = EMPTY_PDF_NOTICE
    }
    if (text.length > maxContentChars) {
      text = text.slice(0, maxContentChars)
      truncated = true
    }
    if (!text.trim()) {
      truncated = true
      notice = notice ?? EMPTY_PDF_NOTICE
    }
    return {
      ok: true,
      host: input.host,
      sourceType: input.req.sourceType,
      contentType: WEB_FETCH_PDF_CONTENT_TYPE,
      bytes: input.bytes.byteLength,
      contentHash: hashPrefix(text),
      urlHash: hashPrefix(input.url),
      text,
      truncated,
      pageCount,
      notice,
    }
  }

  private async readPdf(buffer: Buffer): Promise<{
    text: string
    numPages: number
    truncated: boolean
    notice: string | null
  }> {
    if (this.deps.readPdf) return this.deps.readPdf(buffer)
    const { pdfRead } = await import('@/domain/file-editor/adapters/pdf-adapter')
    return pdfRead(buffer)
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
  hop?: boolean
  result: WebFetchResult
}): WebFetchAuditMeta {
  const hop = input.hop === true
  if (input.result.ok) {
    const mime = input.result.contentType
    return {
      urlHash: input.result.urlHash,
      host: input.result.host,
      sourceType: input.result.sourceType,
      bytes: input.result.bytes,
      contentHash: input.result.contentHash,
      status: 'ok',
      contentType: mime === WEB_FETCH_PDF_CONTENT_TYPE ? 'pdf' : 'html',
      hop,
    }
  }
  return {
    urlHash: input.urlHash,
    host: input.host ?? 'unknown',
    sourceType: input.sourceType,
    bytes: 0,
    status: 'blocked',
    reason: input.result.reason,
    hop,
  }
}
