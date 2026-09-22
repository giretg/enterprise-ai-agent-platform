/**
 * Determinisztikus teszt a KB-v3 §10 retrieval-összeállításhoz (`assembleKbHits`)
 * és a full-text tsquery-építőhöz (`toKbTsQuery`). DB NÉLKÜL fut — a `searchChunks`
 * Postgres-oldali eredményét kész `KnowledgeChunkSearchHit[]`-ként adjuk be, így a
 * merge / superseded / fallback / citation logika izoláltan igazolható.
 *
 * Futtatás: npm run test:kb-retrieval
 */
import assert from 'node:assert/strict'
import {
  assembleKbCatalog,
  assembleKbDocument,
  assembleKbHits,
  assembleKbIndex,
  assembleKbPage,
  KB_DOCUMENT_INLINE_CHARS,
  mergeKbHits,
  okfIndexFile,
} from '../src/lib/kb-retrieval'
import { toKbTsQuery } from '../src/repositories/postgres/knowledge-repository'
import type {
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
} from '../src/repositories/interfaces'

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

function okfChunk(over: Partial<KnowledgeChunkSearchHit> = {}): KnowledgeChunkSearchHit {
  return {
    artifactId: 'art-1',
    connectorId: 'kb-conn-1',
    path: 'pages/01-remote-work.md',
    title: 'Remote Work Policy',
    type: 'Section',
    section: 'Remote Work Policy',
    text: 'Employees may request remote work if the role allows it.',
    sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 3 },
    score: 0.9,
    ...over,
  }
}

async function run() {
  console.log('=== KB-v3 retrieval (assembleKbHits / toKbTsQuery) teszt ===')

  await check('OKF chunk-találat elöl, navigálható path + oldal-szintű forrás-linkkel', () => {
    const hits = assembleKbHits({
      query: 'remote work',
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: 2,
      okfChunkHits: [okfChunk()],
      docs: [],
      supersededDocIds: new Set(),
    })
    assert.equal(hits.length, 1)
    const [hit] = hits
    assert.equal(hit.path, 'pages/01-remote-work.md', 'OKF path a citationben')
    assert.equal(hit.title, 'Remote Work Policy')
    assert.equal(hit.source?.page, 3, 'oldal-szintű forrás (§4.7)')
    assert.equal(hit.source?.filename, 'hr-remote-policy.pdf')
    assert.equal(hit.docId, 'doc:doc-okf', 'docId a forrásdokumentumra mutat')
    // A sourceRef végén a fájlnév (legacy /:([^:]+)$/ kinyerés kompatibilitás).
    assert.ok(hit.sourceRef.endsWith(':hr-remote-policy.pdf'))
    assert.equal(hit.memoryVersion, null)
  })

  await check('OKF-találatok elöl, a maradék helyet a legacy (memória) tölti k-ig', () => {
    const hits = assembleKbHits({
      query: 'remote work szabály',
      k: 3,
      memoryContent: 'Remote work szabály: a vezető jóváhagyása kell.',
      memoryId: 'mem-1',
      memoryVersion: 4,
      okfChunkHits: [okfChunk()],
      docs: [],
      supersededDocIds: new Set(),
    })
    assert.ok(hits.length >= 2, 'OKF + memória is bekerül')
    assert.equal(hits[0].path, 'pages/01-remote-work.md', 'OKF elöl')
    assert.ok(
      hits.some((h) => h.memoryVersion === 4),
      'a memória-találat is megjelenik a maradék helyen',
    )
  })

  await check('§10.5 superseded: publikált OKF-dokumentum nyers extractedText-je NEM jön vissza', () => {
    const hits = assembleKbHits({
      query: 'remote work',
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: 1,
      okfChunkHits: [okfChunk()],
      docs: [
        // Ugyanaz a forrásdokumentum nyersen — superseded, ki kell hagyni.
        { id: 'doc-okf', filename: 'hr-remote-policy.pdf', extractedText: 'remote work raw text' },
      ],
      supersededDocIds: new Set(['doc-okf']),
    })
    // Csak az OKF-találat marad; a nyers doc nem duplázódik.
    assert.equal(hits.length, 1)
    assert.equal(hits[0].path, 'pages/01-remote-work.md')
    assert.ok(
      !hits.some((h) => h.sourceRef.startsWith('doc:doc-okf:')),
      'a nyers doc-találat kimarad',
    )
  })

  await check('nem-superseded nyers dokumentum legacy stem-scoringgal visszajön', () => {
    const hits = assembleKbHits({
      query: 'onboarding',
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: 1,
      okfChunkHits: [],
      docs: [{ id: 'doc-2', filename: 'guide.md', extractedText: 'Onboarding steps for new hires.' }],
      supersededDocIds: new Set(),
    })
    assert.ok(hits.length >= 1)
    assert.equal(hits[0].docId, 'doc:doc-2')
    assert.equal(hits[0].path, undefined, 'legacy találatnak nincs OKF path')
  })

  await check('fallback: chunk-egyezés nélkül teljes-korpusz (substring) találat', () => {
    // A legacy stem-scoring tokenenként dolgozik (stem = első 4 karakter), így a
    // hosszú szón BELÜLI egyezést nem találja meg; a fallback `includes(stem)`
    // substring-illesztése viszont igen — pontosan erre való a fallback-ág.
    const hits = assembleKbHits({
      query: 'establishment',
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: 1,
      okfChunkHits: [],
      docs: [{ id: 'doc-3', filename: 'x.md', extractedText: 'antidisestablishmentarianism policy' }],
      supersededDocIds: new Set(),
    })
    assert.equal(hits.length, 1, 'a fallback substring-egyezéssel talál')
    assert.equal(hits[0].docId, 'doc:doc-3')
    assert.equal(hits[0].path, undefined, 'fallback-találat legacy alakú (nincs OKF path)')
  })

  await check('nincs találat sehol → üres hits', () => {
    const hits = assembleKbHits({
      query: 'teljesenmasismeretlen',
      k: 5,
      memoryContent: 'valami egészen más',
      memoryId: 'mem-1',
      memoryVersion: 1,
      okfChunkHits: [],
      docs: [{ id: 'doc-4', filename: 'x.md', extractedText: 'y' }],
      supersededDocIds: new Set(),
    })
    assert.equal(hits.length, 0)
  })

  await check('OKF section fallback: ha sourceRef-ben nincs section, a chunk.section-t használja', () => {
    const hits = assembleKbHits({
      query: 'onboarding',
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: 1,
      okfChunkHits: [
        okfChunk({
          section: 'Onboarding',
          sourceRef: { documentId: 'doc-x', filename: 'kezikonyv.docx' },
          text: 'Onboarding steps here.',
        }),
      ],
      docs: [],
      supersededDocIds: new Set(),
    })
    assert.equal(hits[0].source?.section, 'Onboarding', 'DOCX section-szintű forrás (§4.7)')
    assert.equal(hits[0].source?.page, undefined)
  })

  // ── toKbTsQuery ───────────────────────────────────────────────────────────

  await check('toKbTsQuery: prefix-OR kifejezés, kisbetűsítve, ékezettartással', () => {
    assert.equal(toKbTsQuery('Remote Work'), 'remote:* | work:*')
    // Ékezet MEGMARAD (a simple tsvector sem ékezettelenít — a két oldalnak egyeznie kell).
    assert.equal(toKbTsQuery('Szabályzat'), 'szabályzat:*')
  })

  await check('toKbTsQuery: rövid/üres tokenek kiesnek, dedup', () => {
    assert.equal(toKbTsQuery('a az work work'), 'az:* | work:*')
    assert.equal(toKbTsQuery('   '), '')
    assert.equal(toKbTsQuery('!!! ???'), '')
  })

  // ── kb_list_index (assembleKbIndex, §9.3) ─────────────────────────────────

  function indexEntry(over: Partial<KnowledgeIndexEntry> = {}): KnowledgeIndexEntry {
    return {
      artifactId: 'art-1',
      connectorId: 'kb-conn-1',
      path: 'pages/01-remote-work.md',
      title: 'Remote Work Policy',
      type: 'Section',
      ...over,
    }
  }

  await check('assembleKbIndex: path + cím listát ad, artifactId-vel', () => {
    const result = assembleKbIndex([
      indexEntry(),
      indexEntry({ path: 'pages/02-onboarding.md', title: 'Onboarding' }),
    ])
    assert.equal(result.pages.length, 2)
    assert.equal(result.pages[0].path, 'pages/01-remote-work.md')
    assert.equal(result.pages[0].title, 'Remote Work Policy')
    assert.equal(result.pages[0].artifactId, 'art-1')
  })

  await check('assembleKbIndex: maxDepth kiszűri a mélyebb path-okat', () => {
    const result = assembleKbIndex(
      [
        indexEntry({ path: 'index.md' }), // mélység 1
        indexEntry({ path: 'pages/01-remote-work.md' }), // mélység 2
        indexEntry({ path: 'pages/sub/03-deep.md' }), // mélység 3
      ],
      2,
    )
    const paths = result.pages.map((p) => p.path)
    assert.ok(paths.includes('index.md'))
    assert.ok(paths.includes('pages/01-remote-work.md'))
    assert.ok(!paths.includes('pages/sub/03-deep.md'), 'a 3 mélységű path kiesik maxDepth=2-nél')
  })

  // ── kb_get_page (assembleKbPage, §9.2) ────────────────────────────────────

  function pageChunk(over: Partial<KnowledgePageChunk> = {}): KnowledgePageChunk {
    return {
      artifactId: 'art-1',
      connectorId: 'kb-conn-1',
      path: 'pages/01-remote-work.md',
      title: 'Remote Work Policy',
      type: 'Section',
      section: 'Remote Work Policy',
      chunkIndex: 0,
      text: 'Employees may request remote work if the role allows it.',
      sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 3 },
      ...over,
    }
  }

  await check('assembleKbPage: chunkIndex sorrendben összefűz + forrás-linket ad', () => {
    const result = assembleKbPage('pages/01-remote-work.md', [
      pageChunk({ chunkIndex: 1, text: 'Második bekezdés.' }),
      pageChunk({ chunkIndex: 0, text: 'Első bekezdés.' }),
    ])
    assert.equal(result.found, true)
    assert.equal(result.title, 'Remote Work Policy')
    assert.equal(result.text, 'Első bekezdés.\n\nMásodik bekezdés.', 'chunkIndex sorrend')
    assert.equal(result.source?.page, 3, 'oldal-szintű forrás-link (§4.7)')
    assert.equal(result.source?.filename, 'hr-remote-policy.pdf')
    assert.equal(result.artifactId, 'art-1')
  })

  await check('assembleKbPage: nincs chunk → found:false', () => {
    const result = assembleKbPage('pages/99-nincs.md', [])
    assert.equal(result.found, false)
    assert.equal(result.path, 'pages/99-nincs.md')
    assert.equal(result.text, undefined)
  })

  await check('assembleKbCatalog: fájl és wiki külön sor, purpose megmarad', () => {
    const result = assembleKbCatalog({
      docs: [
        {
          id: 'doc-file',
          filename: 'szabaly.md',
          processingMode: 'raw_text_only',
          metadata: { purpose: 'Távmunka szabály' },
          chars: 40,
        },
        {
          id: 'doc-wiki',
          filename: 'policy.md',
          processingMode: 'okf',
          metadata: {},
          chars: 80,
        },
      ],
      artifacts: [{ id: 'art-1', sourceDocumentId: 'doc-wiki', status: 'published' }],
      entries: [
        indexEntry({ path: 'pages/02-onboarding.md', title: 'Onboarding' }),
        indexEntry(),
      ],
    })
    assert.equal(result.sources.length, 2)
    assert.equal(result.sources[0].kind, 'wiki')
    assert.equal(result.sources[0].pageCount, 2)
    assert.equal(result.sources[0].pages?.[0].path, 'pages/01-remote-work.md')
    assert.equal(result.sources[1].kind, 'file')
    assert.equal(result.sources[1].purpose, 'Távmunka szabály')
    assert.equal(result.sources[1].pages, undefined)
  })

  await check('okfIndexFile: a bundle index.md törzsét adja, frontmatter nélkül', () => {
    const file = okfIndexFile({
      files: [
        {
          path: 'index.md',
          content: '---\ntype: Index\ntitle: "policy.md"\n---\n\n# policy.md\n\n## Pages\n- [Remote](pages/01.md)\n',
        },
      ],
    })
    assert.equal(file?.title, 'policy.md')
    assert.match(file?.text ?? '', /Remote/)
    assert.equal(file?.text.includes('type: Index'), false)
  })

  await check('assembleKbDocument: rövid fájl teljes, hosszú csak vázlat, section egy fejezet', () => {
    const short = assembleKbDocument({
      documentId: 'd1',
      filename: 'a.md',
      purpose: null,
      text: '# Egy\nRövid.',
    })
    assert.equal(short.truncated, false)
    assert.match(short.text ?? '', /Rövid/)

    const long = assembleKbDocument({
      documentId: 'd2',
      filename: 'b.md',
      purpose: null,
      text: `# Alpha\n${'a'.repeat(KB_DOCUMENT_INLINE_CHARS)}\n\n# Beta\nvege`,
    })
    assert.equal(long.truncated, true)
    assert.deepEqual(long.outline, ['Alpha', 'Beta'])
    assert.equal(long.text, undefined)

    const section = assembleKbDocument({
      documentId: 'd2',
      filename: 'b.md',
      purpose: null,
      text: `# Alpha\n${'a'.repeat(100)}\n\n# Beta\nvege`,
      section: 'beta',
    })
    assert.equal(section.sectionFound, true)
    assert.equal(section.text, 'vege')
  })

  await check('mergeKbHits: score szerint vág', () => {
    const hits = mergeKbHits(
      [
        { docId: 'a', snippet: 'alacsony', sourceRef: 'a', memoryVersion: null, score: 0.1 },
        { docId: 'b', snippet: 'magas', sourceRef: 'b', memoryVersion: null, score: 2 },
      ],
      1,
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0].docId, 'b')
  })

  await check('assembleKbPage: section fallback a forrás-linkhez, ha nincs page', () => {
    const result = assembleKbPage('pages/02-onboarding.md', [
      pageChunk({
        path: 'pages/02-onboarding.md',
        section: 'Onboarding',
        sourceRef: { documentId: 'doc-x', filename: 'kezikonyv.docx' },
      }),
    ])
    assert.equal(result.source?.section, 'Onboarding', 'DOCX section-szintű forrás (§4.7)')
    assert.equal(result.source?.page, undefined)
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
