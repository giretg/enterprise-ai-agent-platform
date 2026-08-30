/**
 * Futtatás: npx tsx scripts/delegated-oauth-ui.test.ts
 */
import assert from 'node:assert/strict'
import { DRIVE_SCOPES } from '../src/domain/connector-grant/google-drive-scopes'
import {
  driveGrantScopeSummary,
  gmailGrantScopeSummary,
  connectorScopeProfileDescription,
} from '../src/components/account/delegated-oauth-ui'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

test('drive grant summary emberi label', () => {
  const summary = driveGrantScopeSummary([DRIVE_SCOPES.readonly, DRIVE_SCOPES.file])
  assert.equal(summary.label, 'Olvasás + írás kijelölt fájlokon')
  assert.ok(summary.description?.includes('Picker'))
})

test('gmail grant summary emberi label', () => {
  const summary = gmailGrantScopeSummary([GMAIL_SCOPES.readonly])
  assert.equal(summary.label, 'Csak olvasás')
})

test('drive profile description', () => {
  const description = connectorScopeProfileDescription('google_drive', 'readonly')
  assert.ok(description?.includes('írás nélkül'))
})

console.log('\nAll delegated-oauth-ui tests passed.')
