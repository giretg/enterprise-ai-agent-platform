import assert from 'node:assert/strict'
import { validateWebResearchResult } from '../src/domain/web-research/web-research-validator'
import type { WebResearchResult } from '../src/domain/web-research/web-research-types'

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

function baseResult(overrides: Partial<WebResearchResult> = {}): WebResearchResult {
  return {
    objectiveEcho: 'Mi az OpenAI aktuális API dokumentációs oldala?',
    facts: [
      {
        statement: 'Az API dokumentáció a hivatalos dokumentációs hoston érhető el.',
        sourceIndices: [0],
        confidence: 'medium',
      },
    ],
    sources: [
      {
        urlHash: 'a'.repeat(16),
        host: 'platform.openai.com',
        sourceType: 'official',
        contentHash: 'b'.repeat(16),
        fetchedAt: new Date('2026-07-02T10:00:00.000Z').toISOString(),
      },
    ],
    overallConfidence: 'medium',
    unverified: false,
    provenance: {
      egressRoleAgentId: 'agent-web-egress',
      egressRoleAgentVersion: 1,
      requesterAgentId: 'agent-requester',
      queryHash: 'c'.repeat(16),
      contractVersion: 'web_research/v1',
    },
    ...overrides,
  }
}

async function main() {
  console.log('\n=== WR validátor ===')

  await test('WR-P1 hivatalos forrás átmegy tipizált eredményként', () => {
    const res = validateWebResearchResult(baseResult(), { knownHosts: ['platform.openai.com'] })
    if (res.status === 'failed') throw new Error('unexpected validation failure')
    assert.equal(res.status, 'passed')
    assert.equal(res.result.sources.length, 1)
  })

  await test('WR-P2 news/blog forrás unverified=true és confidence cap', () => {
    const result = baseResult({
      sources: [
        {
          urlHash: 'a'.repeat(16),
          host: 'reuters.com',
          sourceType: 'news',
          contentHash: 'b'.repeat(16),
          fetchedAt: new Date('2026-07-02T10:00:00.000Z').toISOString(),
        },
      ],
      overallConfidence: 'high',
      unverified: false,
    })
    const res = validateWebResearchResult(result, { knownHosts: ['reuters.com'] })
    if (res.status === 'failed') throw new Error('unexpected validation failure')
    assert.equal(res.status, 'warned')
    assert.equal(res.result.unverified, true)
    assert.equal(res.result.overallConfidence, 'medium')
  })

  await test('WR-N1 idegen host elbukik', () => {
    const res = validateWebResearchResult(baseResult(), { knownHosts: ['docs.example.com'] })
    assert.equal(res.status, 'failed')
    assert.match(res.errors.join(','), /unknown_source_host/)
  })

  await test('WR-N1 ismert exfil sink elbukik', () => {
    const result = baseResult({
      sources: [
        {
          urlHash: 'a'.repeat(16),
          host: 'webhook.site',
          sourceType: 'blog',
          contentHash: 'b'.repeat(16),
          fetchedAt: new Date('2026-07-02T10:00:00.000Z').toISOString(),
        },
      ],
      unverified: true,
    })
    const res = validateWebResearchResult(result, { knownHosts: ['webhook.site'] })
    assert.equal(res.status, 'failed')
    assert.match(res.errors.join(','), /forbidden_host:known_exfil_sink/)
  })

  await test('WR-N6 inline secret elbukik', () => {
    const result = baseResult({
      facts: [
        {
          statement: 'A példa kulcs: AKIAABCDEFGHIJKLMNOP',
          sourceIndices: [0],
          confidence: 'low',
        },
      ],
    })
    const res = validateWebResearchResult(result, { knownHosts: ['platform.openai.com'] })
    assert.equal(res.status, 'failed')
    assert.match(res.errors.join(','), /inline_secret/)
  })

  await test('WR-N1 forrás nélküli fact elbukik', () => {
    const result = baseResult({
      facts: [{ statement: 'Nincs provenance.', sourceIndices: [], confidence: 'low' }],
    })
    const res = validateWebResearchResult(result, { knownHosts: ['platform.openai.com'] })
    assert.equal(res.status, 'failed')
  })

  if (failures > 0) {
    console.error(`\n${failures} web research delegation test(s) failed`)
    process.exit(1)
  }
  console.log('\nAll web research delegation tests passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
