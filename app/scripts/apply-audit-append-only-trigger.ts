/**
 * DB-szintű append-only kényszer az audit_log táblán (Feature-spec AuditLog-Observability
 * §2/2, §4). A `neondb_owner` szerepkör TÁBLA-TULAJDONOS — Postgres-ben a tulajdonos
 * implicit módon minden jogot bír, a REVOKE UPDATE/DELETE ezért nem korlátozná (a
 * tulajdonos felülbírálja a grant-rendszert). A tényleges kikényszerítés BEFORE
 * UPDATE/DELETE trigger-rel történik, ami MINDEN szerepkörre (a tulajdonosra is)
 * érvényes, amíg valaki explicit ALTER TABLE ... DISABLE TRIGGER-rel ki nem kapcsolja.
 *
 * Futtatás: npm run db:apply-audit-append-only        (DATABASE_URL — dev)
 *           npm run db:apply-audit-append-only:test   (DATABASE_URL_TEST)
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient } from '@prisma/client'

// Postgres prepared statementenként egyetlen parancsot enged — külön executeRawUnsafe hívások kellenek.
export const AUDIT_APPEND_ONLY_STATEMENTS = [
  `
CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not allowed (row id=%)', TG_OP, OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$ LANGUAGE plpgsql;
`,
  `DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;`,
  `
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_deny_mutation();
`,
]

async function apply(databaseUrl: string, label: string) {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    for (const statement of AUDIT_APPEND_ONLY_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement)
    }
    console.log(`  ✓ [${label}] audit_log_append_only trigger telepítve`)
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const target = process.argv[2]
  console.log('=== Audit append-only trigger telepítés ===\n')

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
