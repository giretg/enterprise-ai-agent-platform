/**
 * Postgres full-text (GIN) index a `knowledge_chunks` táblán (Knowledge-Base-v3-OKF-Spec
 * §8.4/§10). A `prisma db push` NEM hoz létre expression-alapú tsvector GIN indexet,
 * ezért — az audit append-only triggerhez hasonlóan — nyers SQL-ként telepítjük.
 *
 * Az index a `to_tsvector('simple', title || ' ' || text)` kifejezésre épül; a
 * `kb_search v2` (`searchChunks`) pontosan ezt a kifejezést kérdezi `@@ to_tsquery(...)`
 * mintával, `ts_rank` sorrenddel. A `simple` config determinisztikus, extension nélkül
 * működik Neonon (nincs stemmer/unaccent függés — §10.1).
 *
 * Futtatás: npm run db:apply-kb-fts        (DATABASE_URL — dev)
 *           npm run db:apply-kb-fts:test   (DATABASE_URL_TEST)
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient } from '@prisma/client'

// Postgres prepared statementenként egyetlen parancsot enged — külön hívások kellenek.
export const KB_CHUNK_FTS_STATEMENTS = [
  `
CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx
  ON knowledge_chunks
  USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || text));
`,
]

async function apply(databaseUrl: string, label: string) {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    for (const statement of KB_CHUNK_FTS_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement)
    }
    console.log(`  ✓ [${label}] knowledge_chunks_fts_idx GIN index telepítve`)
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const target = process.argv[2]
  console.log('=== KB chunk full-text (GIN) index telepítés ===\n')

  if (target === 'test') {
    const url = process.env.DATABASE_URL_TEST?.trim()
    if (!url) throw new Error('DATABASE_URL_TEST nincs beállítva')
    await apply(url, 'test')
  } else {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new Error('DATABASE_URL nincs beállítva')
    await apply(url, 'dev')
  }
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
