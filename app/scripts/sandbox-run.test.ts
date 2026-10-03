/**
 * sandbox_run pin + runner (#662).
 * Futtatás: npm run test:sandbox-run
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { CodeSandboxService } from '../src/domain/code-sandbox/code-sandbox-service'
import { HttpSandboxProvider } from '../src/domain/code-sandbox/http-sandbox-provider'
import {
  codeSandboxConfigSchema,
  type SandboxHandle,
  type SandboxProvider,
} from '../src/domain/code-sandbox/code-sandbox-types'
import { resolvePinnedSkillScript } from '../src/domain/code-sandbox/skill-script'
import type { AgentDefinition } from '../src/domain/agent-definition'

const SKILL_VERSION_ID = '99999999-9999-4999-8999-999999999999'
const OTHER_SKILL_VERSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const definition: AgentDefinition = {
  definitionId: '44444444-4444-4444-8444-444444444444',
  agentId: '33333333-3333-4333-8333-333333333333',
  version: 1,
  tenantId: '22222222-2222-4222-8222-222222222222',
  status: 'active',
  publishedAt: '2026-01-02T00:00:00.000Z',
  snapshot: {
    name: 'Kati',
    roleInstruction: 'Report',
    skills: [{ skillId: 'skill-1', skillVersionId: SKILL_VERSION_ID, name: 'napi-riport' }],
    connectors: [],
    capabilities: [],
  },
}

const attachment = {
  path: 'scripts/run.py',
  text: 'print(1)\n',
  bytes: 9,
  sha256: 'deadbeef',
}

function localPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected tcp listen address')
  }
  return address.port
}

class FakeProvider implements SandboxProvider {
  destroyed = 0
  failExec = false
  outputs = new Map([['/work/out/report.html', Uint8Array.from([1, 2, 3])]])
  async checkHealth() {
    return 'ready' as const
  }
  async provision(input: Omit<SandboxHandle, 'id'>) {
    return { id: 'run', ...input }
  }
  async putFile() {}
  async exec() {
    if (this.failExec) throw new Error('boom')
    return { stdout: 'ok', stderr: '', exitCode: 0 }
  }
  async getFile(_handle: SandboxHandle, path: string) {
    const bytes = this.outputs.get(path)
    if (!bytes) throw new Error('missing')
    return bytes
  }
  async listOutputFiles() {
    return [...this.outputs.keys()]
  }
  async destroy() {
    this.destroyed++
  }
}

async function main() {
  await check('unpinned skillVersionId is denied', () => {
    const result = resolvePinnedSkillScript({
      definition,
      skillVersionId: OTHER_SKILL_VERSION_ID,
      entry: 'scripts/run.py',
      attachments: [attachment],
    })
    assert.deepEqual(result, { ok: false, reason: 'skill_not_pinned' })
  })

  await check('path traversal entry is denied', () => {
    const result = resolvePinnedSkillScript({
      definition,
      skillVersionId: SKILL_VERSION_ID,
      entry: '../secret.py',
      attachments: [attachment],
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'invalid_args')
  })

  await check('pinned .py entry resolves helpers', () => {
    const helper = { path: 'scripts/helper.py', text: 'x=1\n', bytes: 4, sha256: 'aa' }
    const result = resolvePinnedSkillScript({
      definition,
      skillVersionId: SKILL_VERSION_ID,
      entry: 'scripts/run.py',
      attachments: [attachment, helper],
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.script.entry.path, 'scripts/run.py')
      assert.equal(result.script.helpers.length, 1)
      assert.equal(result.script.helpers[0]?.path, 'scripts/helper.py')
    }
  })

  await check('runner destroys after exec failure', async () => {
    const provider = new FakeProvider()
    provider.failExec = true
    const service = new CodeSandboxService(
      provider,
      codeSandboxConfigSchema.parse({
        provider: 'cloud_run',
        region: 'europe-west1',
        baseUrl: 'https://sandbox.example.test',
        defaultAllowEgress: false,
      }),
    )
    await assert.rejects(
      () =>
        service.execute({
          tenantId: 't',
          scopeKey: 's',
          command: ['python3', '/work/run.py'],
          files: [{ sandboxPath: '/work/run.py', bytes: Buffer.from('print(1)') }],
        }),
      /boom/,
    )
    assert.equal(provider.destroyed, 1)
  })

  await check('runner collects /work/out files', async () => {
    const provider = new FakeProvider()
    const result = await new CodeSandboxService(
      provider,
      codeSandboxConfigSchema.parse({
        provider: 'cloud_run',
        region: 'europe-west1',
        baseUrl: 'https://sandbox.example.test',
        defaultAllowEgress: false,
      }),
    ).execute({
      tenantId: 't',
      scopeKey: 's',
      command: ['python3', '/work/run.py'],
      files: [{ sandboxPath: '/work/run.py', bytes: Buffer.from('print(1)') }],
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.outputFiles.length, 1)
    assert.equal(result.outputFiles[0]?.path, 'report.html')
    assert.equal(provider.destroyed, 1)
  })

  await check('sandbox request never forwards scripts through a redirect', async () => {
    let forwarded = 0
    const destination = createServer((_request, response) => {
      forwarded++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ exitCode: 0, stdout: '', stderr: '', outputs: [] }))
    })
    const redirector = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${localPort(destination)}/stolen` })
      response.end()
    })
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    try {
      const baseUrl = `http://127.0.0.1:${localPort(redirector)}`
      const config = codeSandboxConfigSchema.parse({
        provider: 'e2b_compatible',
        region: 'europe-west1',
        baseUrl,
        defaultAllowEgress: false,
      })
      const service = new CodeSandboxService(new HttpSandboxProvider({ ...config, baseUrl }, null), config)
      await assert.rejects(
        () =>
          service.execute({
            tenantId: 'tenant',
            scopeKey: 'scope',
            command: ['python3', '/work/run.py'],
            files: [{ sandboxPath: '/work/run.py', bytes: Buffer.from('private script') }],
          }),
        /fetch failed/,
      )
      assert.equal(forwarded, 0)
    } finally {
      redirector.close()
      destination.close()
    }
  })

  console.log(`\n${failures === 0 ? 'sandbox-run: ok' : `sandbox-run: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
