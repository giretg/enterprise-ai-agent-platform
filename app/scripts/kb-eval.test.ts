/**
 * Determinisztikus teszt a KB-v3 §15 eval-harnesshez (`generateEvalCases` +
 * `evaluateRetrieval`). DB NÉLKÜL fut: a retrieval-függvény a VALÓDI
 * `assembleKbHits` assemblert hívja, egy tiszta, in-memory chunk-„searcher"
 * elé kötve (ez a Postgres `searchChunks` ts_rank-szerződését utánozza). Így az
 * eval-metrikák (navigációs helyesség / source-link helyesség / no-answer
 * precízió / latency) izoláltan igazolhatók a termelési assembler ellen.
 *
 * Futtatás: npm run test:kb-eval
 */
import assert from 'node:assert/strict'
import {
  generateEvalCases,
  evaluateRetrieval,
  formatEvalReport,
  DEFAULT_NEGATIVE_QUERIES,
  type EvalHit,
  type EvalSourceChunk,
} from '../src/lib/kb-eval'
import { assembleKbHits } from '../src/domain/tool-broker/tool-broker-service'
import type { KnowledgeChunkSearchHit } from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

// Egy kis published OKF-korpusz (2 oldal, formátumfüggő forrás-locusszal).
const CORPUS: EvalSourceChunk[] = [
  {
    path: 'pages/01-remote-work.md',
    title: 'Remote Work Policy',
    text: 'Employees may request remote work if the role allows it. Approval is required from the manager.',
    sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 3 },
  },
  {
    path: 'pages/02-onboarding.md',
    title: 'Onboarding',
    text: 'Onboarding steps for new hires: accounts, equipment, first-day checklist.',
    sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.docx', section: 'Onboarding' },
  },
]

/**
 * Tiszta in-memory chunk-searcher: token-átfedés szerint pontoz (a Postgres
 * `searchChunks` ts_rank-szerződését utánozza), és `KnowledgeChunkSearchHit[]`-et
 * ad — pontosan azt, amit az `assembleKbHits` `okfChunkHits`-ként vár.
 */
function inMemorySearch(query: string, corpus: EvalSourceChunk[]): KnowledgeChunkSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return corpus
    .map((chunk) => {
      const haystack = `${chunk.title} ${chunk.text}`.toLowerCase()
      const score = terms.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0)
      return { chunk, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({
      artifactId: 'art-1',
      connectorId: 'kb-conn-1',
      path: r.chunk.path,
      title: r.chunk.title,
      type: 'Section',
      section: r.chunk.sourceRef?.section ?? r.chunk.title,
      text: r.chunk.text,
      sourceRef: r.chunk.sourceRef,
      score: r.score,
    }))
}

/** A retrieval-út a teszthez: searcher → VALÓDI assembleKbHits. */
function retrieve(query: string): EvalHit[] {
  return assembleKbHits({
    query,
    k: 5,
    memoryContent: '',
    memoryId: 'mem-1',
    memoryVersion: null,
    okfChunkHits: inMemorySearch(query, CORPUS),
    docs: [],
    supersededDocIds: new Set(),
  })
}

async function run() {
  console.log('=== KB-v3 §15 eval-harness teszt ===')

  await check('generateEvalCases: oldalanként egy pozitív + a negatívok', () => {
    const cases = generateEvalCases({ chunks: CORPUS })
    const pos = cases.filter((c) => c.kind === 'positive')
    const neg = cases.filter((c) => c.kind === 'negative')
    assert.equal(pos.length, 2, 'oldalanként egy pozitív eset')
    assert.equal(neg.length, DEFAULT_NEGATIVE_QUERIES.length, 'default negatívok')
    assert.deepEqual(pos[0].expectedPaths, ['pages/01-remote-work.md'])
    assert.equal(pos[0].expectedSource?.page, 3, 'PDF oldal-locus a várt forrásban')
    assert.equal(pos[1].expectedSource?.section, 'Onboarding', 'DOCX section-locus')
    assert.equal(pos[0].query, 'remote work policy', 'a lekérdezés a cím tokenjei')
  })

  await check('generateEvalCases: az index.md nem lesz eval-eset', () => {
    const cases = generateEvalCases({
      chunks: [{ path: 'index.md', title: 'KB', text: 'nav', sourceRef: null }, ...CORPUS],
    })
    assert.ok(!cases.some((c) => c.expectedPaths.includes('index.md')))
  })

  await check('evaluateRetrieval: tiszta korpuszon 100% nav + source + no-answer', async () => {
    const cases = generateEvalCases({ chunks: CORPUS })
    const report = await evaluateRetrieval({ cases, retrieve })
    assert.equal(report.navigationCorrectness, 1, 'mindkét pozitív a jó oldalra jut')
    assert.equal(report.retrievalRecall, 1, 'minden pozitívra jött találat')
    assert.equal(report.sourceLinkCorrectness, 1, 'a top-hit a helyes forrás-locusra mutat')
    assert.equal(report.noAnswerPrecision, 1, 'a negatívokra helyesen tartózkodik')
    assert.equal(report.positives, 2)
    assert.equal(report.negatives, DEFAULT_NEGATIVE_QUERIES.length)
    assert.ok(report.latency.avgMs >= 0)
  })

  await check('evaluateRetrieval: rossz oldalra navigálás → nav és source bukik', async () => {
    // Olyan retrieve, ami MINDIG a rossz oldalt adja vissza elöl.
    const wrong = (): EvalHit[] => [
      {
        path: 'pages/99-wrong.md',
        score: 1,
        source: { documentId: 'doc-okf', filename: 'x.pdf', page: 99 },
      },
    ]
    const cases = generateEvalCases({ chunks: CORPUS, negativeQueries: [] })
    const report = await evaluateRetrieval({ cases, retrieve: wrong })
    assert.equal(report.navigationCorrectness, 0, 'egyik oldal sem stimmel')
    assert.equal(report.retrievalRecall, 1, 'jött találat, csak rossz')
    assert.equal(report.sourceLinkCorrectness, 1, 'nincs nav-helyes eset → vacuously 1')
  })

  await check('evaluateRetrieval: jó oldal, rossz forrás-oldal → source-link bukik', async () => {
    // A helyes path, de rossz oldalszám a forrásban (§3.3 a kritikus metrika).
    const badSource = (query: string): EvalHit[] => {
      const hits = inMemorySearch(query, CORPUS)
      if (hits.length === 0) return []
      return [
        {
          path: hits[0].path,
          score: hits[0].score,
          source: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 999 },
        },
      ]
    }
    const cases = generateEvalCases({ chunks: [CORPUS[0]], negativeQueries: [] })
    const report = await evaluateRetrieval({ cases, retrieve: badSource })
    assert.equal(report.navigationCorrectness, 1, 'a helyes oldalra jutott')
    assert.equal(report.sourceLinkCorrectness, 0, 'de rossz oldalra mutat a forrás-link')
  })

  await check('evaluateRetrieval: no-answer precízió — küszöb feletti zaj rossz tartózkodás', async () => {
    // Negatívra is ad küszöb feletti találatot → hibás „válasz".
    const noisy = (): EvalHit[] => [{ path: 'pages/01-remote-work.md', score: 5 }]
    const cases = generateEvalCases({ chunks: [], negativeQueries: ['bármi'] })
    const report = await evaluateRetrieval({ cases, retrieve: noisy, confidenceThreshold: 1 })
    assert.equal(report.noAnswerPrecision, 0, 'a küszöb feletti találat = hibás válasz')
  })

  await check('evaluateRetrieval: token-költség aggregálódik, ha a retrieve adja', async () => {
    const withCost = (query: string) => ({ hits: inMemorySearch(query, CORPUS).map((h) => ({ path: h.path, score: h.score })), tokenCost: 10 })
    const cases = generateEvalCases({ chunks: CORPUS })
    const report = await evaluateRetrieval({ cases, retrieve: withCost })
    assert.equal(report.tokenCost, report.total * 10, 'esetenként 10 token összegződik')
  })

  await check('formatEvalReport: olvasható összegzés a fő metrikákkal', async () => {
    const cases = generateEvalCases({ chunks: CORPUS })
    const report = await evaluateRetrieval({ cases, retrieve })
    const text = formatEvalReport(report)
    assert.ok(text.includes('navigációs helyesség'))
    assert.ok(text.includes('source-link helyesség'))
    assert.ok(text.includes('no-answer precízió'))
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
