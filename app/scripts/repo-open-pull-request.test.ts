/**
 * Determinisztikus teszt a `repo_open_pull_request` tool-hoz (branch+commit+PR
 * a repo_prepare-rel importált workspace-klón és a friss GitHub bázisref közti
 * diffből) — DB és élő GitHub API NÉLKÜL, in-memory fake-ekkel + fetch-mockkal.
 *
 * Kontextus: a chat-agent korábban le tudta klónozni + szerkeszteni a repót
 * (repo_prepare + file_edit), de nem volt semmilyen tool, ami ezt ténylegesen
 * GitHub PR-ré tudta volna alakítani. Ez a teszt azt igazolja, hogy:
 *   - repo_prepare nélkül a hívás hangosan bukik (nem hallgat, nem talál ki sikert),
 *   - változás nélkül changed:false-t ad, GitHub write hívás nélkül,
 *   - módosított/törölt fájlok esetén helyes tree-diffet küld és PR-t nyit.
 *
 * Futtatás: npm run test:repo-pr
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { ToolBrokerService, type Authorizer } from '../src/domain/tool-broker/tool-broker-service'
import type { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import type { AgentRepository, TicketRepository, ToolBrokerRepository } from '../src/repositories/interfaces'
import type { AuditRepository } from '../src/repositories/interfaces'
import { TicketService } from '../src/domain/ticket/ticket-service'
import { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import { WebSearchService } from '../src/domain/web-search/web-search-service'
import { WebSearchPolicyService } from '../src/domain/web-search/web-search-policy-service'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function gitBlobSha1(content: string): string {
  const buf = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex')
}

const REPO_METADATA_PATH = 'repo/.repo_prepare.json'

/** In-memory workspace-fájltár — csak a repo_open_pull_request-hez szükséges metódusok. */
class FakeFileEditor {
  private files = new Map<string, Buffer>()

  private key(tenantId: string, ticketId: string, path: string) {
    return `${tenantId}::${ticketId}::${path}`
  }

  seed(tenantId: string, ticketId: string, path: string, content: string) {
    this.files.set(this.key(tenantId, ticketId, path), Buffer.from(content, 'utf8'))
  }

  async readTextFileOrNull(tenantId: string, ticketId: string, args: { path: string }) {
    const buf = this.files.get(this.key(tenantId, ticketId, args.path))
    return buf ? buf.toString('utf8') : null
  }

  async readRawFile(tenantId: string, ticketId: string, args: { path: string }) {
    return this.files.get(this.key(tenantId, ticketId, args.path)) ?? null
  }

  async listFiles(tenantId: string, ticketId: string, args: { path?: string; recursive?: boolean }) {
    const prefix = args.path ? `${args.path}/` : ''
    const own = `${tenantId}::${ticketId}::`
    const entries = [...this.files.keys()]
      .filter((k) => k.startsWith(own))
      .map((k) => k.slice(own.length))
      .filter((p) => p.startsWith(prefix))
      .map((path) => ({ path, type: 'file' as const }))
    return { path: args.path ?? '', entries }
  }
}

function fakeConnector(): Connector {
  return {
    id: 'connector-workspace-1',
    tenantId: null,
    lifecycleState: 'active',
    authMode: 'agent_owned',
    secretAlias: null,
  } as unknown as Connector
}

function fakeAuthorizer(): Authorizer {
  return {
    authorize: async () => ({ allowed: true, connector: fakeConnector() }),
  }
}

const fakeTools = {
  findConnectorsForAgent: async () => [],
  createToolCall: async () => undefined,
} as unknown as ToolBrokerRepository

const fakeTickets = {
  findById: async () => null,
} as unknown as TicketRepository

const fakeAgents = { findById: async () => null } as unknown as AgentRepository
const fakeAudit = { append: async () => undefined } as unknown as AuditRepository

type FetchCall = { method: string; path: string; body?: unknown }

function buildFetchMock(
  routes: Record<string, (call: FetchCall) => { status: number; json?: unknown }>,
  calls: FetchCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname + url.search
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const call: FetchCall = { method, path, body }
    calls.push(call)
    const key = `${method} ${url.pathname}`
    const handler = routes[key]
    if (!handler) {
      throw new Error(`Unmocked fetch: ${key}`)
    }
    const { status, json } = handler(call)
    return new Response(json !== undefined ? JSON.stringify(json) : null, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function makeBroker(fileEditor: FakeFileEditor) {
  return new ToolBrokerService(
    fakeAgents,
    fakeTickets,
    fakeTools,
    fakeAudit,
    null as unknown as TicketService,
    fakeAuthorizer(),
    null as unknown as ConnectorGrantService,
    fileEditor as unknown as FileEditorService,
    null as never,
    null as never,
    null as unknown as WebSearchService,
    null as unknown as WebSearchPolicyService,
    null as never,
    null as never,
  )
}

async function main() {
  await test('repo_prepare nélkül hangosan bukik, nem talál ki sikert', async () => {
    const fileEditor = new FakeFileEditor()
    const broker = makeBroker(fileEditor)
    await assert.rejects(
      () =>
        broker.invoke({
          agentId: 'agent-1',
          agentVersion: 1,
          ticketId: 'ticket-1',
          tool: 'repo_open_pull_request',
          args: { title: 'E-AI fejléc' },
        }),
      /repo_prepare/,
    )
  })

  await test('nincs változás → changed:false, GitHub write hívás nélkül', async () => {
    const fileEditor = new FakeFileEditor()
    const content = 'export const APP_NAME = "A Pince"\n'
    const sha = gitBlobSha1(content)
    fileEditor.seed('global', 'ticket-1', REPO_METADATA_PATH, JSON.stringify({
      owner: 'giretg',
      repo: 'enterprise-ai-agent-platform',
      ref: 'main',
      commitSha: 'base-sha-1',
      repoPath: 'repo',
      filesIndexed: 1,
      bytesWritten: content.length,
      preparedAt: new Date().toISOString(),
    }))
    fileEditor.seed('global', 'ticket-1', 'repo/app/layout.tsx', content)

    const calls: FetchCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = buildFetchMock(
      {
        'GET /repos/giretg/enterprise-ai-agent-platform/git/trees/base-sha-1': () => ({
          status: 200,
          json: { tree: [{ path: 'app/layout.tsx', mode: '100644', type: 'blob', sha }] },
        }),
      },
      calls,
    )
    try {
      const broker = makeBroker(fileEditor)
      const res = await broker.invoke({
        agentId: 'agent-1',
        agentVersion: 1,
        ticketId: 'ticket-1',
        tool: 'repo_open_pull_request',
        args: { title: 'E-AI fejléc' },
      })
      assert.equal(res.denied, false)
      const result = (res as { result: { changed: boolean } }).result
      assert.equal(result.changed, false)
      assert.equal(calls.length, 1, 'csak az import-fa GET hívás fusson, semmi write')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('módosított + törölt fájl → helyes tree-diff, branch+commit+PR', async () => {
    const fileEditor = new FakeFileEditor()
    const originalHeader = 'export const APP_NAME = "A Pince"\n'
    const originalDeleted = 'export const OLD = true\n'
    const modifiedHeader = 'export const APP_NAME = "E-AI"\n'
    const shaHeaderOriginal = gitBlobSha1(originalHeader)
    const shaDeleted = gitBlobSha1(originalDeleted)

    fileEditor.seed('global', 'ticket-1', REPO_METADATA_PATH, JSON.stringify({
      owner: 'giretg',
      repo: 'enterprise-ai-agent-platform',
      ref: 'main',
      commitSha: 'base-sha-1',
      repoPath: 'repo',
      filesIndexed: 2,
      bytesWritten: 0,
      preparedAt: new Date().toISOString(),
    }))
    // Workspace-en a fejléc módosult, az OLD fájl törölve lett (file_delete-tel).
    fileEditor.seed('global', 'ticket-1', 'repo/app/layout.tsx', modifiedHeader)

    const calls: FetchCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = buildFetchMock(
      {
        'GET /repos/giretg/enterprise-ai-agent-platform/git/trees/base-sha-1': () => ({
          status: 200,
          json: {
            tree: [
              { path: 'app/layout.tsx', mode: '100644', type: 'blob', sha: shaHeaderOriginal },
              { path: 'app/old.tsx', mode: '100644', type: 'blob', sha: shaDeleted },
            ],
          },
        }),
        'GET /repos/giretg/enterprise-ai-agent-platform/commits/main': () => ({
          status: 200,
          json: { sha: 'head-sha-fresh', commit: { tree: { sha: 'head-tree-fresh' } } },
        }),
        'POST /repos/giretg/enterprise-ai-agent-platform/git/trees': () => ({
          status: 201,
          json: { sha: 'new-tree-sha' },
        }),
        'POST /repos/giretg/enterprise-ai-agent-platform/git/commits': () => ({
          status: 201,
          json: { sha: 'new-commit-sha' },
        }),
        'POST /repos/giretg/enterprise-ai-agent-platform/git/refs': () => ({ status: 201 }),
        'POST /repos/giretg/enterprise-ai-agent-platform/pulls': () => ({
          status: 201,
          json: { html_url: 'https://github.com/giretg/enterprise-ai-agent-platform/pull/42', number: 42 },
        }),
      },
      calls,
    )
    try {
      const broker = makeBroker(fileEditor)
      const res = await broker.invoke({
        agentId: 'agent-1',
        agentVersion: 1,
        ticketId: 'ticket-1',
        tool: 'repo_open_pull_request',
        args: { title: 'Fejléc E-AI-ra', branch: 'agent/e-ai-header' },
      })
      assert.equal(res.denied, false)
      const result = (res as {
        result: {
          changed: boolean
          branch: string
          commitSha: string
          pullRequestUrl: string
          pullRequestNumber: number
          filesChanged: number
          changedPaths: string[]
        }
      }).result
      assert.equal(result.changed, true)
      assert.equal(result.branch, 'agent/e-ai-header')
      assert.equal(result.commitSha, 'new-commit-sha')
      assert.equal(result.pullRequestUrl, 'https://github.com/giretg/enterprise-ai-agent-platform/pull/42')
      assert.equal(result.pullRequestNumber, 42)
      assert.equal(result.filesChanged, 2)
      assert.deepEqual(result.changedPaths, ['app/layout.tsx', 'app/old.tsx'])

      const treeCall = calls.find((c) => c.method === 'POST' && c.path === '/repos/giretg/enterprise-ai-agent-platform/git/trees')
      assert.ok(treeCall, 'a git/trees POST-nak le kellett futnia')
      const treeBody = treeCall!.body as { base_tree: string; tree: Array<Record<string, unknown>> }
      assert.equal(treeBody.base_tree, 'head-tree-fresh', 'a friss head tree-ről kell ágazni, nem az import-koriról')
      const modifiedEntry = treeBody.tree.find((e) => e.path === 'app/layout.tsx')
      assert.equal(modifiedEntry?.content, modifiedHeader, 'a módosított tartalomnak be kell kerülnie a tree entrybe')
      const deletedEntry = treeBody.tree.find((e) => e.path === 'app/old.tsx')
      assert.equal(deletedEntry?.sha, null, 'a törölt fájlnak sha:null tree entryt kell kapnia')

      const commitCall = calls.find((c) => c.method === 'POST' && c.path === '/repos/giretg/enterprise-ai-agent-platform/git/commits')
      assert.equal((commitCall!.body as { parents: string[] }).parents[0], 'head-sha-fresh')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('branch ütközés (422) esetén automatikusan másik nevet próbál', async () => {
    const fileEditor = new FakeFileEditor()
    const original = 'x'
    const modified = 'y'
    const sha = gitBlobSha1(original)
    fileEditor.seed('global', 'ticket-1', REPO_METADATA_PATH, JSON.stringify({
      owner: 'giretg',
      repo: 'demo',
      ref: 'main',
      commitSha: 'base-sha-1',
      repoPath: 'repo',
      filesIndexed: 1,
      bytesWritten: 0,
      preparedAt: new Date().toISOString(),
    }))
    fileEditor.seed('global', 'ticket-1', 'repo/f.txt', modified)

    let refAttempts = 0
    const calls: FetchCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = buildFetchMock(
      {
        'GET /repos/giretg/demo/git/trees/base-sha-1': () => ({
          status: 200,
          json: { tree: [{ path: 'f.txt', mode: '100644', type: 'blob', sha }] },
        }),
        'GET /repos/giretg/demo/commits/main': () => ({
          status: 200,
          json: { sha: 'head-sha', commit: { tree: { sha: 'head-tree' } } },
        }),
        'POST /repos/giretg/demo/git/trees': () => ({ status: 201, json: { sha: 'tree-2' } }),
        'POST /repos/giretg/demo/git/commits': () => ({ status: 201, json: { sha: 'commit-2' } }),
        'POST /repos/giretg/demo/git/refs': () => {
          refAttempts++
          return refAttempts === 1 ? { status: 422 } : { status: 201 }
        },
        'POST /repos/giretg/demo/pulls': () => ({
          status: 201,
          json: { html_url: 'https://github.com/giretg/demo/pull/1', number: 1 },
        }),
      },
      calls,
    )
    try {
      const broker = makeBroker(fileEditor)
      const res = await broker.invoke({
        agentId: 'agent-1',
        agentVersion: 1,
        ticketId: 'ticket-1',
        tool: 'repo_open_pull_request',
        args: { title: 'x', branch: 'agent/taken' },
      })
      assert.equal(res.denied, false)
      const result = (res as { result: { branch: string } }).result
      assert.equal(result.branch, 'agent/taken-2', 'ütközés esetén számozott alternatívát kell választania')
      assert.equal(refAttempts, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
