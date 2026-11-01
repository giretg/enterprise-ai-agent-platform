/**
 * A `platform_chat` séma migrációi (D8). A séma tulajdonosa futtatja (NEM a worker szerepe):
 *   PLATFORM_CHAT_MIGRATE_URL=postgres://owner@…/db npm run migrate
 * Idempotens: a lefutott fájlokat a `platform_chat.schema_migrations` tartja nyilván.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

const url = process.env.PLATFORM_CHAT_MIGRATE_URL
if (!url) {
  console.error('PLATFORM_CHAT_MIGRATE_URL is required (schema owner connection string)')
  process.exit(1)
}
const dir = join(import.meta.dirname, '..', 'migrations')
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS platform_chat')
  await client.query(
    'CREATE TABLE IF NOT EXISTS platform_chat.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const applied = new Set((await client.query('SELECT name FROM platform_chat.schema_migrations')).rows.map((r) => r.name as string))
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue
    await client.query('BEGIN')
    try {
      await client.query(await readFile(join(dir, file), 'utf8'))
      await client.query('INSERT INTO platform_chat.schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`applied ${file}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
  console.log('platform_chat migrations: up to date')
} finally {
  await client.end()
}
