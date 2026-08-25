/**
 * web_research_request összerakás: fetch-trust, allowlist, hop, knownDomain, fact.
 * Fake search + fake fetch, hálózat nélkül.
 */
import assert from 'node:assert/strict'
import { knownDomainSchema } from '../src/domain/web-research/known-domain'
import {
  findForbiddenAllowedDomain,
  isFetchTrusted,
  mergeResearchAllowlistHosts,
} from '../src/domain/web-research/fetch-trust'
import { KnownUrlRegistry } from '../src/domain/web-research/known-url-registry'
import {
  buildResearchSearchArgs,
  buildWebResearchCandidate,
  filterUsableResearchSources,
  researchPerDiscoveryMax,
  runWebResearchPipeline,
  type ResearchPipelineFetch,
} from '../src/domain/web-research/research-pipeline'
import { validateWebResearchResult } from '../src/domain/web-research/web-research-validator'
import type { WebFetchResult } from '../src/domain/web-fetch/web-fetch-types'
import type { WebSearchResultItem, WebSearchSourceType } from '../src/domain/web-search/web-search-types'

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

function item(
  url: string,
  sourceType: WebSearchSourceType,
  title = 'találat',
): WebSearchResultItem {
  const domain = new URL(url).hostname.toLowerCase()
  return {
    rank: 1,
    title,
    url,
    displayUrl: domain,
    domain,
    snippet: 'snippet',
    retrievedAt: new Date().toISOString(),
    sourceType,
    policyLabels: [],
  }
}

function okHtml(text: string, host: string, links: Array<{ url: string; text: string }> = []): WebFetchResult {
  return {
    ok: true,
    host,
    sourceType: 'unknown',
    contentType: 'text/html',
    bytes: text.length,
    contentHash: 'h'.repeat(16),
    urlHash: 'u'.repeat(16),
    text,
    links,
  }
}

function okPdf(text: string, host: string, extra: Partial<Extract<WebFetchResult, { ok: true }>> = {}): WebFetchResult {
  return {
    ok: true,
    host,
    sourceType: 'unknown',
    contentType: 'application/pdf',
    bytes: 100,
    contentHash: 'p'.repeat(16),
    urlHash: 'q'.repeat(16),
    text,
    truncated: false,
    ...extra,
  }
}

type FetchCall = {
  url: string
  extraAllowlistHosts: string[]
  hop: boolean
  allowedSourceUrls: string[]
  fetchIndex: number
  perDiscoveryMax: number
}

function makeFetch(pages: Record<string, WebFetchResult>): {
  fetch: ResearchPipelineFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (input) => {
      calls.push({
        url: input.url,
        extraAllowlistHosts: [...input.extraAllowlistHosts],
        hop: input.hop,
        allowedSourceUrls: [...input.allowedSourceUrls],
        fetchIndex: input.fetchIndex,
        perDiscoveryMax: input.perDiscoveryMax,
      })
      return pages[input.url] ?? { ok: false, reason: 'fetch_failed', detail: 'http_404' }
    },
  }
}

const BANK = 'https://www.otpbank.hu/hirdetmenyek'
const BANK_PDF = 'https://www.otpbank.hu/hirdetmeny.pdf'
const MNB = 'https://www.mnb.hu/statisztika'
const FOREIGN_PDF = 'https://evil.example/x.pdf'
const NEWS = 'https://index.hu/gazdasag/cikk'

async function main() {
  console.log('\n=== Fetch-trust predikátum ===')

  await test('official host allowlist nélkül is trusted', () => {
    assert.equal(
      isFetchTrusted({ host: 'www.mnb.hu', sourceType: 'official', policy: { allowedDomains: [], deniedDomains: [] } }),
      true,
    )
  })

  await test('unknown bank host allowlist nélkül NEM trusted', () => {
    assert.equal(
      isFetchTrusted({
        host: 'www.otpbank.hu',
        sourceType: 'unknown',
        policy: { allowedDomains: [], deniedDomains: [] },
      }),
      false,
    )
  })

  await test('unknown bank host az allowlisten trusted, sourceType marad unknown', () => {
    assert.equal(
      isFetchTrusted({
        host: 'www.otpbank.hu',
        sourceType: 'unknown',
        policy: { allowedDomains: ['*.otpbank.hu'], deniedDomains: [] },
      }),
      true,
    )
  })

  await test('*.otpbank.hu nem fedi a csupasz apexet', () => {
    assert.equal(
      isFetchTrusted({
        host: 'otpbank.hu',
        sourceType: 'unknown',
        policy: { allowedDomains: ['*.otpbank.hu'], deniedDomains: [] },
      }),
      false,
    )
  })

  await test('allowGeneralWeb nem része a predikátumnak — nem hivatalos host üres allowlisten nem trusted', () => {
    assert.equal(
      isFetchTrusted({
        host: 'example.com',
        sourceType: 'unknown',
        policy: { allowedDomains: [], deniedDomains: [] },
      }),
      false,
    )
  })

  await test('deny nyer az allowlist felett', () => {
    assert.equal(
      isFetchTrusted({
        host: 'www.otpbank.hu',
        sourceType: 'unknown',
        policy: { allowedDomains: ['*.otpbank.hu'], deniedDomains: ['*.otpbank.hu'] },
      }),
      false,
    )
  })

  await test('mergeResearchAllowlistHosts nem ír platform-listát, csak uniót ad', () => {
    const platform = ['docs.example.com']
    const merged = mergeResearchAllowlistHosts(platform, ['www.mnb.hu', 'docs.example.com'])
    assert.deepEqual(merged.sort(), ['docs.example.com', 'www.mnb.hu'].sort())
    assert.deepEqual(platform, ['docs.example.com'])
  })

  await test('allowedDomains SSRF-gyanús minták elutasítva', () => {
    for (const pattern of ['127.0.0.1', 'localhost', '169.254.169.254', '*.internal']) {
      const hit = findForbiddenAllowedDomain([pattern])
      assert.ok(hit, pattern)
    }
    assert.equal(findForbiddenAllowedDomain(['otpbank.hu']), null)
  })

  await test('knownDomain hostname-séma: site: injekció és OR elutasítva', () => {
    assert.equal(knownDomainSchema.safeParse('otpbank.hu').success, true)
    assert.equal(knownDomainSchema.safeParse('*.otpbank.hu').success, true)
    assert.equal(knownDomainSchema.safeParse('x OR y').success, false)
    assert.equal(knownDomainSchema.safeParse('https://otpbank.hu').success, false)
    assert.equal(knownDomainSchema.safeParse('otpbank.hu#x').success, false)
  })

  await test('knownDomain a query-be nem fűződik; a site: a domains argumentumon át hat', () => {
    const args = buildResearchSearchArgs({
      objective: 'OTP hirdetmény',
      knownDomain: 'otpbank.hu',
      maxSources: 4,
    })
    assert.equal(args.query, 'OTP hirdetmény')
    assert.ok(!args.query.includes('site:'))
    assert.deepEqual(args.domains, ['otpbank.hu'])
  })

  console.log('\n=== Usable-szűrő + pipeline ===')

  const bankPolicy = { allowedDomains: ['*.otpbank.hu', 'otpbank.hu'], deniedDomains: [] }
  const emptyPolicy = { allowedDomains: [] as string[], deniedDomains: [] as string[] }
  const types = ['official', 'vendor_doc', 'news', 'blog', 'unknown'] as const

  await test('unknown bank host allowlist nélkül → nincs usable, nincs fetch', async () => {
    const usable = filterUsableResearchSources({
      results: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      policy: emptyPolicy,
      maxSources: 4,
    })
    assert.equal(usable.length, 0)
    const { fetch, calls } = makeFetch({})
    const pipeline = await runWebResearchPipeline({
      objective: 'OTP hirdetmény',
      searchResults: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: emptyPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 0)
    assert.equal(calls.length, 0)
  })

  await test('ugyanaz a host az allowlisten → HTML fetch ok, sourceType unknown marad', async () => {
    const { fetch, calls } = makeFetch({
      [BANK]: okHtml('Hatályos hirdetmény szövege', 'www.otpbank.hu'),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'OTP hirdetmény',
      searchResults: [item(BANK, 'unknown', 'OTP hirdetmények')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    assert.equal(pipeline.fetched[0]!.sourceType, 'unknown')
    assert.ok(calls[0]!.extraAllowlistHosts.includes('www.otpbank.hu'))
  })

  await test('official host (mnb.hu) nincs a platform-listán → extraAllowlistHosts-ba bekerül', async () => {
    const { fetch, calls } = makeFetch({
      [MNB]: okHtml('MNB statisztika', 'www.mnb.hu'),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'MNB kamat',
      searchResults: [item(MNB, 'official')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: emptyPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    assert.ok(calls[0]!.extraAllowlistHosts.includes('www.mnb.hu'))
  })

  await test('HTML listázó + same-host PDF href → a PDF allowedSourceUrls-be kerül és letöltődik', async () => {
    const { fetch, calls } = makeFetch({
      [BANK]: okHtml('lista', 'www.otpbank.hu', [{ url: BANK_PDF, text: 'Hirdetmény 2026' }]),
      [BANK_PDF]: okPdf('THM 12,5%', 'www.otpbank.hu', { truncated: true, pageCount: 20 }),
    })
    const registry = new KnownUrlRegistry()
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény 2026 THM',
      searchResults: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry,
    })
    assert.equal(pipeline.fetched.length, 2)
    assert.equal(pipeline.fetched[1]!.hop, true)
    assert.equal(pipeline.fetched[1]!.contentType, 'pdf')
    const hopCall = calls.find((c) => c.hop)
    assert.ok(hopCall)
    assert.ok(hopCall!.allowedSourceUrls.includes(BANK_PDF))
    assert.equal(registry.has(BANK_PDF), true)
    assert.equal(registry.has(`${BANK_PDF}#page=3`), true)
  })

  await test('HTML listázó + idegen host PDF → nincs hálózati hívás arra a hostra', async () => {
    const { fetch, calls } = makeFetch({
      [BANK]: okHtml('lista', 'www.otpbank.hu', [{ url: FOREIGN_PDF, text: 'csali' }]),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény',
      searchResults: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    assert.ok(!calls.some((c) => c.url === FOREIGN_PDF))
  })

  await test('news szülőről nincs PDF-hop', async () => {
    const { fetch, calls } = makeFetch({
      [NEWS]: okHtml('cikk', 'index.hu', [{ url: 'https://index.hu/doc.pdf', text: 'pdf' }]),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény',
      searchResults: [item(NEWS, 'news')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: { allowedDomains: ['index.hu'], deniedDomains: [] },
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    assert.ok(!calls.some((c) => c.hop))
  })

  await test('hop 404 mellett sikeres HTML → a kutatás ok, fact a HTML-ből', async () => {
    const { fetch } = makeFetch({
      [BANK]: okHtml('Hatályos lista dátuma: 2026. május', 'www.otpbank.hu', [
        { url: BANK_PDF, text: 'Hirdetmény' },
      ]),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény',
      searchResults: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    const candidate = buildWebResearchCandidate({
      objective: 'hirdetmény',
      fetched: pipeline.fetched,
      egressRoleAgentId: 'egress',
      requesterAgentId: 'req',
      queryHash: 'q'.repeat(16),
    })
    assert.match(candidate.facts[0]!.statement, /Hatályos lista/)
    assert.ok(!candidate.facts[0]!.statement.startsWith('találat:'))
  })

  await test('maxSources kimerítve + hop → a hop lefut, perDiscoveryMax = maxSources + 2', async () => {
    const { fetch, calls } = makeFetch({
      [BANK]: okHtml('lista', 'www.otpbank.hu', [{ url: BANK_PDF, text: 'Hirdetmény 2026' }]),
      [BANK_PDF]: okPdf('THM', 'www.otpbank.hu'),
    })
    await runWebResearchPipeline({
      objective: 'hirdetmény 2026',
      searchResults: [item(BANK, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 1,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.hop, true)
    assert.equal(calls[1]!.fetchIndex, 1)
    assert.equal(calls[1]!.perDiscoveryMax, researchPerDiscoveryMax(1))
    assert.equal(researchPerDiscoveryMax(8), 10)
  })

  await test('kereső közvetlen PDF URL, fetch-trusted host → ok hop nélkül', async () => {
    const { fetch, calls } = makeFetch({
      [BANK_PDF]: okPdf('közvetlen PDF', 'www.otpbank.hu'),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény',
      searchResults: [item(BANK_PDF, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    assert.equal(pipeline.fetched[0]!.hop, false)
    assert.ok(!calls.some((c) => c.hop))
  })

  await test('kép-only PDF → ok üres szöveggel, nem üres fetched lista', async () => {
    const { fetch } = makeFetch({
      [BANK_PDF]: okPdf('', 'www.otpbank.hu', { notice: 'nincs OCR', truncated: true }),
    })
    const pipeline = await runWebResearchPipeline({
      objective: 'hirdetmény',
      searchResults: [item(BANK_PDF, 'unknown')],
      allowedSourceTypes: [...types],
      maxSources: 4,
      policy: bankPolicy,
      fetch,
      registry: new KnownUrlRegistry(),
    })
    assert.equal(pipeline.fetched.length, 1)
    const candidate = buildWebResearchCandidate({
      objective: 'hirdetmény',
      fetched: pipeline.fetched,
      egressRoleAgentId: 'egress',
      requesterAgentId: 'req',
      queryHash: 'q'.repeat(16),
    })
    assert.equal(candidate.facts[0]!.statement, '')
    assert.ok(candidate.sources[0]!.notice)
    const validated = validateWebResearchResult(candidate, { knownHosts: ['www.otpbank.hu'] })
    assert.notEqual(validated.status, 'failed')
  })

  await test('fact ≤ 4000, nem tartalmazza a címet; unknown → unverified + confidence cap', () => {
    const long = 'x'.repeat(5000)
    const candidate = buildWebResearchCandidate({
      objective: 'hirdetmény',
      fetched: [
        {
          url: BANK,
          title: 'OTP hirdetmények — ne legyen a statementben',
          host: 'www.otpbank.hu',
          sourceType: 'unknown',
          text: long,
          contentHash: 'h'.repeat(16),
          contentType: 'html',
          truncated: true,
          hop: false,
        },
      ],
      egressRoleAgentId: 'egress',
      requesterAgentId: 'req',
      queryHash: 'q'.repeat(16),
    })
    assert.equal(candidate.facts[0]!.statement.length, 4000)
    assert.ok(!candidate.facts[0]!.statement.includes('OTP hirdetmények'))
    assert.equal(candidate.unverified, true)
    const validated = validateWebResearchResult(
      { ...candidate, overallConfidence: 'high', unverified: false },
      { knownHosts: ['www.otpbank.hu'] },
    )
    if (validated.status === 'failed') throw new Error(validated.errors.join(','))
    assert.equal(validated.result.unverified, true)
    assert.equal(validated.result.overallConfidence, 'medium')
  })

  if (failures > 0) {
    console.error(`\n${failures} web-research-pipeline teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden web-research-pipeline teszt zöld.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
