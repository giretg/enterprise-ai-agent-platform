import assert from 'node:assert/strict'
import { performAuditedWebFetch } from '../src/domain/web-fetch/audited-web-fetch'
import type { WebFetchResult } from '../src/domain/web-fetch/web-fetch-types'
import type { AuditRepository } from '../src/repositories/interfaces'

type AuditAppendInput = Parameters<AuditRepository['append']>[0]

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

type AuditCall = { action: string; policyDecision: string; metadata: unknown; actorId: string; agentVersion: number | null }

function harness(overrides: {
  result: WebFetchResult
  count?: number
  countThrows?: boolean
}) {
  const audits: AuditCall[] = []
  let seenPerAgentDayUsed = -1
  const deps = {
    countRecentAgentFetches: async () => {
      if (overrides.countThrows) throw new Error('db down')
      return overrides.count ?? 0
    },
    webFetch: async (perAgentDayUsed: number) => {
      seenPerAgentDayUsed = perAgentDayUsed
      return overrides.result
    },
    audit: {
      append: async (e: AuditAppendInput) => {
        audits.push({
          action: e.action,
          policyDecision: e.policyDecision ?? '',
          metadata: e.metadata,
          actorId: e.actorId ?? '',
          agentVersion: e.agentVersion,
        })
        return undefined as never
      },
    },
    resolveAgentVersion: async () => 7,
    hashPrefix: (v: string) => `h(${v.length})`,
  }
  return { deps, audits, getSeen: () => seenPerAgentDayUsed }
}

const OK_RESULT: WebFetchResult = {
  ok: true,
  host: 'platform.openai.com',
  sourceType: 'official',
  contentType: 'text/html',
  bytes: 1234,
  contentHash: 'c'.repeat(16),
  urlHash: 'u'.repeat(16),
  text: 'hello',
  truncated: false,
}

async function main() {
  console.log('\n=== Auditált web_fetch nyelő ===')

  await test('AWF-1 sikeres letöltés → web_fetch.request audit hash-only metaadattal', async () => {
    const { deps, audits } = harness({ result: OK_RESULT })
    const res = await performAuditedWebFetch(deps, {
      agentId: 'agent-egress',
      url: 'https://platform.openai.com/docs/secret-path?q=1',
      sourceType: 'official',
    })
    assert.equal(res.ok, true)
    assert.equal(audits.length, 1, 'pontosan egy audit-esemény')
    assert.equal(audits[0]!.action, 'web_fetch.request')
    assert.equal(audits[0]!.policyDecision, 'allowed')
    assert.equal(audits[0]!.actorId, 'agent-egress')
    assert.equal(audits[0]!.agentVersion, 7)
    // Hash-only: a nyers URL SOSEM kerül a metaadatba.
    const metaStr = JSON.stringify(audits[0]!.metadata)
    assert.doesNotMatch(metaStr, /secret-path/, 'nyers URL nem szivároghat auditba')
    assert.match(metaStr, /platform\.openai\.com/, 'a host benne van')
    assert.doesNotMatch(metaStr, /hello/, 'nyers tartalom nem szivároghat')
  })

  await test('AWF-1b hop + contentType megjelenik az audit-metában, nyers URL nélkül', async () => {
    const pdfResult: WebFetchResult = {
      ok: true,
      host: 'platform.openai.com',
      sourceType: 'official',
      contentType: 'application/pdf',
      bytes: 1234,
      contentHash: 'c'.repeat(16),
      urlHash: 'u'.repeat(16),
      text: 'NYERS-PDF-SZOVEG',
      truncated: false,
    }
    const { deps, audits } = harness({ result: pdfResult })
    await performAuditedWebFetch(deps, {
      agentId: 'agent-egress',
      url: 'https://platform.openai.com/docs/secret.pdf',
      sourceType: 'unknown',
      hop: true,
    })
    const meta = audits[0]!.metadata as { contentType?: string; hop?: boolean }
    assert.equal(meta.contentType, 'pdf')
    assert.equal(meta.hop, true)
    assert.doesNotMatch(JSON.stringify(audits[0]!.metadata), /secret\.pdf/)
    assert.doesNotMatch(JSON.stringify(audits[0]!.metadata), /NYERS-PDF-SZOVEG/)
  })

  await test('AWF-2 blokkolt letöltés → web_fetch.blocked audit (nem nyelődik el némán)', async () => {
    const blocked: WebFetchResult = { ok: false, reason: 'ssrf_blocked', detail: 'resolved_private_ip' }
    const { deps, audits } = harness({ result: blocked })
    const res = await performAuditedWebFetch(deps, {
      agentId: 'agent-egress',
      url: 'https://internal.evil.example/x',
      sourceType: 'vendor_doc',
    })
    assert.equal(res.ok, false)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]!.action, 'web_fetch.blocked')
    assert.equal(audits[0]!.policyDecision, 'blocked')
    assert.match(JSON.stringify(audits[0]!.metadata), /ssrf_blocked/)
  })

  await test('AWF-3 a napi felhasznált keret átmegy a fetch-be (keret-kapu érvényesül)', async () => {
    const { deps, getSeen } = harness({ result: OK_RESULT, count: 42 })
    await performAuditedWebFetch(deps, { agentId: 'a', url: 'https://x.example/', sourceType: 'official' })
    assert.equal(getSeen(), 42, 'a perAgentDayUsed a tényleges napi darabszám')
  })

  await test('AWF-4 a számláló hibája fail-soft (0-ra esik, a fetch és az audit lefut)', async () => {
    const { deps, audits, getSeen } = harness({ result: OK_RESULT, countThrows: true })
    const res = await performAuditedWebFetch(deps, { agentId: 'a', url: 'https://x.example/', sourceType: 'official' })
    assert.equal(res.ok, true)
    assert.equal(getSeen(), 0)
    assert.equal(audits.length, 1)
  })

  if (failures > 0) {
    console.error(`\n${failures} auditált web_fetch teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden auditált web_fetch teszt átment')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
