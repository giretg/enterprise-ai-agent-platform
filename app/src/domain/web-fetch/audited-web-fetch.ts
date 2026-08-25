/**
 * Egyetlen, KÖTELEZŐEN auditált `web_fetch` egress-nyelő (WebFetch-Egress §11.1/§11.3).
 *
 * A `WebFetchService.fetch` szándékosan NEM ír auditba és NEM számol napi keretet — ezt a
 * hívónak kell megtennie. Korábban ez a felelősség két külön wiring-closure-ban duplázódott
 * (a felfedező hurok ÉS a web-kutatási delegáció), és a delegációs ág KIMARADT belőle: a
 * webre kimenő letöltései sem auditba nem kerültek (`web_fetch.request`/`.blocked`), sem a
 * napi egress-keretet (`perAgentDayUsed`) nem növelték. Ez a modul a közös nyelő, hogy a
 * két út SOSE csússzon szét: minden egress-kísérlet — sikeres ÉS blokkolt — hash-only
 * audit-eseményt kap, és minden sikeres letöltés beleszámít a napi keretbe.
 *
 * Determinisztikusan tesztelhető: minden függés injektált (DB/hálózat nélkül futtatható).
 */
import type { Prisma } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { toWebFetchAuditMeta } from './web-fetch-service'
import type { WebFetchResult, WebFetchSourceType } from './web-fetch-types'

export interface AuditedWebFetchDeps {
  /** A napi (24h) `web_fetch.request` darabszám az agentre — a keret-kapuhoz. */
  countRecentAgentFetches: (agentId: string) => Promise<number>
  /** A tényleges (kontrollált) letöltés; a napi felhasznált keretet a nyelő adja át. */
  webFetch: (perAgentDayUsed: number) => Promise<WebFetchResult>
  /** Audit-nyelő (append-only, hash-lánc). */
  audit: Pick<AuditRepository, 'append'>
  /** Az agent aktuális verziója az audit-attribúcióhoz (nem kritikus, lehet null). */
  resolveAgentVersion: (agentId: string) => Promise<number | null>
  /** SHA-256 prefix (hash-only audit — nyers URL/tartalom SOSEM kerül naplóba). */
  hashPrefix: (value: string) => string
}

export interface AuditedWebFetchInput {
  agentId: string
  url: string
  sourceType?: WebFetchSourceType
  hop?: boolean
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'unknown'
  }
}

/**
 * Megszámolja a napi keretet, elvégzi a letöltést, majd KÖTELEZŐEN naplózza az eredményt
 * (`web_fetch.request` sikerre, `web_fetch.blocked` bukásra) hash-only metaadattal, és
 * visszaadja a fetch eredményét változatlanul.
 */
export async function performAuditedWebFetch(
  deps: AuditedWebFetchDeps,
  input: AuditedWebFetchInput,
): Promise<WebFetchResult> {
  const perAgentDayUsed = await deps.countRecentAgentFetches(input.agentId).catch(() => 0)
  const result = await deps.webFetch(perAgentDayUsed)

  const meta = toWebFetchAuditMeta({
    urlHash: deps.hashPrefix(input.url),
    host: hostFromUrl(input.url),
    sourceType: input.sourceType,
    hop: input.hop,
    result,
  })
  const agentVersion = await deps.resolveAgentVersion(input.agentId).catch(() => null)

  await deps.audit.append({
    actorType: 'agent',
    actorId: input.agentId,
    agentVersion,
    action: result.ok ? 'web_fetch.request' : 'web_fetch.blocked',
    targetType: 'web_fetch',
    targetId: null,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: result.ok ? 'allowed' : 'blocked',
    metadata: meta as unknown as Prisma.JsonValue,
  })

  return result
}
