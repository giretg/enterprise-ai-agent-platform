/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic module boundary mocks */
/** Run: npx tsx scripts/connector-update-publishing.test.ts (no DB/browser needed). */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(path: string, dependencies: Record<string, unknown>) {
  // The real modules run with only network/auth/DB boundaries replaced.
  const exports: Record<string, (...args: any[]) => Promise<any>> = {}
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  runInNewContext(outputText, { exports, Error, require: (name: string) => {
    assert.ok(name in dependencies, `Unexpected import: ${name}`)
    return dependencies[name]
  } })
  return exports
}

async function main() {
  const agents = [{ id: 'a', name: 'Anna' }, { id: 'b', name: 'Béla' }]
  let linked = agents
  let updateResult: any = { success: true, data: { connectorId: 'connector', kind: 'proposed', autoApproved: true } }
  let failPublish = false
  let throwPublish = false
  let failList = false
  let answers: boolean[] = []
  let listCalls = 0
  const published: string[] = []
  const dialogs: any[] = []
  const update = async () => updateResult
  const client = load('../src/lib/connector-update-publishing.ts', {
    '@/components/ui/confirm-dialog': { confirmDialog: async (options: any) => {
      dialogs.push(options)
      return answers.shift() ?? false
    } },
    '@/app/actions/connector-publishing': { listConnectorAgentsForPublishing: async () => {
      listCalls++
      if (failList) throw new Error('Kapcsolati hiba')
      return { success: true, data: linked }
    } },
    '@/app/actions/platform': { publishAgentDefinitionAction: async ({ agentId }: any) => {
      published.push(agentId)
      if (throwPublish && agentId === 'b') throw new Error('Offline')
      return failPublish && agentId === 'b' ? { success: false, error: 'Hiányzó felelősségi kör' } : { success: true }
    } },
    '@/app/actions/provisioning': { activateConnector: update, updateGoogleAccountBinding: update },
    '@/app/actions/mcp-connectors': { approveMcpTools: update },
    '@/app/actions/self-updating-connectors': {
      approveSelfUpdatingVersion: update, rollbackSelfUpdatingVersion: update, syncSelfUpdatingConnector: update,
    },
  })
  for (const action of Object.values(client)) {
    answers = [true]
    published.length = 0
    assert.equal(await action({ connectorId: 'connector' }), updateResult)
    assert.deepEqual(published, ['a', 'b'])
    assert.match(dialogs.at(-1).description, /Anna[\s\S]*Béla[\s\S]*egyéb elmentett módosításaik/)
  }
  answers = [false]
  published.length = 0
  await client.activateConnector({})
  assert.equal(published.length, 0, 'Postponing must not publish')
  linked = []
  const dialogCount = dialogs.length
  await client.activateConnector({})
  assert.equal(dialogs.length, dialogCount, 'No linked agents: no modal')
  linked = agents
  for (const data of [{ kind: 'unchanged' }, { kind: 'proposed', autoApproved: false }]) {
    updateResult = { success: true, data }
    const calls = listCalls
    await client.syncSelfUpdatingConnector({ connectorId: 'connector' })
    assert.equal(listCalls, calls, 'Unchanged/pending proposals must not offer publication')
  }
  updateResult = { success: false, error: 'Save failed' }
  const calls = listCalls
  for (const action of Object.values(client)) assert.equal(await action({}), updateResult)
  assert.equal(listCalls, calls, 'Failed update must not offer publication')
  updateResult = { success: true, data: { connectorId: 'connector' } }
  failPublish = true
  answers = [true, true, false]
  published.length = 0
  assert.equal(await client.activateConnector({}), updateResult)
  assert.deepEqual(published, ['a', 'b', 'b'], 'Retry only failed agents; preserve saved connector result')
  assert.match(dialogs.at(-1).description, /Béla: Hiányzó felelősségi kör/)

  throwPublish = true
  answers = [true, false]
  published.length = 0
  assert.equal(await client.activateConnector({}), updateResult)
  assert.deepEqual(published, ['a', 'b'])
  assert.match(dialogs.at(-1).description, /Offline/)
  failList = true
  assert.equal(await client.activateConnector({}), updateResult, 'Lookup failure must preserve saved result')
  assert.match(dialogs.at(-1).description, /Kapcsolati hiba/)

  let role = 'admin'
  let query: any
  const server = load('../src/app/actions/connector-publishing.ts', {
    zod: require('zod'),
    '@/auth/tenant-context': { requireTenantRole: async () => ({ activeTenantRole: role, activeTenantId: 'tenant-a' }) },
    '@/lib/db': { prisma: { agent: { findMany: async (args: any) => { query = args; return agents } } } },
    '@/lib/result': { ok: (data: any) => ({ success: true, data }), fail: (error: string) => ({ success: false, error }) },
  })
  const input = { connectorId: '77777777-7777-4777-8777-777777777777' }
  assert.equal((await server.listConnectorAgentsForPublishing(input)).data, agents)
  assert.equal(query.where.tenantId, 'tenant-a')
  assert.equal(query.where.kind, 'internal')
  assert.equal(query.where.status.not, 'retired')
  assert.equal(query.where.currentDefinitionVersionId.not, null, 'Never-published agents are not offered')
  assert.equal(query.where.agentConnectors.some.connectorId, input.connectorId)
  assert.equal(query.where.agentConnectors.some.connector.lifecycleState, 'active')
  assert.equal(query.where.agentConnectors.some.connector.tenantId, 'tenant-a')
  assert.deepEqual(Object.keys(query.select), ['id', 'name'], 'No secrets returned')
  query = null
  role = 'operator'
  assert.equal((await server.listConnectorAgentsForPublishing(input)).data.length, 0)
  assert.equal(query, null, 'Non-admin must not be offered publication')
  assert.equal((await server.listConnectorAgentsForPublishing({ connectorId: 'invalid' })).success, false)
  console.log('connector-update-publishing: OK (update paths, cancel, retry, tenant/role scope)')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
