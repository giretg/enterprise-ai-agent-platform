/**
 * Dokumentum tenant-határ döntési mag — cross-tenant IDOR zárása a feldolgozási utakon.
 *
 * Futtatás: npx tsx scripts/document-tenant-access.test.ts
 *
 * ÜZLETI HÁTTÉR: a `Document`-nek nincs saját tenantId oszlopa; a tenant-kötés a
 * feltöltéskor bélyegzett `metadata.tenantId`-ből (új dok), a feltöltő tagságából
 * (legacy dok), vagy a KB-connector tenantjából (bekötött dok) vezethető le. A
 * dokumentum-feldolgozó control-plane műveletek eddig tenant-ellenőrzés NÉLKÜL oldották
 * fel a kliens `documentId`-jét — így egy tenant operátora egy MÁSIK tenant feltöltött
 * dokumentumát is beköthette a saját KB-jébe / leelemeztethette / kiolvashatta.
 * A `decideDocumentTenantAccess` a fail-closed határ tiszta, DB-mentes magja.
 *
 * DT-1: friss dok, bélyeg == hívó tenant → engedélyezett.
 * DT-2: friss dok, bélyeg IDEGEN tenant → tiltott (a fő támadási eset).
 * DT-3: friss dok, bélyeg IDEGEN, de a feltöltő a hívó tenantjának is tagja → TILTOTT
 *       (a több-tenantos feltöltő nem nyitja meg a doksit a másik tenant előtt).
 * DT-4: legacy dok (nincs bélyeg) + a feltöltő a hívó tenant tagja → engedélyezett.
 * DT-5: legacy dok (nincs bélyeg) + a feltöltő NEM tagja → tiltott.
 * DT-6: friss/legacy dok + platform-kontextus (actorTenantId=null) → fail-closed.
 * DT-7: bekötött dok, connector a hívó tenantjában → engedélyezett.
 * DT-8: bekötött dok, connector IDEGEN tenantban → tiltott.
 * DT-9: bekötött dok, MEGOSZTOTT (platform, tenantId=null) connector → engedélyezett.
 * DT-10: bekötött dok, de a connector eltűnt → fail-closed.
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

check('DT-1: fresh doc, stamp == actor tenant → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_A },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-2: fresh doc, stamp is FOREIGN tenant → denied', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_B },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-3: fresh doc, foreign stamp but uploader ALSO member of actor tenant → denied', () => {
  // A több-tenantos feltöltő tagsága NEM írhatja felül a bélyeget.
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_B },
      uploaderHasActiveMembership: true,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-4: legacy doc (no stamp) + uploader is member of actor tenant → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: null },
      uploaderHasActiveMembership: true,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-5: legacy doc (no stamp) + uploader NOT a member → denied', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: null },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-6: unattached + platform context (null actor tenant) → fail-closed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_A },
      uploaderHasActiveMembership: true,
      actorTenantId: null,
    }),
    false,
  )
})

check('DT-7: attached, connector in actor tenant → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: TENANT_A },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-8: attached, connector in FOREIGN tenant → denied', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: TENANT_B },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('DT-9: attached, SHARED platform connector (null tenant) → allowed', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'connector', connectorTenantId: null },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('DT-10: attached but connector missing → fail-closed', () => {
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
