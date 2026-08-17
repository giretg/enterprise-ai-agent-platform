import { guardEgressUrl } from '@/domain/net/egress-guard'
import {
  archiveUrlForRef,
  normalizeSkillSourceUrl,
  skillImportAllowlistHosts,
  SkillSourceUrlError,
  type NormalizedSkillSource,
} from '@/lib/skill/skill-package-source'

/**
 * Skill-csomag letöltő (import „URL-behúzás” ág).
 *
 * A kontrollok sorrendje — mind determinisztikus, egyik sem az LLM-re bízott:
 *   1. forrás-URL normalizálás (`skill-package-source`) → előre kiszámolt archívum-URL;
 *   2. `guardEgressUrl`: https-kényszer, SSRF host-minta, deny-by-default allowlist,
 *      feloldás-utáni privát-IP re-check (DNS-rebinding);
 *   3. `redirect: 'manual'` — NULLA átirányítás; a cél-URL-t mi számoltuk ki, tehát
 *      egy 30x már csak elterelés lehet;
 *   4. időzár (AbortController) és streamelt méret-cap;
 *   5. ZIP magic-byte ellenőrzés — a content-type fejlécnél erősebb bizonyíték.
 *
 * A service nem ír auditba: a hívó (`SkillService`) naplóz, így a determinisztikus
 * tesztek DB és hálózat nélkül futnak (injektált `fetchImpl`).
 */

export const SKILL_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export type SkillPackageFetchFailure =
  | { reason: 'invalid_source'; detail: string }
  | { reason: 'egress_blocked'; detail: string }
  | { reason: 'not_found'; detail: string }
  | { reason: 'fetch_failed'; detail: string }
  | { reason: 'too_large'; detail: string }
  | { reason: 'not_an_archive'; detail: string }

export type SkillPackageFetchResult =
  | { ok: true; bytes: Uint8Array; source: NormalizedSkillSource; archiveUrl: string }
  | ({ ok: false } & SkillPackageFetchFailure)

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface SkillPackageFetcherDeps {
  fetchImpl?: FetchLike
  resolveHostIps?: (host: string) => Promise<string[]>
  allowlistHosts?: string[]
  maxBytes?: number
}

function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

async function readCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort()
    return { ok: false }
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.byteLength > maxBytes ? { ok: false } : { ok: true, bytes: buf }
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
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged }
}

export class SkillPackageFetcher {
  private readonly maxBytes: number

  constructor(private deps: SkillPackageFetcherDeps = {}) {
    this.maxBytes = deps.maxBytes ?? SKILL_ARCHIVE_MAX_BYTES
  }

  async fetchArchive(rawUrl: string): Promise<SkillPackageFetchResult> {
    let source: NormalizedSkillSource
    try {
      source = normalizeSkillSourceUrl(rawUrl)
    } catch (e) {
      const detail = e instanceof SkillSourceUrlError ? e.message : 'Érvénytelen forrás-URL.'
      return { ok: false, reason: 'invalid_source', detail }
    }

    // A ref-jelöltek az „adott ág nem létezik” esetre valók (main → master). Ha az
    // admin konkrét ágat adott meg, egyetlen próbálkozás van — nem találgatunk helyette.
    const candidates =
      source.refCandidates.length > 1
        ? source.refCandidates.map((ref) => archiveUrlForRef(source.archiveUrl, ref))
        : [source.archiveUrl]

    let lastFailure: SkillPackageFetchFailure = {
      reason: 'not_found',
      detail: 'A megadott forráson nem találtunk letölthető csomagot.',
    }

    for (const archiveUrl of candidates) {
      const attempt = await this.fetchOne(archiveUrl)
      if (attempt.ok) return { ok: true, bytes: attempt.bytes, source, archiveUrl }
      lastFailure = attempt
      // Csak a „nincs ilyen ág” esetén megyünk tovább; egress- vagy méret-hibánál
      // a további próbálkozás értelmetlen és félrevezető naplót írna.
      if (attempt.reason !== 'not_found') break
    }

    return { ok: false, ...lastFailure }
  }

  private async fetchOne(
    archiveUrl: string,
  ): Promise<({ ok: true; bytes: Uint8Array }) | ({ ok: false } & SkillPackageFetchFailure)> {
    const guard = await guardEgressUrl({
      url: archiveUrl,
      allowlistHosts: this.deps.allowlistHosts ?? skillImportAllowlistHosts(),
      ...(this.deps.resolveHostIps ? { resolveHostIps: this.deps.resolveHostIps } : {}),
    })
    if (!guard.ok) {
      return { ok: false, reason: 'egress_blocked', detail: guard.detail ?? guard.reason }
    }

    const fetchImpl = this.deps.fetchImpl ?? (globalThis.fetch as FetchLike)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(guard.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/zip' },
      })

      if (res.status === 404) {
        return { ok: false, reason: 'not_found', detail: `HTTP 404 — ${archiveUrl}` }
      }
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return {
          ok: false,
          reason: 'fetch_failed',
          detail: 'A forrás átirányítana — biztonsági okból nem követjük. Add meg a végleges .zip címet.',
        }
      }
      if (!res.ok) {
        return { ok: false, reason: 'fetch_failed', detail: `HTTP ${res.status}` }
      }

      const body = await readCapped(res, this.maxBytes, controller)
      if (!body.ok) {
        return {
          ok: false,
          reason: 'too_large',
          detail: `A csomag nagyobb, mint ${Math.round(this.maxBytes / (1024 * 1024))} MB.`,
        }
      }
      if (!isZipArchive(body.bytes)) {
        return { ok: false, reason: 'not_an_archive', detail: 'A letöltött tartalom nem ZIP-csomag.' }
      }
      return { ok: true, bytes: body.bytes }
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'ismeretlen hálózati hiba'
      return { ok: false, reason: 'fetch_failed', detail }
    } finally {
      clearTimeout(timer)
    }
  }
}
