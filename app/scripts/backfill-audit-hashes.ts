/**
 * One-shot audit hash-lánc backfill — Fázis 1 → Fázis 2 migráció
 * Futtatás: npm run db:backfill-audit
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'
import { reconcileAuditChain } from '../src/lib/crypto/audit-backfill'
import { services } from '../src/domain'

async function main() {
  console.log('=== Audit hash-lánc backfill ===\n')

  // A backfill táblatulajdonosként fut, ezért az append-only trigger (lásd
  // scripts/apply-audit-append-only-trigger.ts) letiltása/visszakapcsolása szükséges
  // a reconcileAuditChain() UPDATE-jeihez — ez az EGYETLEN helyen engedett kivétel,
  // egy kézzel futtatott, egyszeri admin-eszköz, nem az alkalmazás futásidejű útja.
  await prisma.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only')
  let head: string
  try {
    head = await reconcileAuditChain()
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only')
  }
  console.log(`  ✓ Lánc összehangolva — head: ${head.slice(0, 16)}…`)

  const verify = await services.auditChain.verifyChain()
  if (verify.ok) {
    console.log(`  ✓ Verify OK — ${verify.checked} bejegyzés`)
  } else {
    console.error(`  ✗ Verify FAIL — seq ${verify.firstBreakSeq}`)
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
