import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodeSandboxService } from '@/domain/code-sandbox/code-sandbox-service'
import {
  HttpSandboxProvider,
  createSandboxProvider,
} from '@/domain/code-sandbox/http-sandbox-provider'
import {
  authorizeSandboxRequest,
  buildSandboxRunArgs,
  collectSandboxOutputs,
} from '@/domain/code-sandbox/cloud-run-runner'
import {
  codeSandboxConfigSchema,
  isCanonicalBase64,
  isSmokeSuccess,
  normalizeSandboxWorkspacePath,
  relativeSandboxPath,
  smokeSandboxRequest,
  type SandboxHandle,
  type SandboxProvider,
} from '@/domain/code-sandbox/code-sandbox-types'
import { requiresConsequenceApproval } from '@/domain/tool-broker/consequence-gate-policy'
import { codeSandboxBudgetDenial } from '@/domain/tool-broker/tool-broker-service'
import type { FileEditorService } from '@/domain/file-editor/file-editor-service'

const config = codeSandboxConfigSchema.parse({
  provider: 'cloud_run',
  region: 'europe-west1',
  baseUrl: 'https://sandbox.example.com',
  maxExecSec: 30,
  defaultAllowEgress: false,
})

class FakeProvider implements SandboxProvider {
  destroyed = 0
  provisionedEgress: boolean | null = null
  failExec = false
  outputs = new Map([['/work/out/result.bin', Uint8Array.from([1, 2, 3])]])
  async checkHealth() {
    return 'ready' as const
  }
  async provision(input: Omit<SandboxHandle, 'id'>) {
    this.provisionedEgress = input.allowEgress
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
  async destroy() {
    this.destroyed++
  }
}

function fakeEditor(
  initial: Record<string, Uint8Array> = {},
  failWritePath?: string,
) {
  const files = new Map(
    Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]),
  )
  return {
    files,
    service: {
      async readRawFile(
        _tenantId: string,
        _scopeKey: string,
        input: { path: string },
      ) {
        return files.get(input.path) ?? null
      },
      async writeRawFile(
        _tenantId: string,
        _scopeKey: string,
        input: { path: string; bytes: Uint8Array },
      ) {
        if (input.path === failWritePath) throw new Error('write failed')
        files.set(input.path, Buffer.from(input.bytes))
        return { path: input.path, bytesWritten: input.bytes.length }
      },
      async deleteRawFile(
        _tenantId: string,
        _scopeKey: string,
        filePath: string,
      ) {
        files.delete(filePath)
      },
    } as unknown as FileEditorService,
  }
}

async function main() {
  assert.equal(
    normalizeSandboxWorkspacePath('folder/file.txt'),
    'folder/file.txt',
  )
  assert.equal(
    isCanonicalBase64(Buffer.from('sandbox').toString('base64')),
    true,
  )
  assert.equal(isCanonicalBase64('not-base64'), false)
  for (const invalid of [
    '/etc/passwd',
    '../secret',
    'a/../secret',
    'C:\\secret',
    'a\\b',
    'a\0b',
  ]) {
    assert.throws(() => normalizeSandboxWorkspacePath(invalid))
  }
  assert.equal(
    requiresConsequenceApproval('sandbox_exec', { allowEgress: false })
      .required,
    false,
  )
  assert.deepEqual(
    requiresConsequenceApproval('sandbox_exec', { allowEgress: true }),
    {
      required: true,
      reason: 'sandbox_egress',
    },
  )
  assert.throws(() =>
    codeSandboxConfigSchema.parse({ ...config, region: 'us-central1' }),
  )
  assert.throws(() =>
    codeSandboxConfigSchema.parse({ ...config, defaultAllowEgress: true }),
  )
  assert.equal(
    codeSandboxBudgetDenial({ calls: 10, execMs: 0 }, 1),
    'code_sandbox_call_budget_exceeded',
  )
  assert.equal(
    codeSandboxBudgetDenial({ calls: 0, execMs: 299_000 }, 2_000),
    'code_sandbox_time_budget_exceeded',
  )
  assert.equal(
    codeSandboxBudgetDenial({ calls: 0, execMs: 299_000 }, 1_000),
    null,
  )
  assert.ok(createSandboxProvider(config, null) instanceof HttpSandboxProvider)
  assert.ok(
    createSandboxProvider({ ...config, provider: 'e2b_compatible' }, null) instanceof
      HttpSandboxProvider,
  )
  const smoke = smokeSandboxRequest()
  assert.equal(smoke.allowEgress, false)
  assert.equal(smoke.command[0], 'python3')
  assert.equal(smoke.files[0]?.path, '/work/in/ping.txt')
  assert.equal(
    isSmokeSuccess({
      exitCode: 0,
      outputs: [
        {
          path: '/work/out/pong.txt',
          contentBase64: Buffer.from('ping').toString('base64'),
        },
      ],
    }),
    true,
  )
  assert.equal(isSmokeSuccess({ exitCode: 0, outputs: [] }), false)
  assert.equal(relativeSandboxPath('/work/run.py', '/work/in/'), 'run.py')
  assert.equal(relativeSandboxPath('/work/out/result.bin', '/work/out/'), 'result.bin')
  assert.throws(() => relativeSandboxPath('/tmp/x', '/work/out/'))

  const previousToken = process.env.CODE_SANDBOX_SHARED_TOKEN
  const previousService = process.env.K_SERVICE
  delete process.env.CODE_SANDBOX_SHARED_TOKEN
  delete process.env.K_SERVICE
  assert.equal(authorizeSandboxRequest('Bearer x'), false)
  process.env.K_SERVICE = 'enterprise-code-sandbox'
  assert.equal(authorizeSandboxRequest(undefined), true)
  delete process.env.K_SERVICE
  process.env.CODE_SANDBOX_SHARED_TOKEN = 'secret-token'
  assert.equal(authorizeSandboxRequest('Bearer secret-token'), true)
  assert.equal(authorizeSandboxRequest('Bearer other'), false)
  if (previousToken === undefined) delete process.env.CODE_SANDBOX_SHARED_TOKEN
  else process.env.CODE_SANDBOX_SHARED_TOKEN = previousToken
  if (previousService === undefined) delete process.env.K_SERVICE
  else process.env.K_SERVICE = previousService

  const blocked = buildSandboxRunArgs({
    sandboxName: 'exec-1',
    inputDir: '/tmp/in',
    outputDir: '/tmp/out',
    allowEgress: false,
  })
  assert.equal(blocked.includes('--allow-egress'), false)
  const open = buildSandboxRunArgs({
    sandboxName: 'exec-1',
    inputDir: '/tmp/in',
    outputDir: '/tmp/out',
    allowEgress: true,
  })
  assert.ok(open.includes('--allow-egress'))

  assert.equal(
    codeSandboxBudgetDenial({ calls: 2, execMs: 0 }, 1, { maxCallsPerScope: 2 }),
    'code_sandbox_call_budget_exceeded',
  )

  const editor = fakeEditor({ 'input.txt': Uint8Array.from([9]) })
  const provider = new FakeProvider()
  const result = await new CodeSandboxService(
    editor.service,
    provider,
    config,
  ).execute({
    tenantId: 'tenant',
    scopeKey: 'scope',
    args: {
      command: ['/usr/bin/python3', '/work/run.py'],
      script: 'print(1)',
      inputs: ['input.txt'],
      outputs: ['result.bin'],
    },
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual([...editor.files.get('result.bin')!], [1, 2, 3])
  assert.equal(provider.destroyed, 1)
  assert.equal(provider.provisionedEgress, false)

  const failing = new FakeProvider()
  failing.failExec = true
  await assert.rejects(() =>
    new CodeSandboxService(fakeEditor().service, failing, config).execute({
      tenantId: 'tenant',
      scopeKey: 'scope',
      args: { command: ['/bin/false'] },
    }),
  )
  assert.equal(failing.destroyed, 1)

  const rollbackProvider = new FakeProvider()
  rollbackProvider.outputs = new Map([
    ['/work/out/first.bin', Uint8Array.from([1])],
    ['/work/out/fail.bin', Uint8Array.from([2])],
  ])
  const rollbackEditor = fakeEditor(
    { 'first.bin': Uint8Array.from([9]) },
    'fail.bin',
  )
  await assert.rejects(() =>
    new CodeSandboxService(
      rollbackEditor.service,
      rollbackProvider,
      config,
    ).execute({
      tenantId: 'tenant',
      scopeKey: 'scope',
      args: { command: ['/bin/true'], outputs: ['first.bin', 'fail.bin'] },
    }),
  )
  assert.deepEqual([...rollbackEditor.files.get('first.bin')!], [9])
  assert.equal(rollbackEditor.files.has('fail.bin'), false)
  assert.equal(rollbackProvider.destroyed, 1)

  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-output-test-'))
  try {
    const limits = {
      maxFiles: 5,
      maxFileBytes: 1024,
      maxInputBytes: 2048,
      maxOutputBytes: 2048,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    }
    await mkdir(path.join(root, 'valid'))
    await writeFile(path.join(root, 'valid', 'file.txt'), 'ok')
    assert.equal((await collectSandboxOutputs(root, limits)).outputs.length, 1)
    await symlink(
      path.join(root, 'valid', 'file.txt'),
      path.join(root, 'symlink'),
    )
    await assert.rejects(
      () => collectSandboxOutputs(root, limits),
      /invalid_sandbox_output_type/,
    )
    await rm(path.join(root, 'symlink'))
    await link(
      path.join(root, 'valid', 'file.txt'),
      path.join(root, 'hardlink'),
    )
    await assert.rejects(
      () => collectSandboxOutputs(root, limits),
      /invalid_sandbox_output_type/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log('code-sandbox tests: ok')
}

void main()
