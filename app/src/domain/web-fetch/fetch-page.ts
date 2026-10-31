/**
 * #1021: egy nyilvános weboldal letöltése SSRF-őrrel.
 *
 * - Csak https, alapértelmezett port, nyers IP / localhost / felhő-metadata host tilos (`matchForbiddenHost`).
 * - A DNS-ellenőrzés a KAPCSOLÓDÁS pillanatában fut (saját `lookup`): privát/reserved cím esetén nincs
 *   kapcsolat. Így nincs rés az ellenőrzés és a letöltés között (DNS-rebinding).
 * - Átirányítás kézzel, ugrásonként újra: URL-forma, SSRF, és a hívó domain-szabálya (`checkRedirect`).
 * - Méret- (kitömörítés UTÁN számolva) és időkorlát; sütit, hitelesítést soha nem küldünk.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPrivateOrReservedIp, matchForbiddenHost } from '@/domain/net/egress-guard'
import { normalizeWebUrl, WebFetchError, type WebFetchTarget } from './web-fetch'

export const WEB_FETCH_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
} as const

export type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Readable }

/** Egy GET kérés (átirányítás követése nélkül); tesztben cserélhető. */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<RawResponse>

export type FetchedPage = {
  finalUrl: string
  host: string
  contentType: string | null
  bytes: Buffer
  redirects: number
}

/** Feloldás utáni ellenőrzés: egyetlen privát/reserved cím is elég a tiltáshoz. */
export function assertPublicAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new WebFetchError('web_fetch_blocked_address', 'dns_no_address')
  if (addresses.some((ip) => isPrivateOrReservedIp(ip))) throw new WebFetchError('web_fetch_blocked_address', 'resolved_private_ip')
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

function publicOnlyLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '')
    try {
      assertPublicAddresses(addresses.map((a) => a.address))
    } catch (error) {
      return callback(error as NodeJS.ErrnoException, '')
    }
    if (options?.all) return callback(null, addresses)
    callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

function decoded(body: Readable, encoding: string | undefined): Readable {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return body.pipe(createGunzip())
    case 'deflate':
      return body.pipe(createInflate())
    case 'br':
      return body.pipe(createBrotliDecompress())
    default:
      return body
  }
}

export const defaultHttpGet: HttpGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        signal,
        lookup: publicOnlyLookup as never,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; ExcellenceAI-WebFetch/1.0)',
          accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.1',
          'accept-language': 'hu-HU,hu;q=0.9,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const body = decoded(res, res.headers['content-encoding'] as string | undefined)
        res.on('error', (error) => body.destroy(error))
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
      },
    )
    req.on('error', reject)
    req.end()
  })

async function readCapped(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > maxBytes) {
      body.destroy()
      throw new WebFetchError('web_fetch_too_large')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function assertFetchableHost(target: WebFetchTarget): void {
  const forbidden = matchForbiddenHost(target.host)
  if (forbidden) throw new WebFetchError('web_fetch_blocked_address', forbidden)
}

export async function fetchWebPage(
  start: WebFetchTarget,
  opts: {
    /** Átirányítási cél domain-szabálya (a hívóé); hibakód = tiltás. */
    checkRedirect: (target: WebFetchTarget) => string | null
    httpGet?: HttpGet
    limits?: Partial<typeof WEB_FETCH_LIMITS>
  },
): Promise<FetchedPage> {
  const limits = { ...WEB_FETCH_LIMITS, ...opts.limits }
  const httpGet = opts.httpGet ?? defaultHttpGet
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs)
  let target = start
  try {
    for (let redirects = 0; ; redirects++) {
      assertFetchableHost(target)
      const res = await httpGet(target.url, controller.signal)
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.body.destroy()
        if (redirects >= limits.maxRedirects) throw new WebFetchError('web_fetch_too_many_redirects')
        let next: WebFetchTarget | null = null
        try {
          next = normalizeWebUrl(new URL(String(res.headers.location), target.url).toString())
        } catch {
          next = null
        }
        if (!next) throw new WebFetchError('web_fetch_blocked_address', 'redirect_invalid_target')
        const denied = opts.checkRedirect(next)
        if (denied) throw new WebFetchError(denied, 'redirect')
        target = next
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        res.body.destroy()
        throw new WebFetchError('web_fetch_failed', `http_${res.status}`)
      }
      const bytes = await readCapped(res.body, limits.maxBytes)
      const contentType = res.headers['content-type']
      return { finalUrl: target.url, host: target.host, contentType: typeof contentType === 'string' ? contentType : null, bytes, redirects }
    }
  } catch (error) {
    if (error instanceof WebFetchError) throw error
    if (controller.signal.aborted) throw new WebFetchError('web_fetch_timeout')
    const cause = error as { code?: string } | null
    if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') throw new WebFetchError('web_fetch_failed', 'dns_not_found')
    throw new WebFetchError('web_fetch_failed', cause?.code ?? 'request_failed')
  } finally {
    clearTimeout(timer)
  }
}
