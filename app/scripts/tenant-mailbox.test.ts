/**
 * #1028 tenant-szintű postafiók: jogosultság, token-feloldás, csak-olvasás, kikényszerített jóváhagyás.
 * Futtatás: npm run test:tenant-mailbox
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connector, ConnectorGrant } from '@prisma/client'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  authorizeToolCall,
  invokeEnterpriseTool,
  type AuthorizeToolCallDeps,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type LiveGrantRow,
} from '../src/domain/enterprise-tools'
import { ConnectorGrantService, type TenantMailboxBrokenEvent } from '../src/domain/connector-grant/connector-grant-service'
import { createGrantTokenStore } from '../src/domain/connector-grant/grant-token-vault'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'
import {
  MICROSOFT_SEND_MAIL_ENDPOINT,
  TENANT_MAILBOX_DISCONNECTED,
  assertTenantMailboxAccessMode,
  connectorUsesGrantToken,
  microsoftMailboxConfig,
  tenantMailboxDisconnectedMessage,
  tenantMailboxOf,
  tenantMailboxScopes,
} from '../src/domain/connector-grant/tenant-mailbox'
import type { ConnectorGrantRepository } from '../src/repositories/interfaces'

process.env.CONNECTOR_GRANT_TOKEN_DIR = mkdtempSync(join(tmpdir(), 'tenant-mailbox-'))
delete process.env.CONNECTOR_GRANT_SECRET_PREFIX

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '99999999-9999-4999-8999-999999999999'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const MAILBOX_ID = '55555555-5555-4555-8555-555555555555'
const GRANT_ID = '66666666-6666-4666-8666-666666666666'
const ADDRESS = 'szamlazas@ceg.hu'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

function mailboxConnector(mailbox: Record<string, unknown> = {}): LiveConnectorRow {
  return {
    id: MAILBOX_ID,
    tenantId: TENANT_ID,
    type: 'gmail',
    authMode: 'service',
    lifecycleState: 'active',
    name: `Postafiók · ${ADDRESS}`,
    config: { provider: 'google', mailbox: { source: 'google', readOnly: false, requireApproval: true, address: ADDRESS, ...mailbox } },
  }
}

function tenantGrant(scopes: string[] = [GMAIL_SCOPES.modify]): LiveGrantRow {
  return { id: GRANT_ID, tokenRef: 'tenant/x/mailbox', scopes, status: 'active', accountLabel: ADDRESS }
}

function definition(accessMode: 'read' | 'write', tools: string[]): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 1,
    tenantId: TENANT_ID,
    status: 'active',
    publishedAt: '2026-10-30T00:00:00.000Z',
    snapshot: {
      name: 'Számlázó',
      roleInstruction: 'Számlák',
      skills: [],
      connectors: [{ connectorId: MAILBOX_ID, type: 'gmail', accessMode, name: `Postafiók · ${ADDRESS}` }],
      capabilities: tools.map((toolName) => ({ toolName, allowed: true })),
    },
  } as AgentDefinition
}

/** A user-grant keresők hívása hiba: a tenant-postafiók nem nyúlhat a hívó grantjeihez. */
function authorizeDeps(opts: { connector?: LiveConnectorRow; grant?: LiveGrantRow | null }): AuthorizeToolCallDeps {
  return {
    async findConnector() {
      return opts.connector ?? mailboxConnector()
    },
    async findActiveGrant() {
      throw new Error('user grant lookup must not run for a tenant mailbox')
    },
    async findActiveGrants() {
      throw new Error('user grant lookup must not run for a tenant mailbox')
    },
    async findActiveTenantGrant() {
      return opts.grant === undefined ? tenantGrant() : opts.grant
    },
  }
}

const principal = { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false }

async function main() {
  console.log('tenant-mailbox')

  await check('mailbox flag only counts on service connectors', () => {
    assert.ok(tenantMailboxOf(mailboxConnector()))
    assert.equal(tenantMailboxOf({ ...mailboxConnector(), authMode: 'user_delegated' }), null)
    assert.equal(tenantMailboxOf({ authMode: 'service', config: { mailbox: { source: 'yahoo' } } }), null)
    assert.equal(connectorUsesGrantToken(mailboxConnector()), true)
    assert.equal(connectorUsesGrantToken({ authMode: 'service', config: {} }), false)
    assert.equal(tenantMailboxOf({ authMode: 'service', config: { mailbox: { source: 'google' } } })?.requireApproval, true)
  })

  await check('read-only mailbox: scopes are read-only and write binding is refused', () => {
    assert.deepEqual(tenantMailboxScopes('google', true), ['gmail.readonly'])
    assert.ok(!tenantMailboxScopes('microsoft', true).includes('Mail.Send'))
    assert.ok(tenantMailboxScopes('microsoft', false).includes('Mail.Send'))
    const readOnly = tenantMailboxOf(mailboxConnector({ readOnly: true }))
    assert.throws(() => assertTenantMailboxAccessMode(readOnly, 'write'), /tenant_mailbox_read_only/)
    assertTenantMailboxAccessMode(readOnly, 'read')
  })

  await check('Microsoft clone adds send endpoint and scopes only when writable', () => {
    const base = { auth: { scheme: 'oauth2', scope: 'offline_access User.Read' }, endpoints: [{ name: 'me', path: '/v1.0/me' }] }
    const writable = microsoftMailboxConfig(base, { source: 'microsoft', readOnly: false, requireApproval: true })
    assert.match(String((writable.auth as { scope: string }).scope), /Mail\.Send/)
    assert.ok((writable.endpoints as Array<{ path: string }>).some((e) => e.path === MICROSOFT_SEND_MAIL_ENDPOINT.path))
    const readOnly = microsoftMailboxConfig(base, { source: 'microsoft', readOnly: true, requireApproval: true })
    assert.doesNotMatch(String((readOnly.auth as { scope: string }).scope), /Mail\.Send/)
    assert.equal((readOnly.endpoints as unknown[]).length, 1)
  })

  await check('any operator reads the shared mailbox without own Gmail grant', async () => {
    const result = await authorizeToolCall(authorizeDeps({}), {
      principal,
      definition: definition('read', ['gmail_search']),
      toolName: 'gmail_search',
      args: { definitionId: DEFINITION_ID, query: 'is:unread' },
    })
    assert.equal(result.allowed, true)
    assert.ok(result.allowed && result.grantId === GRANT_ID)
  })

  await check('read binding cannot send', async () => {
    const result = await authorizeToolCall(authorizeDeps({}), {
      principal,
      definition: definition('read', ['gmail_send']),
      toolName: 'gmail_send',
      args: { definitionId: DEFINITION_ID, to: 'a@b.hu', subject: 'x', body: 'y', idempotencyKey: 'k' },
    })
    assert.equal(result.allowed, false)
    assert.ok(!result.allowed && result.reason === 'missing_gmail_connector_write')
  })

  await check('read-only grant cannot send even with a write binding', async () => {
    const result = await authorizeToolCall(authorizeDeps({ grant: tenantGrant([GMAIL_SCOPES.readonly]) }), {
      principal,
      definition: definition('write', ['gmail_send']),
      toolName: 'gmail_send',
      args: { definitionId: DEFINITION_ID, to: 'a@b.hu', subject: 'x', body: 'y', idempotencyKey: 'k' },
    })
    assert.equal(result.allowed, false)
  })

  await check('missing tenant grant → disconnected with the mailbox address', async () => {
    const result = await authorizeToolCall(authorizeDeps({ grant: null }), {
      principal,
      definition: definition('read', ['gmail_search']),
      toolName: 'gmail_search',
      args: { definitionId: DEFINITION_ID, query: 'x' },
    })
    assert.ok(!result.allowed && result.reason === TENANT_MAILBOX_DISCONNECTED)
    assert.ok(!result.allowed && result.mailboxAddress === ADDRESS)
  })

  function invokeDeps(extra: Partial<EnterpriseToolDeps> = {}, def = definition('write', ['gmail_send', 'gmail_search'])): EnterpriseToolDeps {
    return {
      ...authorizeDeps({}),
      async loadDefinition() {
        return def
      },
      async findCurrentDefinitionId() {
        return DEFINITION_ID
      },
      async findAgentGrant() {
        return { accessLevel: 'operate' }
      },
      async resolveAccessToken() {
        return 'stub-tenant-token'
      },
      ...extra,
    }
  }

  await check('broken mailbox: plain-language message, no OAuth link', async () => {
    let authStarted = false
    const result = await invokeEnterpriseTool(
      invokeDeps({
        async resolveAccessToken() {
          throw new Error('grant_token_expired')
        },
        async startAuthorization() {
          authStarted = true
          return { url: 'https://accounts.google.com/x' }
        },
        async executeGmailTool() {
          throw new Error('must not run')
        },
      }),
      { principal, toolName: 'gmail_search', args: { definitionId: DEFINITION_ID, query: 'x' } },
    )
    assert.equal(result.isError, true)
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>
    assert.equal(payload.code, TENANT_MAILBOX_DISCONNECTED)
    assert.equal(payload.message, tenantMailboxDisconnectedMessage(ADDRESS))
    assert.equal(payload.authorizationUrl, undefined)
    assert.equal(authStarted, false)
  })

  await check('tool call audit carries the mailbox address and the initiating user', async () => {
    const audit: Array<{ action: string; metadata?: unknown; actorId?: string | null }> = []
    await invokeEnterpriseTool(
      invokeDeps({
        audit: {
          async append(data) {
            audit.push({ action: data.action, metadata: data.metadata, actorId: data.actorId })
          },
        },
        async executeGmailTool() {
          return { messages: [] }
        },
      }),
      { principal, toolName: 'gmail_search', args: { definitionId: DEFINITION_ID, query: 'x' } },
    )
    const ok = audit.find((row) => row.action === 'enterprise.tool.ok')
    assert.equal((ok?.metadata as { mailbox?: string }).mailbox, ADDRESS)
    assert.equal(ok?.actorId, USER_ID)
  })

  await check('forced approval: agent direct Gmail mode still queues the send', async () => {
    const enqueued: string[] = []
    let sent = false
    const deps = invokeDeps({
      async findAgentWriteModes() {
        return { memory: 'approval', httpApi: 'approval', gmail: 'direct', drive: 'approval' }
      },
      async enqueueWrite(input: { toolName: string }) {
        enqueued.push(input.toolName)
        return { content: [{ type: 'text' as const, text: '{"status":"awaiting_approval"}' }] }
      },
      async executeGmailTool() {
        sent = true
        return { messageId: 'm' }
      },
    })
    const args = { definitionId: DEFINITION_ID, to: 'a@b.hu', subject: 'x', body: 'y', idempotencyKey: 'k1' }
    await invokeEnterpriseTool(deps, { principal, toolName: 'gmail_send', args })
    assert.deepEqual(enqueued, ['gmail_send'])
    assert.equal(sent, false)

    // Kikapcsolt kényszerrel az agent közvetlen módja érvényes.
    const relaxed = mailboxConnector({ requireApproval: false })
    await invokeEnterpriseTool(
      { ...deps, findConnector: async () => relaxed },
      { principal, toolName: 'gmail_send', args: { ...args, idempotencyKey: 'k2' } },
    )
    assert.equal(sent, true)
  })

  // ── ConnectorGrantService: a tenant-grant tokenje a hívó usertől független ──
  function grantRow(overrides: Partial<ConnectorGrant>): ConnectorGrant {
    return {
      id: GRANT_ID,
      tenantId: TENANT_ID,
      connectorId: MAILBOX_ID,
      userId: null,
      ownerType: 'tenant',
      status: 'active',
      scopes: [GMAIL_SCOPES.modify],
      tokenRef: `tenant/${TENANT_ID}/mailbox/connector/${MAILBOX_ID}/account/test`,
      accountLabel: ADDRESS,
      nickname: null,
      grantedAt: new Date(),
      expiresAt: null,
      lastRefreshedAt: null,
      revokedAt: null,
      metadata: {},
      ...overrides,
    }
  }
  function service(grant: ConnectorGrant, events: TenantMailboxBrokenEvent[] = []) {
    const statuses: string[] = []
    const repo = {
      async findById() {
        return grant
      },
      async updateStatus(_id: string, status: string) {
        statuses.push(status)
        return grant
      },
    } as unknown as ConnectorGrantRepository
    return { svc: new ConnectorGrantService(repo, undefined, async (e) => void events.push(e)), statuses }
  }
  const prismaConnector = (overrides: Partial<Connector> = {}) =>
    ({ ...mailboxConnector(), secretAlias: null, ...overrides }) as unknown as Connector

  await createGrantTokenStore(grantRow({}).tokenRef).save({
    accessToken: 'tenant-access',
    refreshToken: 'tenant-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: [GMAIL_SCOPES.modify],
  })

  await check('tenant grant token resolves for any operator of the tenant', async () => {
    const { svc } = service(grantRow({}))
    for (const actingUserId of [USER_ID, OTHER_USER]) {
      const token = await svc.resolveAccessToken({
        connector: prismaConnector(),
        grantId: GRANT_ID,
        tokenRef: grantRow({}).tokenRef,
        actingUserId,
        tenantId: TENANT_ID,
      })
      assert.equal(token, 'tenant-access')
    }
  })

  await check('tenant grant is refused on a non-mailbox connector and across tenants', async () => {
    const { svc } = service(grantRow({}))
    await assert.rejects(
      svc.resolveAccessToken({
        connector: prismaConnector({ authMode: 'user_delegated' }),
        grantId: GRANT_ID,
        tokenRef: grantRow({}).tokenRef,
        actingUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
      /connector_grant_forbidden/,
    )
    await assert.rejects(
      svc.resolveAccessToken({
        connector: prismaConnector(),
        grantId: GRANT_ID,
        tokenRef: grantRow({}).tokenRef,
        actingUserId: USER_ID,
        tenantId: '77777777-7777-4777-8777-777777777777',
      }),
      /connector_grant_forbidden/,
    )
  })

  await check('user grant still only resolves for its owner', async () => {
    const { svc } = service(grantRow({ ownerType: 'user', userId: OTHER_USER }))
    await assert.rejects(
      svc.resolveAccessToken({
        connector: prismaConnector({ authMode: 'user_delegated' }),
        grantId: GRANT_ID,
        tokenRef: grantRow({}).tokenRef,
        actingUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
      /connector_grant_forbidden/,
    )
  })

  await check('expired tenant grant notifies the admin side, not the user', async () => {
    const events: TenantMailboxBrokenEvent[] = []
    const { svc, statuses } = service(grantRow({}), events)
    await svc.markGrantExpired({
      grantId: GRANT_ID,
      connectorId: MAILBOX_ID,
      actingUserId: USER_ID,
      tenantId: TENANT_ID,
      metadata: { reason: 'refresh_failed' },
    })
    assert.deepEqual(statuses, ['expired'])
    assert.equal(events.length, 1)
    assert.equal(events[0].address, ADDRESS)
    assert.equal(events[0].reason, 'refresh_failed')
  })

  if (failures > 0) {
    console.error(`${failures} failure(s)`)
    process.exit(1)
  }
  console.log('all passed')
}

void main()
