/**
 * Dokumentum tenant-határ döntési mag — cross-tenant IDOR zárása a feldolgozási utakon.
 *
 * Futtatás: npx tsx scripts/document-tenant-access.test.ts
 *
 * ÜZLETI HÁTTÉR: a `Document`-nek nincs saját tenantId oszlopa; a tenant-kötés a
 * feltöltő tagságából (friss feltöltés) vagy a KB-connector tenantjából (bekötött dok)
 * vezethető le. A dokumentum-feldolgozó control-plane műveletek eddig tenant-ellenőrzés
 * NÉLKÜL oldották fel a kliens `documentId`-jét — így egy tenant operátora egy MÁSIK
 * tenant feltöltött dokumentumát is beköthette a saját KB-jébe / leelemeztethette.
 * A `decideDocumentTenantAccess` a fail-closed határ tiszta, DB-mentes magja.
 *
 * DT-1: friss feltöltés + a feltöltő a hívó tenantjának tagja → engedélyezett.
 * DT-2: friss feltöltés + a feltöltő NEM tagja (idegen tenant) → tiltott (a támadási eset).
 * DT-3: friss feltöltés + platform-kontextus (actorTenantId=null) → fail-closed.
 * DT-4: bekötött dok, connector a hívó tenantjában → engedélyezett.
 * DT-5: bekötött dok, connector IDEGEN tenantban → tiltott.
 * DT-6: bekötött dok, MEGOSZTOTT (platform, tenantId=null) connector → engedélyezett.
 * DT-7: bekötött dok, de a connector eltűnt → fail-closed.
 */

import assert from 'node:assert/strict'
import { decideDocumentTenantAccess } from '../src/lib/document-tenant-access'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('document-tenant-access')

check('DT-1: unattached + uploader is member of actor tenant → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached' },
      uploaderHasActiveMembership: true,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-2: unattached + uploader NOT a member (foreign tenant doc) → denied', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached' },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-3: unattached + platform context (null actor tenant) → fail-closed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached' },
      uploaderHasActiveMembership: true,
      actorTenantId: null,
    }),
    false,
  )
})

check('DT-4: attached, connector in actor tenant → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: TENANT_A },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-5: attached, connector in FOREIGN tenant → denied', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: TENANT_B },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-6: attached, SHARED platform connector (null tenant) → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: null },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-7: attached but connector missing → fail-closed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector-missing' },
      uploaderHasActiveMembership: true,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nAll document-tenant-access tests passed')
