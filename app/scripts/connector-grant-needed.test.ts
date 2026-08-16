/**
 * Delegált connector OAuth-grant hiány: ok, scope-unió, biztonságos return path.
 * Futtatás: npm run test:connector-grant-needed
 */
import assert from 'node:assert/strict'
import {
  CONNECTOR_GRANT_NEEDED_CHAT_PROMPT,
  CONNECTOR_GRANT_NEEDED_TICKET_NOTE,
  isConnectorGrantNeededReason,
  isGmailFamilyTool,
  isSafeOAuthReturnTo,
  mergeOauthScopes,
  oauthReturnPath,
  readConnectorGrantNeedsFromPayload,
  scopesSuggestedForGrantNeeded,
} from '../src/domain/connector-grant/connector-grant-needed'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'

const CONV = '11111111-1111-4111-8111-111111111111'
const TICKET = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('=== connector-grant-needed ===')

check('grant-hiány okok', () => {
  assert.equal(isConnectorGrantNeededReason('connector_grant_missing'), true)
  assert.equal(isConnectorGrantNeededReason('gmail_scope_not_granted'), true)
  assert.equal(isConnectorGrantNeededReason('capability_denied'), false)
})

check('gmail family + javasolt scope', () => {
  assert.equal(isGmailFamilyTool('gmail_search'), true)
  assert.equal(isGmailFamilyTool('mailbox_count'), true)
  assert.equal(isGmailFamilyTool('file_read'), false)
  assert.deepEqual(scopesSuggestedForGrantNeeded('gmail_search'), [GMAIL_SCOPES.readonly])
  assert.ok(scopesSuggestedForGrantNeeded('gmail_send').includes(GMAIL_SCOPES.send))
  assert.ok(scopesSuggestedForGrantNeeded('gmail_create_draft').includes(GMAIL_SCOPES.compose))
})

check('scope unió: duplikátum és üres kiesik', () => {
  assert.deepEqual(
    mergeOauthScopes(
      [GMAIL_SCOPES.readonly, ''],
      [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify],
      undefined,
    ),
    [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify],
  )
})

check('oauth return path: ticket / conversation / fallback', () => {
  assert.equal(
    oauthReturnPath({ kind: 'ticket', id: TICKET }),
    `/control-plane/tickets/${TICKET}?granted=1`,
  )
  assert.equal(
    oauthReturnPath({ kind: 'conversation', id: CONV, agentId: AGENT }),
    `/control-plane/agents/${AGENT}?conversation=${CONV}&granted=1`,
  )
  assert.equal(
    oauthReturnPath({ kind: 'conversation', id: CONV }),
    '/control-plane/connectors?connected=1',
  )
})

check('returnTo: csak kind + uuid, nincs nyers URL', () => {
  assert.equal(isSafeOAuthReturnTo({ kind: 'ticket', id: TICKET }), true)
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: CONV, agentId: AGENT }), true)
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: 'not-a-uuid' }), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: CONV, agentId: 'nope' }), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'evil', id: TICKET }), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'ticket', id: TICKET, path: '/evil' }), true)
  assert.equal(isSafeOAuthReturnTo('/control-plane/tickets/x?granted=1'), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'ticket', id: '../../evil' }), false)
})

check('payload kártyák: csak érvényes grant-hiány', () => {
  const cards = readConnectorGrantNeedsFromPayload({
    connectorGrantNeeds: [
      {
        connectorId: CONV,
        connectorType: 'gmail',
        connectorName: 'Levél',
        toolName: 'gmail_search',
        reason: 'connector_grant_missing',
        scopes: [GMAIL_SCOPES.readonly],
      },
      { connectorId: TICKET, toolName: 'gmail_send', reason: 'capability_denied' },
      { toolName: 'gmail_search', reason: 'connector_grant_missing' },
    ],
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.toolName, 'gmail_search')
  assert.equal(cards[0]?.connectorName, 'Levél')
  assert.deepEqual(readConnectorGrantNeedsFromPayload({}), [])
  assert.deepEqual(readConnectorGrantNeedsFromPayload(null), [])
})

check('folytatás-szövegek nem üresek', () => {
  assert.ok(CONNECTOR_GRANT_NEEDED_CHAT_PROMPT.includes('OAuth'))
  assert.ok(CONNECTOR_GRANT_NEEDED_TICKET_NOTE.includes('folytasd'))
})

if (failures > 0) {
  console.log(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden teszt zöld.')
