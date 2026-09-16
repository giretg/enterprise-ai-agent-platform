import { randomUUID } from 'node:crypto'
import { CommandExitError, Sandbox, TimeoutError } from 'e2b'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import {
  codeSandboxLimits,
  normalizeSandboxWorkspacePath,
  type CodeSandboxConfig,
  type SandboxExecMetrics,
  type SandboxHandle,
  type SandboxProvider,
} from './code-sandbox-types'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function e2bDomain(baseUrl: string): string {
  const host = new URL(baseUrl).host
  return host.startsWith('api.') ? host.slice(4) : host
}

/** Közvetlen E2B SDK-adapter; a `domain`/`apiUrl` miatt E2B-kompatibilis EU providerre is mutathat. */
export class E2BCompatibleSandboxAdapter implements SandboxProvider {
  private readonly sandboxes = new Map<string, Sandbox>()

  constructor(
    private readonly config: CodeSandboxConfig & { baseUrl: string },
    private readonly secretAlias: string | null,
  ) {}

  async checkHealth(): Promise<'ready' | 'failed'> {
    let handle: SandboxHandle | null = null
    try {
      handle = await this.provision({
        tenantId: 'health',
        scopeKey: randomUUID(),
        allowEgress: false,
      })
      const result = await this.exec(handle, {
        command: ['/bin/echo', 'sandbox-ready'],
        timeoutMs: 10_000,
      })
      return result.exitCode === 0 && result.stdout.trim() === 'sandbox-ready'
        ? 'ready'
        : 'failed'
    } catch {
      return 'failed'
    } finally {
      if (handle) await this.destroy(handle).catch(() => undefined)
    }
  }

  async provision(input: Omit<SandboxHandle, 'id'>): Promise<SandboxHandle> {
    const apiKey = this.secretAlias
      ? await resolveConnectorApiKey(this.secretAlias)
      : null
    if (!apiKey) throw new Error('code_sandbox_e2b_api_key_missing')
    const sandbox = await Sandbox.create({
      apiKey,
      apiUrl: this.config.baseUrl.replace(/\/$/, ''),
      domain: e2bDomain(this.config.baseUrl),
      timeoutMs: this.config.maxExecSec * 1000 + 30_000,
      requestTimeoutMs: (this.config.maxExecSec + 15) * 1000,
      allowInternetAccess: input.allowEgress,
      secure: true,
      envs: {},
      metadata: { purpose: 'enterprise-code-sandbox' },
    })
    const handle = { id: sandbox.sandboxId, ...input }
    this.sandboxes.set(handle.id, sandbox)
    try {
      await sandbox.commands.run(
        '(id -u sandbox-user >/dev/null 2>&1 || sudo useradd --system --home-dir /tmp/sandbox-user --create-home sandbox-user) && sudo mkdir -p /work/in /work/out && sudo chown root:root /work/in && sudo chmod 0555 /work/in && sudo chown sandbox-user:sandbox-user /work/out && sudo chmod 0700 /work/out',
      )
      return handle
    } catch (error) {
      await this.destroy(handle).catch(() => undefined)
      throw error
    }
  }

  async putFile(
    handle: SandboxHandle,
    sandboxPath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (sandboxPath !== '/work/run.py') {
      if (!sandboxPath.startsWith('/work/in/'))
        throw new Error(`invalid_sandbox_input_path: ${sandboxPath}`)
      normalizeSandboxWorkspacePath(sandboxPath.slice('/work/in/'.length))
    }
    const sandbox = this.sandbox(handle)
    await sandbox.files.write(sandboxPath, Uint8Array.from(bytes).buffer, {
      user: 'root',
    })
    await sandbox.commands.run(`sudo chmod 0444 -- ${shellQuote(sandboxPath)}`)
  }

  async exec(
    handle: SandboxHandle,
    input: {
      command: string[]
      timeoutMs: number
      env?: Record<string, string>
    },
  ): Promise<{
    stdout: string
    stderr: string
    exitCode: number
    metrics?: Partial<SandboxExecMetrics>
  }> {
    const sandbox = this.sandbox(handle)
    const limits = codeSandboxLimits()
    const suffix = randomUUID()
    const stdoutPath = `/tmp/${suffix}.stdout`
    const stderrPath = `/tmp/${suffix}.stderr`
    const exitPath = `/tmp/${suffix}.exit`
    const wrapped = [
      'set +e',
      `${input.command.map(shellQuote).join(' ')} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`,
      `printf '%s' "$?" >${shellQuote(exitPath)}`,
    ].join('\n')
    try {
      await sandbox.commands.run(wrapped, {
        cwd: '/work',
        envs: input.env ?? {},
        user: 'sandbox-user',
        timeoutMs: input.timeoutMs,
      })
    } catch (error) {
      if (error instanceof TimeoutError)
        return { exitCode: 124, stdout: '', stderr: 'sandbox timeout' }
      if (!(error instanceof CommandExitError)) throw error
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      sandbox.commands.run(
        `/usr/bin/head -c ${limits.maxStdoutBytes + 1} -- ${shellQuote(stdoutPath)}`,
        { user: 'root' },
      ),
      sandbox.commands.run(
        `/usr/bin/head -c ${limits.maxStderrBytes + 1} -- ${shellQuote(stderrPath)}`,
        { user: 'root' },
      ),
      sandbox.files.read(exitPath, { user: 'root' }),
    ])
    const parsedExitCode = Number.parseInt(exitCode, 10)
    if (!Number.isInteger(parsedExitCode))
      throw new Error('sandbox_exit_code_missing')
    return {
      exitCode: parsedExitCode,
      stdout: stdout.stdout,
      stderr: stderr.stdout,
    }
  }

  async getFile(
    handle: SandboxHandle,
    sandboxPath: string,
  ): Promise<Uint8Array> {
    if (!sandboxPath.startsWith('/work/out/'))
      throw new Error(`invalid_sandbox_output_path: ${sandboxPath}`)
    normalizeSandboxWorkspacePath(sandboxPath.slice('/work/out/'.length))
    const sandbox = this.sandbox(handle)
    const stat = await sandbox.commands.run(
      `stat -c '%F|%h|%s' -- ${shellQuote(sandboxPath)}`,
      { user: 'root' },
    )
    const [type, links, size] = stat.stdout.trim().split('|')
    if (type !== 'regular file' || links !== '1')
      throw new Error(`invalid_sandbox_output_type: ${sandboxPath}`)
    if (Number(size) > codeSandboxLimits().maxFileBytes)
      throw new Error(`sandbox_output_file_too_large: ${sandboxPath}`)
    return sandbox.files.read(sandboxPath, { format: 'bytes', user: 'root' })
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = this.sandboxes.get(handle.id)
    this.sandboxes.delete(handle.id)
    if (sandbox) await sandbox.kill()
  }

  private sandbox(handle: SandboxHandle): Sandbox {
    const sandbox = this.sandboxes.get(handle.id)
    if (!sandbox) throw new Error('sandbox_handle_not_found')
    return sandbox
  }
}
