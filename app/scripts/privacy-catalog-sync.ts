/**
 * Privacy-katalógus szinkron futtatása (issue #320, forrás-szerződés §6.1).
 *
 * A mezőjelölés kanonikus helye a forrásrendszer. Ez a szkript minden aktív
 * `http_api` kapcsolatnál lekéri a `GET /privacy/catalog` végpontot, és a
 * connector-configba írja a jelölést — így a platform nem csúszik el a
 * forrástól. Fail-closed: érvénytelen katalógus esetén a régi jelölés marad.
 *
 * Futtatás:
 *   npm run privacy:catalog-sync                 # minden aktív kapcsolat
 *   npm run privacy:catalog-sync -- --dry-run    # csak riport, nem ír DB-be
 *   npm run privacy:catalog-sync -- --connector <uuid>
 *
 * Ütemezéshez (pl. Cloud Scheduler → Cloud Run job) ugyanez a belépési pont.
 */
import {
  syncPrivacyCatalogForConnector,
  syncPrivacyCatalogsForActiveConnectors,
  type ConnectorPrivacyCatalogSyncResult,
  type PrivacyCatalogSyncDeps,
} from '../src/domain/privacy/privacy-catalog-sync-service'

const DRY_RUN = process.argv.includes('--dry-run')
const connectorFlagIndex = process.argv.indexOf('--connector')
const CONNECTOR_ID = connectorFlagIndex >= 0 ? process.argv[connectorFlagIndex + 1] : undefined

function describe(result: ConnectorPrivacyCatalogSyncResult): string {
  const { outcome } = result
  const name = `${result.connectorName} (${result.connectorId})`
  if (outcome.status === 'applied') {
    const warnings = outcome.warnings.map((w) => `\n      ⚠ ${w}`).join('')
    return `  ✓ ${name}: katalógus v${outcome.catalogVersion} alkalmazva\n      ${outcome.changes.join('\n      ')}${warnings}`
  }
  if (outcome.status === 'no_change') {
    return `  · ${name}: nincs változás (katalógus v${outcome.catalogVersion})`
  }
  return `  ✗ ${name}: ${outcome.reason} — ${outcome.detail}`
}

async function main() {
  const deps: PrivacyCatalogSyncDeps = DRY_RUN
    ? { persist: async () => {}, audit: null }
    : {}
  console.log(
    `Privacy-katalógus szinkron${DRY_RUN ? ' (DRY RUN — nincs írás, nincs audit)' : ''}`,
  )

  const results: ConnectorPrivacyCatalogSyncResult[] = []
  if (CONNECTOR_ID) {
    const outcome = await syncPrivacyCatalogForConnector(CONNECTOR_ID, { id: null }, deps)
    results.push({ connectorId: CONNECTOR_ID, connectorName: 'kapcsolat', outcome })
  } else {
    results.push(...(await syncPrivacyCatalogsForActiveConnectors({ id: null }, deps)))
  }

  if (results.length === 0) {
    console.log('  nincs aktív http_api kapcsolat')
    return
  }
  for (const result of results) console.log(describe(result))

  const applied = results.filter((r) => r.outcome.status === 'applied').length
  const failed = results.filter((r) => r.outcome.status === 'failed').length
  console.log(
    `\nÖsszegzés: ${applied} frissítve · ${results.length - applied - failed} változatlan · ${failed} sikertelen`,
  )
  // A sikertelenség nem hibás futás: a katalógust nem publikáló forrás sem
  // állíthatja meg az ütemezett szinkront. A részletek az auditban vannak.
}

void main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/db')
    await prisma.$disconnect()
  })
