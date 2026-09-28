/**
 * #717 — Többnyelvű tudástár-keresés + modell-promptok nyelve.
 * Futtatás: npx tsx scripts/kb-multilingual.test.ts
 *
 * Lefedi (§6.1 + elfogadási #5–8):
 * - registry az egyetlen forrás (zod-értékek paritása),
 * - `kbRegconfig` allowlist (nem-allowlist/injekciós input → `simple`),
 * - tárolt érték normalizálás (amit a SQL COALESCE lát: override ?? connector),
 * - `formatHitsForPrompt` hu = mai render, en = nincs magyar mondat,
 * - `readDocumentPages` hintek mindkét nyelven,
 * - briefing hu = byte-ra azonos, en = nincs magyar mondat + OUTPUT LANGUAGE,
 * - http-api / paginate / connector-grant hintek en = nincs magyar mondat.
 */
import assert from 'node:assert/strict'
import type { Sql } from '@prisma/client/runtime/library'
import {
  KB_LANGUAGE_OPTIONS,
  KB_LANGUAGE_REGISTRY,
  KB_PG_FALLBACK,
  isKbLanguage,
  kbPgConfig,
  resolveKbLanguage,
} from '../src/lib/kb-language'
import { kbRegconfig } from '../src/repositories/postgres/knowledge-repository'
import { formatHitsForPrompt, type KbHit } from '../src/lib/kb-format'
import { blocksFromDocument, readDocumentPages } from '../src/lib/document-read'
import { renderAgentBriefing } from '../src/lib/agent-checkout'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  buildHttpApiClientErrorHint,
  buildHttpApiEfficiencyGuidance,
  buildHttpApiLikelyPaginatedHint,
  buildHttpApiOversizedResponseHint,
  buildHttpApiTruncationBody,
  formatHttpApiQueryParamsHint,
} from '../src/domain/connector/http-api-prompt'
import { paginateHttpApiGet } from '../src/domain/connector/http-api-paginate'
import {
  CONNECTOR_GRANT_NEEDED_CHAT_PROMPT,
  CONNECTOR_GRANT_NEEDED_TICKET_NOTE,
  connectorGrantNeededChatPrompt,
  connectorGrantNeededTicketNote,
} from '../src/domain/connector-grant/connector-grant-needed'
import { KB_LANGUAGE_VALUES } from '../src/lib/validators/actions'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK  ${name}`))
    .catch((e) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e.message}`)
    })
}

/** Magyar mondat nyoma: ékezetes betű vagy ismert magyar szó. */
const HU_WORDS = ['nincs', 'találat', 'jóváhagyás', 'forrás', 'oldal', 'fájl', 'keresés', 'tudástár']
function assertNoHungarian(name: string, text: string) {
  assert.ok(!/[áéíóöőúüűÁÉÍÓÖŐÚÜ]/.test(text), `${name}: ékezetes (magyar) karakter: ${text.slice(0, 120)}`)
  const lower = text.toLowerCase()
  for (const word of HU_WORDS) {
    assert.ok(!new RegExp(`\\b${word}`).test(lower), `${name}: magyar szó (${word})`)
  }
}

function regconfigSql(fragment: unknown): string {
  const sql = fragment as Sql
  assert.equal(typeof sql.sql, 'string')
  assert.deepEqual(sql.values, [])
  return sql.sql
}

function definition(): AgentDefinition {
  return {
    definitionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    version: 3,
    tenantId: '99999999-9999-4999-8999-999999999999',
    status: 'active',
    publishedAt: '2026-01-02T00:00:00.000Z',
    snapshot: {
      name: 'Shipping assistant',
      description: 'Helps with shipping questions.',
      roleInstruction: 'Answer shipping questions.',
      skills: [],
      connectors: [],
      capabilities: [],
    },
  }
}

async function main() {
  await check('registry: csak hu/en, pgConfig + üzleti label', () => {
    assert.deepEqual(Object.keys(KB_LANGUAGE_REGISTRY), ['hu', 'en'])
    assert.equal(KB_LANGUAGE_REGISTRY.hu.pgConfig, 'hungarian')
    assert.equal(KB_LANGUAGE_REGISTRY.en.pgConfig, 'english')
    assert.equal(KB_PG_FALLBACK, 'simple')
    assert.deepEqual(
      KB_LANGUAGE_OPTIONS.map((o) => o.value),
      ['hu', 'en'],
    )
    for (const option of KB_LANGUAGE_OPTIONS) {
      assert.ok(!/regconfig|hungarian|simple/i.test(option.label), `technikai kód a labelben: ${option.label}`)
    }
  })

  await check('zod-értékek paritása a registry kulcsaival', () => {
    assert.deepEqual([...KB_LANGUAGE_VALUES], Object.keys(KB_LANGUAGE_REGISTRY))
  })

  await check('kbRegconfig: allowlist, injekció → simple', () => {
    assert.equal(regconfigSql(kbRegconfig('hu')), `'hungarian'::regconfig`)
    assert.equal(regconfigSql(kbRegconfig('en')), `'english'::regconfig`)
    assert.equal(regconfigSql(kbRegconfig('de')), `'simple'::regconfig`)
    assert.equal(regconfigSql(kbRegconfig('hungarian')), `'simple'::regconfig`)
    assert.equal(regconfigSql(kbRegconfig(`english'); DROP TABLE documents; --`)), `'simple'::regconfig`)
    assert.equal(regconfigSql(kbRegconfig(undefined)), `'simple'::regconfig`)
    assert.equal(kbPgConfig('hu'), 'hungarian')
    assert.equal(kbPgConfig('xx'), 'simple')
    assert.ok(isKbLanguage('hu') && isKbLanguage('en') && !isKbLanguage('hungarian'))
    assert.equal(resolveKbLanguage('xx'), 'hu')
  })

  await check('tárolt érték normalizálás = amit a SQL COALESCE lát', () => {
    // A `kbLanguageGroups` a connector tárolt értékét a `COALESCE`-hez
    // igazítja; a tenant-nyelv nem SQL-látható, ezért nincs benne.
    assert.equal(resolveKbLanguage('en'), 'en')
    assert.equal(resolveKbLanguage('hu'), 'hu')
    assert.equal(resolveKbLanguage('de'), 'hu')
    assert.equal(resolveKbLanguage(null), 'hu')
    assert.equal(resolveKbLanguage(undefined), 'hu')
  })

  await check('formatHitsForPrompt: hu = mai render, en = nincs magyar', () => {
    assert.equal(formatHitsForPrompt([]), '(nincs találat)')
    assert.equal(formatHitsForPrompt([], 'en'), '(no hits)')
    const hits: KbHit[] = [
      {
        docId: 'doc:1',
        snippet: 'Shipping fees are flat.',
        sourceRef: 'doc:1:fees.pdf',
        memoryVersion: null,
        path: 'shipping/fees.md',
        title: 'Shipping fees',
        source: { filename: 'fees.pdf', page: 2 },
      },
      {
        docId: 'doc:2',
        snippet: 'Ny Hungarian snippet.',
        sourceRef: 'doc:2:ar.pdf',
        memoryVersion: null,
      },
    ]
    const hu = formatHitsForPrompt(hits)
    assert.ok(hu.includes('(nincs találat)') === false)
    assert.ok(hu.includes('FÁJL TARTALOM: ar.pdf'))
    assert.ok(hu.includes('forrás: fees.pdf, oldal 2'))
    assert.equal(formatHitsForPrompt(hits, 'hu'), hu)
    const en = formatHitsForPrompt(hits, 'en')
    assert.ok(en.includes('FILE CONTENT: ar.pdf'))
    assert.ok(en.includes('source: fees.pdf, page 2'))
    assertNoHungarian('formatHitsForPrompt en', en.replace('Ny Hungarian snippet.', ''))
  })

  await check('readDocumentPages: hintek mindkét nyelven', () => {
    const base = { documentId: 'd1', filename: 'f.pdf', blocks: [] }
    assert.equal(readDocumentPages(base).hint, 'A dokumentumból nincs kinyert szöveg.')
    assert.equal(readDocumentPages({ ...base, language: 'en' }).hint, 'No extracted text in this document.')
    const blocks = blocksFromDocument(null, 'plain text without headings')
    assert.equal(blocks[0]?.heading, 'Dokumentum')
    assert.equal(blocksFromDocument(null, 'plain text without headings', 'en')[0]?.heading, 'Document')
    const withBlocks = { documentId: 'd1', filename: 'f.pdf', blocks }
    const huHint = readDocumentPages({ ...withBlocks, query: 'xyz-nothing' }).hint ?? ''
    const enHint = readDocumentPages({ ...withBlocks, query: 'xyz-nothing', language: 'en' }).hint ?? ''
    assert.ok(huHint.includes('Nincs találat'))
    assert.ok(enHint.includes('No hits'))
    assertNoHungarian('document-read en hint', enHint)
  })

  await check('briefing: hu byte-azonos, en magyar-mentes', () => {
    const def = definition()
    const plain = renderAgentBriefing({ definition: def, skills: [], approverName: 'Anna Approver' })
    const hu = renderAgentBriefing({ definition: def, skills: [], approverName: 'Anna Approver', language: 'hu' })
    assert.equal(hu, plain)
    assert.ok(plain.includes('## Jóváhagyások'))
    const en = renderAgentBriefing({ definition: def, skills: [], approverName: 'Anna Approver', language: 'en' })
    assert.ok(en.includes('## Approvals'))
    assert.ok(en.includes('OUTPUT LANGUAGE'))
    assertNoHungarian('briefing en', en)
    const enNoApprover = renderAgentBriefing({ definition: def, skills: [], language: 'en' })
    assertNoHungarian('briefing en (no approver)', enNoApprover)
  })

  await check('http-api hintek: hu = mai, en = magyar-mentes', () => {
    const errHu = buildHttpApiClientErrorHint({ status: 422, endpoint: null })
    assert.ok(errHu?.includes('Ne találj ki'))
    const errEn = buildHttpApiClientErrorHint({ status: 422, endpoint: null, language: 'en' })
    assert.ok(errEn?.includes('Do not invent'))
    assertNoHungarian('http 422 en', errEn ?? '')
    assert.equal(
      buildHttpApiOversizedResponseHint({ originalChars: 99, maxChars: 10 }),
      buildHttpApiOversizedResponseHint({ originalChars: 99, maxChars: 10, language: 'hu' }),
    )
    assertNoHungarian(
      'http oversized en',
      buildHttpApiOversizedResponseHint({ originalChars: 99, maxChars: 10, language: 'en' }),
    )
    assertNoHungarian(
      'http truncation en',
      buildHttpApiTruncationBody({ originalChars: 99, maxChars: 10, preview: 'x', language: 'en' }).hint,
    )
    assert.ok(buildHttpApiEfficiencyGuidance().includes('Hatékony'))
    assertNoHungarian('http efficiency en', buildHttpApiEfficiencyGuidance('en'))
    const pagHu = buildHttpApiLikelyPaginatedHint({ path: '/owners', itemCount: 50 })
    assert.ok(pagHu?.includes('FIGYELEM'))
    assertNoHungarian(
      'http paginated en',
      buildHttpApiLikelyPaginatedHint({ path: '/owners', itemCount: 50, language: 'en' }) ?? '',
    )
    assert.ok(formatHttpApiQueryParamsHint([{ name: 'q', required: true }]).includes('kötelező'))
    assert.ok(formatHttpApiQueryParamsHint([{ name: 'q', required: true }], 'en').includes('required'))
  })

  await check('paginate hibák nyelve', async () => {
    const failing = () =>
      paginateHttpApiGet({
        plan: { kind: 'page', pageParam: 'page', pageSize: 100, maxPages: 5, firstPage: 1 },
        fetchPage: async () => ({ ok: false, status: 500, body: null }),
      })
    const hu = await failing()
    assert.ok(!hu.ok && (hu as { error: string }).error.includes('lapozás'))
    const en = await paginateHttpApiGet({
      plan: { kind: 'page', pageParam: 'page', pageSize: 100, maxPages: 5, firstPage: 1 },
      fetchPage: async () => ({ ok: false, status: 500, body: null }),
      language: 'en',
    })
    assert.ok(!en.ok)
    assertNoHungarian('paginate en', (en as { error: string }).error)
  })

  await check('connector-grant promptok nyelve', () => {
    assert.equal(connectorGrantNeededChatPrompt(), CONNECTOR_GRANT_NEEDED_CHAT_PROMPT)
    assert.equal(connectorGrantNeededTicketNote(), CONNECTOR_GRANT_NEEDED_TICKET_NOTE)
    assertNoHungarian('grant chat en', connectorGrantNeededChatPrompt('en'))
    assertNoHungarian('grant ticket en', connectorGrantNeededTicketNote('en'))
  })

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll kb-multilingual checks passed')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
