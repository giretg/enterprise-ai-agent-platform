/**
 * #1029 az agent saját e-mail címe: postafiók-felismerés, briefing-blokk,
 * aláírás a kimenő AgentMail-levélben (a jóváhagyás előtt).
 * Futtatás: npm run test:agent-mailbox
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  appendHtmlSignature,
  appendTextSignature,
  isAgentMailSendRequest,
  mailboxConnectorInfo,
  mailIdentityDefinitionBlock,
  renderMailIdentityBriefingLines,
  suggestMailboxUsername,
  withAgentMailSignature,
  type AgentMailIdentity,
} from '../src/domain/agent-mailbox/agent-mailbox'
import { HTTP_API_REQUEST_TOOL, invokeEnterpriseTool, type EnterpriseToolDeps } from '../src/domain/enterprise-tools'
import { renderAgentBriefing } from '../src/lib/agent-checkout'

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const MAILBOX_ID = '55555555-5555-4555-8555-555555555555'
const CRM_ID = '66666666-6666-4666-8666-666666666666'

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

const identity: AgentMailIdentity = {
  primary: {
    connectorId: MAILBOX_ID,
    connectorName: 'AgentMail · szamlazas@ceg.hu',
    kind: 'agentmail',
    address: 'szamlazas@ceg.hu',
    displayName: 'Számlázási asszisztens',
    signature: 'Üdvözlettel,\nSzámlázási asszisztens',
  },
  lostPrimaryAddress: null,
  others: [
    { connectorId: CRM_ID, connectorName: 'AgentMail · ugyfelszolgalat@ceg.hu', kind: 'agentmail', address: 'ugyfelszolgalat@ceg.hu', accessMode: 'read' },
  ],
  userGmail: true,
}

function definition(): AgentDefinition {
  const endpoint = { name: 'send_message', method: 'POST', path: '/messages/send', access: 'write' }
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-10-30T00:00:00.000Z',
    snapshot: {
      name: 'Számlázási asszisztens',
      roleInstruction: 'Számlázás',
      skills: [],
      connectors: [
        { connectorId: MAILBOX_ID, name: 'AgentMail · szamlazas@ceg.hu', type: 'http_api', accessMode: 'write', endpoints: [endpoint] },
        { connectorId: CRM_ID, name: 'AgentMail · ugyfelszolgalat@ceg.hu', type: 'http_api', accessMode: 'write', endpoints: [endpoint] },
      ],
      capabilities: [{ toolName: HTTP_API_REQUEST_TOOL, allowed: true }],
    },
  } as unknown as AgentDefinition
}

function sendDeps(enqueued: Array<Record<string, unknown>>, signature: string | null = identity.primary!.signature): EnterpriseToolDeps {
  return {
    loadDefinition: async () => definition(),
    findCurrentDefinitionId: async () => DEFINITION_ID,
    findAgentGrant: async () => ({ accessLevel: 'operate' }),
    findAgentMailSignature: async () => ({ connectorId: MAILBOX_ID, connectorName: 'AgentMail · szamlazas@ceg.hu', signature }),
    enqueueWrite: async (input) => {
      enqueued.push(input.args)
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'awaiting_approval' }) }] }
    },
  } as unknown as EnterpriseToolDeps
}

function sendArgs(extra: Record<string, unknown> = {}) {
  return {
    definitionId: DEFINITION_ID,
    method: 'POST',
    path: '/messages/send',
    body: JSON.stringify({ to: ['anna@ceg.hu'], subject: 'Összefoglaló', text: 'Szia Anna!' }),
    idempotencyKey: 'idem-1',
    ...extra,
  }
}

const principal = { userId: '11111111-1111-4111-8111-111111111111', tenantId: TENANT_ID, role: 'operator' as const, assumed: false }

async function main() {
  await check('AgentMail-konnektor felismerése, cím a névből', () => {
    assert.deepEqual(
      mailboxConnectorInfo({ type: 'http_api', name: 'AgentMail · Szamlazas@ceg.hu', config: { provider: 'agentmail' } }),
      { kind: 'agentmail', address: 'szamlazas@ceg.hu' },
    )
    assert.equal(mailboxConnectorInfo({ type: 'http_api', name: 'CRM', config: { provider: 'crm' } }), null)
  })

  await check('#1028 tenant-postafiók (config.mailbox) felismerése', () => {
    assert.deepEqual(
      mailboxConnectorInfo({ type: 'gmail', authMode: 'service', name: 'Céges', config: { mailbox: { source: 'google', address: 'info@ceg.hu' } } }),
      { kind: 'google', address: 'info@ceg.hu' },
    )
    assert.equal(
      mailboxConnectorInfo({ type: 'gmail', authMode: 'user_delegated', name: 'Saját', config: { mailbox: { source: 'google' } } }),
      null,
    )
  })

  await check('felhasználónév az agent nevéből', () => {
    assert.equal(suggestMailboxUsername('Számlázási asszisztens'), 'szamlazasi-asszisztens')
    assert.equal(suggestMailboxUsername('  Ügyfél-szolgálat #1 '), 'ugyfel-szolgalat-1')
    assert.equal(suggestMailboxUsername('***'), 'asszisztens')
  })

  await check('aláírás: hozzáfűzés és nincs duplázás', () => {
    const sig = 'Üdvözlettel,\nSzámlázási asszisztens'
    assert.equal(appendTextSignature('Szia!\n', sig), `Szia!\n\n${sig}`)
    assert.equal(appendTextSignature(`Szia!\n\nÜdvözlettel, Számlázási  asszisztens`, sig), `Szia!\n\nÜdvözlettel, Számlázási  asszisztens`)
    assert.equal(appendHtmlSignature('<p>Szia</p>', 'A & B'), '<p>Szia</p><p>A &amp; B</p>')
    assert.equal(appendHtmlSignature('<html><body><p>Hi</p></body></html>', 'X'), '<html><body><p>Hi</p><p>X</p></body></html>')
  })

  await check('csak küldés/válasz útvonal kap aláírást', () => {
    assert.equal(isAgentMailSendRequest('post', '/messages/send'), true)
    assert.equal(isAgentMailSendRequest('POST', 'messages/abc/reply'), true)
    assert.equal(isAgentMailSendRequest('GET', '/messages/send'), false)
    assert.equal(isAgentMailSendRequest('POST', '/threads'), false)
    const args = { method: 'POST', path: '/threads', body: '{"text":"x"}' }
    assert.equal(withAgentMailSignature(args, 'S'), args)
    assert.equal(withAgentMailSignature({ method: 'POST', path: '/messages/send', body: 'nem json' }, 'S').body, 'nem json')
  })

  await check('briefing: saját cím, többi postafiók, user Gmail', () => {
    const lines = renderMailIdentityBriefingLines(identity)!.join('\n')
    assert.match(lines, /Your own e-mail address: `szamlazas@ceg\.hu` \(AgentMail\), display name: Számlázási asszisztens/)
    assert.match(lines, /mail_send, account "szamlazas@ceg\.hu"/)
    assert.match(lines, /the user's own Gmail/)
    assert.match(lines, /`ugyfelszolgalat@ceg\.hu` \(AgentMail\) \(read only\)/)
    assert.match(lines, /only when the user explicitly asks/)
    assert.equal(renderMailIdentityBriefingLines({ primary: null, lostPrimaryAddress: null, others: [], userGmail: true }), null)
  })

  await check('renderAgentBriefing a Start elé teszi a blokkot', () => {
    const text = renderAgentBriefing({ definition: definition(), skills: [], mailIdentity: identity })
    const mail = text.indexOf('## Your e-mail identity')
    assert.ok(mail > 0 && mail < text.indexOf('## Start'))
    assert.equal(renderAgentBriefing({ definition: definition(), skills: [] }).includes('e-mail identity'), false)
  })

  await check('get_definition gépi blokk', () => {
    const block = mailIdentityDefinitionBlock(identity) as { mailIdentity: { primary: { address: string; hasSignature: boolean }; others: unknown[] } }
    assert.equal(block.mailIdentity.primary.address, 'szamlazas@ceg.hu')
    assert.equal(block.mailIdentity.primary.hasSignature, true)
    assert.equal(block.mailIdentity.others.length, 1)
    assert.deepEqual(mailIdentityDefinitionBlock(null), {})
  })

  await check('küldés a saját címről (connectorName) → aláírás a jóváhagyásra váró levélben', async () => {
    const enqueued: Array<Record<string, unknown>> = []
    await invokeEnterpriseTool(sendDeps(enqueued), {
      principal,
      toolName: HTTP_API_REQUEST_TOOL,
      args: sendArgs({ connectorName: 'AgentMail · szamlazas@ceg.hu' }),
    })
    assert.equal(enqueued.length, 1)
    const body = JSON.parse(String(enqueued[0].body))
    assert.equal(body.text, 'Szia Anna!\n\nÜdvözlettel,\nSzámlázási asszisztens')
    assert.deepEqual(body.to, ['anna@ceg.hu'])
  })

  await check('másik postafiókból küldve nincs aláírás', async () => {
    const enqueued: Array<Record<string, unknown>> = []
    await invokeEnterpriseTool(sendDeps(enqueued), {
      principal,
      toolName: HTTP_API_REQUEST_TOOL,
      args: sendArgs({ connectorId: CRM_ID }),
    })
    assert.equal(JSON.parse(String(enqueued[0].body)).text, 'Szia Anna!')
  })

  await check('konnektor megnevezése nélkül, két jelölt mellett nincs találgatás', async () => {
    const enqueued: Array<Record<string, unknown>> = []
    await invokeEnterpriseTool(sendDeps(enqueued), { principal, toolName: HTTP_API_REQUEST_TOOL, args: sendArgs() })
    assert.equal(JSON.parse(String(enqueued[0].body)).text, 'Szia Anna!')
  })

  await check('üres aláírás → változatlan levél', async () => {
    const enqueued: Array<Record<string, unknown>> = []
    await invokeEnterpriseTool(sendDeps(enqueued, null), {
      principal,
      toolName: HTTP_API_REQUEST_TOOL,
      args: sendArgs({ connectorId: MAILBOX_ID }),
    })
    assert.equal(JSON.parse(String(enqueued[0].body)).text, 'Szia Anna!')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

void main()
