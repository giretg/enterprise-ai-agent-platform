/**
 * Delegált (per-user OAuth) connector grant-kapu: ok-felismerés, provider-regiszter,
 * scope-feloldás és biztonságos OAuth-visszatérés.
 *
 * A kapu NEM Gmail-specifikus: a tesztek egy regisztrált providert (Gmail) ÉS egy
 * regiszterben nem szereplő, generikus OAuth-connectort (http_api) is végigvisznek.
 *
 * Futtatás: npm run test:connector-grant-needed
 */
import assert from 'node:assert/strict'
import {
  CONNECTOR_GRANT_NEEDED_CHAT_PROMPT,
  CONNECTOR_GRANT_NEEDED_REASONS,
  CONNECTOR_GRANT_NEEDED_TICKET_NOTE,
  connectorGrantCardFromLoopEvent,
  connectorGrantLabel,
  connectorTypeForGrantTool,
  describeConnectorGrantTargets,
  isConnectorGrantNeededReason,
  isAuthorizationLinkReason,
  isSafeOAuthReturnTo,
  isScopeNotGrantedReason,
  oauthReturnPath,
  readConnectorGrantNeedsFromPayload,
} from '../src/domain/connector-grant/connector-grant-needed'
import { resolveOAuthCallbackActor } from '../src/lib/crypto/oauth-state'
import {
  delegatedConnectorLabel,
  delegatedScopeDeniedReason,
  GENERIC_SCOPE_DENIED_REASON,
  hasDelegatedScopeCheck,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
  registeredDelegatedProviderTools,
  registeredDelegatedProviderTypes,
  resolveGrantOAuthScopes,
  scopesFromConnectorConfig,
} from '../src/domain/connector-grant/delegated-oauth-registry'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'
import { toolsRequiringConnector } from '../src/domain/connector-grant/tool-connector-requirements'

const CONV = '11111111-1111-4111-8111-111111111111'
const TICKET = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'

const GMAIL_CONFIG = {
  oauth: { scopes: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify, GMAIL_SCOPES.send] },
}
/** Hipotetikus új OAuth-connector: nincs bejegyzése a regiszterben. */
const GENERIC_CONFIG = {
  oauth: { scopes: ['files.read', 'files.write'] },
}

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

console.log('=== delegált connector grant-kapu ===')

check('okok: grant-hiány + provider-független és Gmail-történeti scope-hiány', () => {
  assert.equal(isConnectorGrantNeededReason('connector_grant_missing'), true)
  assert.equal(isConnectorGrantNeededReason(GENERIC_SCOPE_DENIED_REASON), true)
  assert.equal(isConnectorGrantNeededReason('gmail_scope_not_granted'), true)
  assert.equal(isConnectorGrantNeededReason('capability_denied'), false)
  assert.equal(isConnectorGrantNeededReason(null), false)
  assert.equal(isAuthorizationLinkReason('connector_grant_missing'), true)
  assert.equal(isAuthorizationLinkReason('google_drive_auth_failed'), true)
  assert.equal(isAuthorizationLinkReason('capability_denied'), false)
  assert.equal(isScopeNotGrantedReason('connector_grant_missing'), false)
  assert.equal(isScopeNotGrantedReason('gmail_scope_not_granted'), true)
  // A régi tool_calls sorok is felismerhetők maradnak.
  assert.ok((CONNECTOR_GRANT_NEEDED_REASONS as readonly string[]).includes('gmail_scope_not_granted'))
})

check('provider-regiszter: Gmail bejegyzés, ismeretlen típus generikus', () => {
  assert.deepEqual(registeredDelegatedProviderTypes(), ['gmail', 'google_drive'])
  assert.equal(delegatedConnectorLabel('gmail', 'Céges levelezés'), 'Gmail')
  assert.equal(delegatedConnectorLabel('google_drive', 'Akármi'), 'Google Drive')
  assert.equal(delegatedScopeDeniedReason('google_drive'), 'google_drive_scope_not_granted')
  assert.equal(hasDelegatedScopeCheck('google_drive'), true)
  // Ismeretlen providernél a connector SAJÁT neve a címke — nincs beégetve semmi.
  assert.equal(delegatedConnectorLabel('http_api', 'Ostorosbor API'), 'Ostorosbor API')
  assert.equal(delegatedConnectorLabel('http_api', ''), 'külső fiók')
  assert.equal(delegatedScopeDeniedReason('gmail'), 'gmail_scope_not_granted')
  assert.equal(delegatedScopeDeniedReason('http_api'), GENERIC_SCOPE_DENIED_REASON)
  assert.equal(hasDelegatedScopeCheck('gmail'), true)
  assert.equal(hasDelegatedScopeCheck('http_api'), false)
})

check('drift: a Gmail provider eszközlistája = a tool-mátrix gmail eszközei', () => {
  assert.deepEqual(
    [...registeredDelegatedProviderTools('gmail')].sort(),
    [...toolsRequiringConnector('gmail')].sort(),
  )
})

check('tool → connector-típus: ismert provider igen, workspace-eszköz nem', () => {
  assert.equal(connectorTypeForGrantTool('gmail_send'), 'gmail')
  assert.equal(connectorTypeForGrantTool('mailbox_count'), 'gmail')
  assert.equal(connectorTypeForGrantTool('file_read'), null)
})

check('scope a configból: oauth.scopes / auth.scope / scopesSuggested', () => {
  assert.deepEqual(scopesFromConnectorConfig(GENERIC_CONFIG, 'http_api'), [
    'files.read',
    'files.write',
  ])
  assert.deepEqual(
    scopesFromConnectorConfig({ auth: { scope: 'read:me write:me' } }, 'http_api'),
    ['read:me', 'write:me'],
  )
  assert.deepEqual(
    scopesFromConnectorConfig({ scopesSuggested: ['calendar.events'] }, 'http_api'),
    ['calendar.events'],
  )
  // Gmail alias feloldódik teljes URL-re; üres config → provider default.
  assert.deepEqual(scopesFromConnectorConfig({ oauth: { scopes: ['gmail.readonly'] } }, 'gmail'), [
    GMAIL_SCOPES.readonly,
  ])
  assert.deepEqual(scopesFromConnectorConfig({}, 'gmail'), [GMAIL_SCOPES.modify])
  assert.deepEqual(scopesFromConnectorConfig({}, 'http_api'), [])
})

check('OAuth-scope feloldás: a config a keret, a tool igénye a szűrő', () => {
  // Least privilege: olvasó eszközhöz nem kérünk send-et.
  assert.deepEqual(
    resolveGrantOAuthScopes({ connectorType: 'gmail', config: GMAIL_CONFIG, toolName: 'gmail_search' }),
    [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify],
  )
  assert.deepEqual(
    resolveGrantOAuthScopes({ connectorType: 'gmail', config: GMAIL_CONFIG, toolName: 'gmail_send' }),
    [GMAIL_SCOPES.send],
  )
  // Configon kívüli scope-ot nem kérünk (a szerviz amúgy is elutasítaná).
  assert.deepEqual(
    resolveGrantOAuthScopes({
      connectorType: 'gmail',
      config: { oauth: { scopes: [GMAIL_SCOPES.readonly] } },
      toolName: 'gmail_send',
    }),
    [GMAIL_SCOPES.readonly],
  )
  // Ismeretlen provider: a config teljes listája megy, tool-névvel is.
  assert.deepEqual(
    resolveGrantOAuthScopes({ connectorType: 'http_api', config: GENERIC_CONFIG, toolName: 'http_api_get' }),
    ['files.read', 'files.write'],
  )
  assert.deepEqual(resolveGrantOAuthScopes({ connectorType: 'http_api', config: {} }), [])
})

check('grant elégségesség: Gmail scope-kapu, ismeretlen providernél a grant léte a jel', () => {
  assert.equal(
    isDelegatedToolAllowedByScopes({
      connectorType: 'gmail',
      toolName: 'gmail_send',
      scopes: [GMAIL_SCOPES.readonly],
    }),
    false,
  )
  assert.equal(
    isDelegatedToolAllowedByScopes({
      connectorType: 'gmail',
      toolName: 'gmail_send',
      scopes: [GMAIL_SCOPES.send],
    }),
    true,
  )
  assert.equal(
    isDelegatedToolAllowedByScopes({
      connectorType: 'http_api',
      toolName: 'http_api_request',
      scopes: ['files.read'],
    }),
    true,
  )
})

check('grant scope parse: JSON-listából csak stringek', () => {
  assert.deepEqual(parseDelegatedGrantScopes(['a', 2, null, 'b']), ['a', 'b'])
  assert.deepEqual(parseDelegatedGrantScopes(null), [])
  assert.deepEqual(parseDelegatedGrantScopes('a b'), [])
})

check('címkék: kártya és prompt-felsorolás', () => {
  assert.equal(connectorGrantLabel({ connectorType: 'gmail', connectorName: 'Levelek' }), 'Gmail')
  assert.equal(connectorGrantLabel({ connectorType: 'http_api', connectorName: 'Drive API' }), 'Drive API')
  assert.equal(
    describeConnectorGrantTargets([
      { connectorType: 'gmail', connectorName: 'Levelek' },
      { connectorType: 'http_api', connectorName: 'Drive API' },
      { connectorType: 'gmail', connectorName: 'Másik postafiók' },
    ]),
    'Gmail, Drive API',
  )
  assert.equal(describeConnectorGrantTargets([]), 'a szükséges külső fiók')
})

check('oauth return path: ticket / conversation / origin / fallback', () => {
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
    '/control-plane/account?connected=1',
  )
  assert.equal(
    oauthReturnPath({ kind: 'conversation', id: CONV, agentId: AGENT, originPath: '/control-plane' }),
    '/control-plane?granted=1',
  )
  assert.equal(
    oauthReturnPath(
      { kind: 'conversation', id: CONV, agentId: AGENT, originPath: '/control-plane' },
      { error: 'invalid_client' },
    ),
    '/control-plane?error=invalid_client',
  )
  assert.equal(
    oauthReturnPath(
      { kind: 'conversation', id: CONV, agentId: AGENT, originPath: 'https://evil.example' },
    ),
    `/control-plane/agents/${AGENT}?conversation=${CONV}&granted=1`,
  )
  assert.equal(
    oauthReturnPath({ kind: 'mcp' }),
    '/connectors/oauth/done?connected=1',
  )
  assert.equal(
    oauthReturnPath({ kind: 'mcp' }, { error: 'oauth_state: expired' }),
    '/connectors/oauth/done?error=oauth_state%3A+expired',
  )
})

check('returnTo: csak kind + uuid, nincs nyers URL', () => {
  assert.equal(isSafeOAuthReturnTo({ kind: 'mcp' }), true)
  assert.equal(isSafeOAuthReturnTo({ kind: 'ticket', id: TICKET }), true)
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: CONV, agentId: AGENT }), true)
  assert.equal(
    isSafeOAuthReturnTo({ kind: 'conversation', id: CONV, agentId: AGENT, originPath: '/control-plane' }),
    true,
  )
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: 'not-a-uuid' }), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'conversation', id: CONV, agentId: 'nope' }), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'evil', id: TICKET }), false)
  assert.equal(isSafeOAuthReturnTo('/control-plane/tickets/x?granted=1'), false)
  assert.equal(isSafeOAuthReturnTo({ kind: 'ticket', id: '../../evil' }), false)
})

check('OAuth callback actor: session nélkül a state userId, mismatch tiltva', () => {
  assert.equal(resolveOAuthCallbackActor(null, CONV), CONV)
  assert.equal(resolveOAuthCallbackActor(CONV, CONV), CONV)
  assert.throws(() => resolveOAuthCallbackActor(TICKET, CONV), /user mismatch/)
})

check('payload kártyák: érvényes okok, típus/címke kitöltése', () => {
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
      {
        connectorId: TICKET,
        toolName: 'http_api_get',
        reason: GENERIC_SCOPE_DENIED_REASON,
      },
      { connectorId: AGENT, toolName: 'gmail_send', reason: 'capability_denied' },
      { toolName: 'gmail_search', reason: 'connector_grant_missing' },
    ],
  })
  assert.equal(cards.length, 2)
  assert.equal(cards[0]?.connectorName, 'Levél')
  // Hiányzó típus/név: a tool-ból, illetve a regiszter címkéjéből pótolva.
  assert.equal(cards[1]?.connectorType, 'http_api')
  assert.equal(cards[1]?.connectorName, 'külső fiók')
  assert.deepEqual(cards[1]?.scopes, [])
  assert.deepEqual(readConnectorGrantNeedsFromPayload({}), [])
  assert.deepEqual(readConnectorGrantNeedsFromPayload(null), [])
})

check('élő stream kártya: generikus provider NEM Gmail', () => {
  const generic = connectorGrantCardFromLoopEvent({
    connectorId: CONV,
    toolName: 'http_api_get',
    reason: 'connector_grant_missing',
  })
  assert.equal(generic.connectorType, 'http_api')
  assert.equal(generic.connectorName, 'külső fiók')
  assert.ok(!/gmail/i.test(generic.connectorName))

  const gmail = connectorGrantCardFromLoopEvent({
    connectorId: CONV,
    toolName: 'gmail_search',
    reason: 'connector_grant_missing',
    connectorType: 'gmail',
  })
  assert.equal(gmail.connectorType, 'gmail')
  assert.equal(gmail.connectorName, 'Gmail')
})

check('folytatás-szövegek provider-függetlenek', () => {
  assert.ok(CONNECTOR_GRANT_NEEDED_CHAT_PROMPT.includes('OAuth'))
  assert.ok(!/gmail/i.test(CONNECTOR_GRANT_NEEDED_CHAT_PROMPT))
  assert.ok(CONNECTOR_GRANT_NEEDED_TICKET_NOTE.includes('folytasd'))
  assert.ok(!/gmail/i.test(CONNECTOR_GRANT_NEEDED_TICKET_NOTE))
})

if (failures > 0) {
  console.log(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden teszt zöld.')
