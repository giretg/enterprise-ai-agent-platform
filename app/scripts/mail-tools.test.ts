/**
 * #1030 egységes mail_* eszközök: fiókfeloldás, keresés, válasz, read-only tiltás.
 * Futtatás: npm run test:mail-tools
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  authorizeToolCall,
  invokeEnterpriseTool,
  MAIL_LIST_ACCOUNTS_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_SEND_TOOL,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type LiveGrantRow,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { composeFromReply, gmailSearchQuery, resolveMailAccounts, type MailAccount } from '../src/domain/mail/mail'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const GMAIL_ID = '55555555-5555-4555-8555-555555555555'
const AGENTMAIL_ID = '66666666-6666-4666-8666-666666666666'
const GRANT_ID = '77777777-7777-4777-8777-777777777777'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const principal: ToolCallPrincipal = { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false }

function definition(connectors: AgentDefinition['snapshot']['connectors'], tools: string[]): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-10-30T00:00:00.000Z',
    snapshot: {
      name: 'Mail',
      roleInstruction: 'Mail',
      skills: [],
      connectors,
      capabilities: tools.map((toolName) => ({ toolName, allowed: true })),
    },
  }
}

function grant(): LiveGrantRow {
  return {
    id: GRANT_ID,
    tokenRef: 'stub-gmail',
    scopes: [GMAIL_SCOPES.modify],
    status: 'active',
    accountLabel: 'peter@gmail.com',
    nickname: 'saját',
  }
}

function parsePayload(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

const accounts: MailAccount[] = [
  {
    account: 'szamlazas@ceg.hu',
    address: 'szamlazas@ceg.hu',
    kind: 'agentmail',
    access: 'write',
    primary: true,
    connectorId: AGENTMAIL_ID,
  },
  {
    account: 'ugyfelszolgalat@ceg.hu',
    address: 'ugyfelszolgalat@ceg.hu',
    kind: 'agentmail',
    access: 'read',
    primary: false,
    connectorId: '99999999-9999-4999-8999-999999999999',
  },
]

async function main() {
  await check('gmail query a strukturált mezőkből', () => {
    assert.equal(
      gmailSearchQuery({ from: 'nav.gov.hu', unread: true, after: '2026-01-01', query: 'NAV' }),
      'NAV from:nav.gov.hu is:unread after:2026/01/01',
    )
  })

  await check('compose: Re: tárgy, szál, címzett a feladó', () => {
    const composed = composeFromReply(
      {
        threadId: 't1',
        from: 'Anna <anna@x.hu>',
        replyTo: '',
        to: 'szamlazas@ceg.hu',
        cc: 'bela@x.hu',
        subject: 'Számla',
        messageIdHeader: '<m1@x>',
        references: '',
      },
      'szamlazas@ceg.hu',
      { body: 'Köszönöm', replyToMessageId: 'm1' },
    )
    assert.equal(composed.subject, 'Re: Számla')
    assert.equal(composed.to, 'Anna <anna@x.hu>')
    assert.equal(composed.threadId, 't1')
    assert.equal(composed.inReplyTo, '<m1@x>')
  })

  await check('account: nincs megadva → elsődleges; all; read-only írás', () => {
    const primary = resolveMailAccounts(accounts, undefined, { write: true, primaryConnectorId: AGENTMAIL_ID })
    assert.equal(primary.ok, true)
    if (primary.ok) assert.equal(primary.accounts[0]!.account, 'szamlazas@ceg.hu')

    const all = resolveMailAccounts(accounts, 'all', { allAllowed: true })
    assert.equal(all.ok, true)
    if (all.ok) assert.equal(all.accounts.length, 2)

    const readOnly = resolveMailAccounts(accounts, 'ugyfelszolgalat@ceg.hu', { write: true })
    assert.equal(readOnly.ok, false)
    if (!readOnly.ok) assert.equal(readOnly.reason, 'mailbox_read_only')

    const ambiguous = resolveMailAccounts(accounts, undefined, { write: false })
    // primary wins even with two accounts
    assert.equal(ambiguous.ok, true)
  })

  const gmailConnector: LiveConnectorRow = {
    id: GMAIL_ID,
    tenantId: TENANT_ID,
    type: 'gmail',
    authMode: 'user_delegated',
    lifecycleState: 'active',
    name: 'Gmail',
  }

  function invokeDeps(extra: Partial<EnterpriseToolDeps> = {}): EnterpriseToolDeps {
    const def = definition(
      [{ connectorId: GMAIL_ID, type: 'gmail', accessMode: 'write', name: 'Gmail' }],
      [MAIL_SEARCH_TOOL, MAIL_LIST_ACCOUNTS_TOOL, MAIL_SEND_TOOL],
    )
    return {
      loadDefinition: async () => def,
      findCurrentDefinitionId: async () => DEFINITION_ID,
      findAgentGrant: async () => ({ accessLevel: 'operate' }),
      findConnector: async () => gmailConnector,
      findActiveGrant: async () => grant(),
      findActiveGrants: async () => [grant()],
      resolveAccessToken: async () => 'stub-gmail-token',
      ...extra,
    } as unknown as EnterpriseToolDeps
  }

  await check('mail_search Gmail stub: ugyanaz a kérés találatot ad', async () => {
    const result = await invokeEnterpriseTool(invokeDeps(), {
      principal,
      toolName: MAIL_SEARCH_TOOL,
      args: { definitionId: DEFINITION_ID, query: 'stub' },
    })
    assert.equal(result.isError, undefined)
    const payload = parsePayload(result)
    const messages = payload.messages as Array<{ account: string; messageId: string; subject: string }>
    assert.ok(messages.length > 0)
    assert.ok(messages[0]!.messageId)
    assert.ok('subject' in messages[0]!)
  })

  await check('mail_list_accounts a Gmail-fiókot listázza', async () => {
    const result = await invokeEnterpriseTool(invokeDeps(), {
      principal,
      toolName: MAIL_LIST_ACCOUNTS_TOOL,
      args: { definitionId: DEFINITION_ID },
    })
    const payload = parsePayload(result)
    const listed = payload.accounts as Array<{ account: string; kind: string }>
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.kind, 'google')
  })

  await check('mail_search account=all mindkét fiókot megjelöli', async () => {
    const agentmail: LiveConnectorRow = {
      id: AGENTMAIL_ID,
      tenantId: TENANT_ID,
      type: 'http_api',
      authMode: 'service',
      lifecycleState: 'active',
      name: 'AgentMail · szamlazas@ceg.hu',
      secretAlias: 'stub-agentmail',
      config: {
        provider: 'agentmail',
        baseUrl: 'https://api.agentmail.eu/inboxes/inb_1',
        auth: { scheme: 'bearer' },
        endpoints: [
          { method: 'GET', path: '/messages', access: 'read' },
          { method: 'GET', path: '/messages/{message_id}', access: 'read' },
          { method: 'POST', path: '/messages/send', access: 'write' },
          { method: 'POST', path: '/messages/{message_id}/reply', access: 'write' },
        ],
      },
    }
    const def = definition(
      [
        { connectorId: GMAIL_ID, type: 'gmail', accessMode: 'write', name: 'Gmail' },
        { connectorId: AGENTMAIL_ID, type: 'http_api', accessMode: 'write', name: 'AgentMail · szamlazas@ceg.hu' },
      ],
      [MAIL_SEARCH_TOOL],
    )
    const result = await invokeEnterpriseTool(
      {
        ...invokeDeps(),
        loadDefinition: async () => def,
        findConnector: async (id) => (id === AGENTMAIL_ID ? agentmail : gmailConnector),
        findActiveGrant: async ({ connectorId }) => (connectorId === GMAIL_ID ? grant() : null),
        findActiveGrants: async ({ connectorId }) => (connectorId === GMAIL_ID ? [grant()] : []),
        executeMailTool: async ({ account }) => ({
          messages: [{ account, messageId: `${account}-1`, threadId: 't', from: 'nav@nav.gov.hu', to: account, cc: '', subject: 'NAV', date: '2026-01-01', snippet: 'NAV', labels: ['unread'], hasAttachments: false }],
        }),
      },
      {
        principal,
        toolName: MAIL_SEARCH_TOOL,
        args: { definitionId: DEFINITION_ID, query: 'NAV', account: 'all' },
      },
    )
    const payload = parsePayload(result)
    const messages = payload.messages as Array<{ account: string }>
    const tags = new Set(messages.map((row) => row.account))
    assert.ok(tags.size >= 2, `expected two accounts, got ${[...tags]}`)
  })

  await check('mail_send read-only postafiókon mailbox_read_only', async () => {
    const readConnector: LiveConnectorRow = {
      id: AGENTMAIL_ID,
      tenantId: TENANT_ID,
      type: 'http_api',
      authMode: 'service',
      lifecycleState: 'active',
      name: 'AgentMail · ugyfelszolgalat@ceg.hu',
      config: { provider: 'agentmail', baseUrl: 'https://api.agentmail.eu/inboxes/inb_2', auth: { scheme: 'bearer' } },
    }
    const def = definition(
      [{ connectorId: AGENTMAIL_ID, type: 'http_api', accessMode: 'read', name: 'AgentMail · ugyfelszolgalat@ceg.hu' }],
      [MAIL_SEND_TOOL, MAIL_SEARCH_TOOL],
    )
    const authorized = await authorizeToolCall(
      {
        findConnector: async () => readConnector,
        findActiveGrant: async () => null,
      },
      {
        principal,
        definition: def,
        toolName: MAIL_SEND_TOOL,
        args: {
          account: 'ugyfelszolgalat@ceg.hu',
          to: 'a@b.hu',
          subject: 'x',
          body: 'y',
          idempotencyKey: 'k1',
        },
      },
    )
    assert.equal(authorized.allowed, false)
    if (!authorized.allowed) assert.equal(authorized.reason, 'mailbox_read_only')
  })

  await check('AgentMail válasz: reply útvonal, nem új levél', async () => {
    const { mailProviderFor } = await import('../src/domain/mail/providers')
    const connector: LiveConnectorRow = {
      id: AGENTMAIL_ID,
      tenantId: TENANT_ID,
      type: 'http_api',
      authMode: 'service',
      lifecycleState: 'active',
      name: 'AgentMail · szamlazas@ceg.hu',
      secretAlias: 'stub-agentmail',
      config: {
        provider: 'agentmail',
        baseUrl: 'https://api.agentmail.eu/inboxes/inb_1',
        auth: { scheme: 'bearer' },
        endpoints: [
          { method: 'POST', path: '/messages/send', access: 'write' },
          { method: 'POST', path: '/messages/{message_id}/reply', access: 'write' },
        ],
      },
    }
    const provider = mailProviderFor(connector, 'stub-key', 'szamlazas@ceg.hu')
    const sent = await provider.send({
      body: 'Köszönöm',
      subject: '',
      replyToMessageId: 'msg_abc',
      replyAll: false,
    })
    assert.equal(sent.messageId, 'msg_abc')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

void main()
