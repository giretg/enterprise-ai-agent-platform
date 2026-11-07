/**
 * #1136 F3 (AC29): a régi és az új `kb_search` top-5 találata egymás mellett, rögzített
 * kérdéssoron és mintaszövegen. Csak eldobható, helyi Postgresen fut, és maga után takarít.
 * Futtatás: DATABASE_URL=… DIRECT_URL=… npm run kb:search-compare
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a szolgáltatásból itt csak a keresés kell */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { prisma } from '../src/lib/db'
import { kbQueryTerms } from '../src/lib/kb-text-match'
import {
  PostgresDocumentRepository,
  PostgresKnowledgeArtifactRepository,
  PostgresKnowledgeChunkRepository,
} from '../src/repositories/postgres/knowledge-repository'

const PAGES: Array<[path: string, text: string]> = [
  ['kartyak.md', 'A kereskedő kártyát fogad el, a kártyák típusa Visa vagy Mastercard. Bankkártya és hitelkártya is lehet.'],
  ['elfogadas.md', 'A kártyaelfogadás szabályai: az elfogadott tranzakciók ISO-8583 üzenetben mennek.'],
  ['szerzodes.md', 'A szerződésben rögzített díjak és a szerződések felmondása.'],
  ['dijak.md', 'A díjak havonta számlázódnak. A havi díj a terminál után jár.'],
  ['terminalok.md', 'A terminálok beüzemelése és a POS terminál cseréje.'],
  ['termekek.md', 'A termék katalógus és a termelés ütemezése.'],
  ['bankok.md', 'A partner bankok listája és a bankok elszámolása.'],
  ['baratok.md', 'A barát ajánlása nem baj, ha a barát ügyfél lesz.'],
  ['adatok.md', 'Az ügyfelek adatai és az adatvédelem. Adat csak jogalappal kezelhető.'],
  ['adok.md', 'Az adó bevallása, az adott évre vonatkozó adók.'],
  ['feladatok.md', 'A napi feladat listája és a heti feladatok.'],
  ['visszaterites.md', 'A visszatérítés menete és a visszatérítések határideje.'],
  ['kockazat.md', 'A kockázatok felmérése, 3DS2 hitelesítés csalás ellen.'],
  ['levelezes.md', 'A levelek kezelése: minden levél a közös postafiókba érkezik.'],
]

const QUESTIONS = [
  'kartya', 'kártyák', 'elfogadás', '8583', 'szerzodes', 'levelek', 'ügyfelek', 'bank', 'adat', 'terminál', 'visa', 'díja', '3DS',
  'hogyan lehet kártyát elfogadni?', 'mennyi a terminál havi díja?', 'a szerződés felmondása és a bankok elszámolása',
]

/** A mai kód lekérdezése, a törölt `toKbTsQuery` mintával: csak az összevetéshez. */
async function oldTop(connectorId: string, query: string): Promise<string[]> {
  const terms = kbQueryTerms(query)
  if (terms.length === 0) return []
  const tsquery = terms.map((term) => `${term}:*`).join(' | ')
  const reg = Prisma.raw(`'hungarian'::regconfig`)
  const vector = Prisma.sql`to_tsvector(${reg}, coalesce(c.title, '') || ' ' || c.text)`
  const rows = await prisma.$queryRaw<Array<{ path: string }>>`
    SELECT c.path FROM knowledge_chunks c
    WHERE c.connector_id = ${connectorId}::uuid AND ${vector} @@ to_tsquery(${reg}, ${tsquery})
    ORDER BY cardinality(ARRAY(
      SELECT t.term FROM unnest(${terms}::text[]) AS t(term) WHERE ${vector} @@ to_tsquery(${reg}, t.term || ':*')
    )) DESC, ts_rank(${vector}, to_tsquery(${reg}, ${tsquery})) DESC, c.path
    LIMIT 5
  `
  return rows.map((row) => row.path)
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`Csak eldobható, helyi Postgresen fut, ez nem az: ${host}`)
  const service = new KnowledgeBaseService({
    chunks: new PostgresKnowledgeChunkRepository(),
    documents: new PostgresDocumentRepository(),
    artifacts: new PostgresKnowledgeArtifactRepository(),
  } as any)
  const tenant = await prisma.tenant.create({ data: { slug: `kb-compare-${randomUUID().slice(0, 8)}`, displayName: 'KB összevetés' } })
  const connector = await prisma.connector.create({
    data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single' } as any,
  })
  try {
    const artifact = await prisma.knowledgeArtifact.create({ data: { connectorId: connector.id, status: 'published', contentHash: randomUUID() } })
    await prisma.knowledgeChunk.createMany({
      data: PAGES.map(([path, text], chunkIndex) => ({ artifactId: artifact.id, connectorId: connector.id, path, title: path, type: 'entity', chunkIndex, text, contentHash: randomUUID() })),
    })
    const short = (paths: string[]) => paths.map((path) => path.replace(/\.md$/, '')).join(', ') || '—'
    console.log('| Kérdés | Régi top-5 | Új top-5 |')
    console.log('|---|---|---|')
    for (const question of QUESTIONS) {
      const before = await oldTop(connector.id, question)
      const after = (await service.search({ connectorId: connector.id, query: question, k: 5 })).map((hit) => hit.path ?? '?')
      console.log(`| ${question} | ${short(before)} | ${short(after)}${short(before) === short(after) ? ' (azonos)' : ''} |`)
    }
  } finally {
    await prisma.knowledgeArtifact.deleteMany({ where: { connectorId: connector.id } })
    await prisma.connector.delete({ where: { id: connector.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
