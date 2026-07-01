/**
 * One-shot backfill: tenant_id/ticket_id/conversation_id oszlopok kitöltése a MEGLÉVŐ
 * audit_log sorokon a target_type/target_id és a metadata JSON-ból (Feature-spec
 * AuditLog-Observability §3.1/§3.2 — explicit, indexelt oszlop a payload-ban élő
 * azonosítók helyett). A hash-láncot NEM érinti (ezek az oszlopok kívül esnek a
 * canonical hash-számításon) — csak a lekérdezési teljesítményt javítja.
 *
 * Egyetlen szerveroldali UPDATE-tel fut (nem soronkénti round-trip) — a regex-őr
 * garantálja, hogy csak valódi UUID-formátumú metadata-értékek kerülnek castolásra,
 * hibás/hiányzó érték esetén NULL marad (nem dobja el a teljes batch-et).
 *
 * Futtatás: npm run db:backfill-audit-attribution [test]
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient } from '@prisma/client'

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const BACKFILL_SQL = `
UPDATE audit_log
SET
  ticket_id = COALESCE(
    ticket_id,
    CASE WHEN target_type = 'ticket' THEN target_id ELSE NULL END,
    CASE WHEN (metadata->>'ticketId') ~* '${UUID_PATTERN}' THEN (metadata->>'ticketId')::uuid END,
    CASE WHEN (metadata->>'ticket_id') ~* '${UUID_PATTERN}' THEN (metadata->>'ticket_id')::uuid END
  ),
  conversation_id = COALESCE(
    conversation_id,
    CASE WHEN target_type = 'conversation' THEN target_id ELSE NULL END,
    CASE WHEN (metadata->>'conversationId') ~* '${UUID_PATTERN}' THEN (metadata->>'conversationId')::uuid END,
    CASE WHEN (metadata->>'conversation_id') ~* '${UUID_PATTERN}' THEN (metadata->>'conversation_id')::uuid END
  ),
  tenant_id = COALESCE(
    tenant_id,
    CASE WHEN (metadata->>'tenantId') ~* '${UUID_PATTERN}' THEN (metadata->>'tenantId')::uuid END,
    CASE WHEN (metadata->>'tenant_id') ~* '${UUID_PATTERN}' THEN (metadata->>'tenant_id')::uuid END
  )
WHERE ticket_id IS NULL OR conversation_id IS NULL OR tenant_id IS NULL;
`

async function backfill(databaseUrl: string, label: string) {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only')
    const updated = await prisma.$executeRawUnsafe(BACKFILL_SQL)
    console.log(`  ✓ [${label}] ${updated} sor frissítve`)
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only')
    await prisma.$disconnect()
  }
}

async function main() {
  const target = process.argv[2]
  console.log('=== Audit attribution (tenant/ticket/conversation) backfill ===\n')

  if (target === 'test') {
    const url = process.env.DATABASE_URL_TEST?.trim()
    if (!url) throw new Error('DATABASE_URL_TEST nincs beállítva')
    await backfill(url, 'test')
  } else {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new Error('DATABASE_URL nincs beállítva')
    await backfill(url, 'dev')
  }
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
