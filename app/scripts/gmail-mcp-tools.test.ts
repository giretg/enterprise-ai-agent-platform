/**
 * Gmail MCP-eszközök: küldés/válasz/piszkozat/címkézés/kuka jóváhagyással.
 * Futtatás: npm run test:gmail-mcp-tools
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_SEND_TOOL,
  GMAIL_TRASH_TOOL,
  schemaForEnterpriseTool,
  type LiveGrantRow,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { resolveCompose } from '../src/domain/enterprise-tools/handlers/gmail'
import { approveGatewayOperation, enqueueGatewayOperation, type GatewayOperationServiceDeps } from '../src/domain/gateway-operation'
import { GMAIL_SCOPES, gmailToolAllowedByScopes } from '../src/domain/connector-grant/gmail-scopes'
import { buildRawMessage, GmailApiClient } from '../src/domain/connector-grant/gmail-api-client'
import { MemoryGatewayOperationStore } from './memory-gateway-operation-store'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const principal: ToolCallPrincipal = { userId: USER_ID, tenantId: TENANT_ID, role: 'admin', assumed: false }

function definition(): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-01-02T00:00:00.000Z',
    snapshot: {
      name: 'Mail assistant',
      roleInstruction: 'Handle mail',
      skills: [],
      connectors: [{ connectorId: CONNECTOR_ID, type: 'gmail', accessMode: 'write' }],
      capabilities: [{ toolName: GMAIL_SEND_TOOL, allowed: true }],
    },
  }
}

function deps(grant: LiveGrantRow, calls: Array<{ tool: string; args: Record<string, unknown> }>): GatewayOperationServiceDeps {
  return {
    operations: new MemoryGatewayOperationStore(),
    loadDefinition: async () => definition(),
    findCurrentDefinitionId: async () => DEFINITION_ID,
    findAgentGrant: async () => ({ accessLevel: 'operate' }),
    findConnector: async () => ({
      id: CONNECTOR_ID,
      tenantId: TENANT_ID,
      type: 'gmail',
      authMode: 'user_delegated',
      lifecycleState: 'active',
    }),
    findActiveGrant: async () => grant,
    resolveAccessToken: async () => 'stub-gmail-token',
    resolveRequester: async () => ({ role: 'admin', assumed: false }),
    executeGmailTool: async (tool, args) => {
      calls.push({ tool, args })
      return { messageId: 'sent-1', threadId: 'thread-1' }
    },
  }
}

const modifyGrant: LiveGrantRow = { id: 'g1', tokenRef: 't', scopes: [GMAIL_SCOPES.modify], status: 'active' }

async function main() {
  await check('gmail.modify (the default "read + write" connector) may send, label and trash', () => {
    for (const tool of ['gmail_send', 'gmail_create_draft', 'gmail_modify_labels', 'gmail_trash', 'gmail_get_thread'] as const) {
      assert.equal(gmailToolAllowedByScopes({ tool, scopes: [GMAIL_SCOPES.modify] }), true, tool)
    }
  })

  await check('send-only grant sends new mail but cannot reply (needs to read the original)', () => {
    const scopes = [GMAIL_SCOPES.send]
    assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', scopes }), true)
    assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', args: { replyToMessageId: 'm1' }, scopes }), false)
    assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_trash', scopes }), false)
  })

  await check('readonly grant cannot send', () => {
    assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', scopes: [GMAIL_SCOPES.readonly] }), false)
  })

  await check('send schema: reply needs only body; new mail needs to+subject+body; draftId alone is enough', () => {
    const schema = schemaForEnterpriseTool(GMAIL_SEND_TOOL)!
    const base = { definitionId: DEFINITION_ID, idempotencyKey: 'k' }
    assert.equal(schema.safeParse({ ...base, replyToMessageId: 'm1', body: 'Köszi!' }).success, true)
    assert.equal(schema.safeParse({ ...base, replyToMessageId: 'm1' }).success, false)
    assert.equal(schema.safeParse({ ...base, to: 'a@b.hu', body: 'x' }).success, false)
    assert.equal(schema.safeParse({ ...base, to: 'a@b.hu', subject: 's', body: 'x' }).success, true)
    assert.equal(schema.safeParse({ ...base, draftId: 'd1' }).success, true)
  })

  await check('modify/trash schema: exactly one of messageId/threadId', () => {
    const base = { definitionId: DEFINITION_ID, idempotencyKey: 'k' }
    const trash = schemaForEnterpriseTool(GMAIL_TRASH_TOOL)!
    assert.equal(trash.safeParse({ ...base, messageId: 'm' }).success, true)
    assert.equal(trash.safeParse({ ...base }).success, false)
    assert.equal(trash.safeParse({ ...base, messageId: 'm', threadId: 't' }).success, false)
    const modify = schemaForEnterpriseTool(GMAIL_MODIFY_LABELS_TOOL)!
    assert.equal(modify.safeParse({ ...base, threadId: 't', removeLabelIds: 'UNREAD' }).success, true)
    assert.equal(modify.safeParse({ ...base, threadId: 't' }).success, false)
  })

  await check('reply keeps the thread: Re: subject, In-Reply-To/References, original sender', async () => {
    const fake = {
      getReplyContext: async () => ({
        threadId: 'thr-9',
        from: 'Csilla <csilla@okoskassza.hu>',
        replyTo: '',
        to: 'me@excellencepay.com, Béla <bela@x.hu>',
        cc: 'cc@x.hu',
        subject: 'Okoskassza ajánlat',
        messageIdHeader: '<orig@mail>',
        references: '<older@mail>',
      }),
      getProfileEmail: async () => 'me@excellencepay.com',
    } as unknown as GmailApiClient
    const reply = await resolveCompose(fake, { replyToMessageId: 'm1', body: 'Köszi!' })
    assert.equal(reply.to, 'Csilla <csilla@okoskassza.hu>')
    assert.equal(reply.subject, 'Re: Okoskassza ajánlat')
    assert.equal(reply.threadId, 'thr-9')
    assert.equal(reply.inReplyTo, '<orig@mail>')
    assert.equal(reply.references, '<older@mail> <orig@mail>')

    const all = await resolveCompose(fake, { replyToMessageId: 'm1', body: 'x', replyAll: true })
    assert.equal(all.to, 'Csilla <csilla@okoskassza.hu>, Béla <bela@x.hu>')
    assert.equal(all.cc, 'cc@x.hu')
  })

  await check('raw message strips CR/LF from headers (no header injection) and sets threading headers', () => {
    const raw = buildRawMessage({
      to: 'a@b.hu\r\nBcc: evil@x.hu',
      subject: 'Re: Árajánlat',
      body: 'Köszi!',
      inReplyTo: '<orig@mail>',
      references: '<orig@mail>',
    })
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    assert.ok(!/^Bcc:/m.test(text), text)
    assert.ok(/^In-Reply-To: <orig@mail>$/m.test(text))
    assert.ok(/^References: <orig@mail>$/m.test(text))
  })

  await check('gmail_send waits for approval, then sends exactly once', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const wired = deps(modifyGrant, calls)
    const enqueued = await enqueueGatewayOperation(wired, {
      principal,
      toolName: GMAIL_SEND_TOOL,
      args: { definitionId: DEFINITION_ID, replyToMessageId: 'm1', body: 'Köszi!', idempotencyKey: 'send-1' },
    })
    assert.equal(enqueued.ok, true)
    if (!enqueued.ok) return
    assert.equal(enqueued.view.status, 'awaiting_approval')
    assert.equal(calls.length, 0)
    const approved = await approveGatewayOperation(wired, {
      tenantId: TENANT_ID,
      operationId: enqueued.view.operationId,
      actor: principal,
    })
    assert.equal(approved.ok, true)
    if (!approved.ok) return
    assert.equal(approved.view.status, 'succeeded')
    assert.deepEqual(calls.map((c) => c.tool), [GMAIL_SEND_TOOL])
    assert.equal(calls[0]?.args.replyToMessageId, 'm1')
  })

  await check('gmail_send with a readonly grant is denied at enqueue', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const result = await enqueueGatewayOperation(
      deps({ ...modifyGrant, scopes: [GMAIL_SCOPES.readonly] }, calls),
      {
        principal,
        toolName: GMAIL_SEND_TOOL,
        args: { definitionId: DEFINITION_ID, to: 'a@b.hu', subject: 's', body: 'x', idempotencyKey: 'send-2' },
      },
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'gmail_scope_not_granted')
  })

  await check('getMessage reads nested multipart body, cc and attachments', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          snippet: 'snip',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'a@b.hu' },
              { name: 'Cc', value: 'c@d.hu' },
              { name: 'Message-ID', value: '<m1@mail>' },
            ],
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  { mimeType: 'text/html', body: { data: b64('<p>HTML</p>') } },
                  { mimeType: 'text/plain', body: { data: b64('Szia Csilla!') } },
                ],
              },
              { mimeType: 'application/pdf', filename: 'ajanlat.pdf', body: { attachmentId: 'att1', size: 10 } },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch
    try {
      const message = await new GmailApiClient('real-token').getMessage({ id: 'm1' })
      assert.equal(message.body, 'Szia Csilla!')
      assert.equal(message.cc, 'c@d.hu')
      assert.equal(message.messageIdHeader, '<m1@mail>')
      assert.deepEqual(message.labelIds, ['INBOX', 'UNREAD'])
      assert.equal(message.attachments[0]?.fileName, 'ajanlat.pdf')
    } finally {
      globalThis.fetch = original
    }
  })

  console.log(`\n${failures === 0 ? 'gmail-mcp-tools: ok' : `gmail-mcp-tools: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
