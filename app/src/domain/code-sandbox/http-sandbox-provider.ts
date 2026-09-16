import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { E2BCompatibleSandboxAdapter } from './e2b-sandbox-provider'
import {
  codeSandboxLimits,
  isCanonicalBase64,
  normalizeSandboxWorkspacePath,
  type CodeSandboxConfig,
  type SandboxExecMetrics,
  type SandboxHandle,
  type SandboxProvider,
} from './code-sandbox-types'

type BufferedRun = {
  handle: SandboxHandle
  files: Map<string, Uint8Array>
  outputs: Map<string, Uint8Array>
}

type ResolvedCodeSandboxConfig = CodeSandboxConfig & { baseUrl: string }

function executeResponseSchema(limits: ReturnType<typeof codeSandboxLimits>) {
  const base64MaxLength = Math.ceil(limits.maxFileBytes / 3) * 4
  return z.object({
    exitCode: z.number().int(),
    stdout: z.string().max(limits.maxStdoutBytes + 1),
    stderr: z.string().max(limits.maxStderrBytes + 1),
    outputs: z
      .array(
        z.object({
          path: z.string().refine((value) => {
            if (!value.startsWith('/work/out/')) return false
            try {
              normalizeSandboxWorkspacePath(value.slice('/work/out/'.length))
              return true
            } catch {
              return false
            }
          }),
          contentBase64: z
            .string()
            .max(base64MaxLength)
            .refine(isCanonicalBase64),
        }),
      )
      .max(limits.maxFiles),
    metrics: z
      .object({
        provisionMs: z.number().nonnegative().optional(),
        execMs: z.number().nonnegative().optional(),
        totalMs: z.number().nonnegative().optional(),
        inputBytes: z.number().int().nonnegative().optional(),
        outputBytes: z.number().int().nonnegative().optional(),
        egressBytes: z.number().int().nonnegative().nullable().optional(),
        coldStart: z.boolean().nullable().optional(),
        exitStatus: z.number().int().optional(),
      })
      .optional(),
  })
}

/**
 * Mindkét provider ugyanazt a minimális, önhostolható HTTP-protokollt beszéli.
 * Egy kérés egy teljes távoli sandbox-életciklus; állapot nem ragad app instance-hoz.
 */
export class HttpSandboxProvider implements SandboxProvider {
  private readonly runs = new Map<string, BufferedRun>()

  constructor(
    private readonly config: ResolvedCodeSandboxConfig,
    private readonly secretAlias: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async checkHealth(): Promise<'ready' | 'failed'> {
    try {
      const response = await this.request('/v1/smoke', {})
      return response.ok ? 'ready' : 'failed'
    } catch {
      return 'failed'
    }
  }

  async provision(input: Omit<SandboxHandle, 'id'>): Promise<SandboxHandle> {
    const handle = { id: randomUUID(), ...input }
    this.runs.set(handle.id, { handle, files: new Map(), outputs: new Map() })
    return handle
  }

  async putFile(
    handle: SandboxHandle,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.run(handle).files.set(path, Uint8Array.from(bytes))
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
    const run = this.run(handle)
    const limits = codeSandboxLimits()
    const response = await this.request('/v1/execute', {
      id: handle.id,
      tenantId: handle.tenantId,
      scopeKey: handle.scopeKey,
      allowEgress: handle.allowEgress,
      command: input.command,
      timeoutMs: input.timeoutMs,
      env: input.env ?? {},
      limits,
      files: [...run.files].map(([path, bytes]) => ({
        path,
        contentBase64: Buffer.from(bytes).toString('base64'),
      })),
    })
    if (!response.ok)
      throw new Error(
        `code_sandbox_provider_${response.status}: ${await response.text()}`,
      )
    const body = executeResponseSchema(limits).parse(await response.json())
    let outputBytes = 0
    run.outputs = new Map(
      body.outputs.map((output) => {
        const bytes = Buffer.from(output.contentBase64, 'base64')
        outputBytes += bytes.length
        if (outputBytes > limits.maxOutputBytes)
          throw new Error('sandbox_output_total_size_exceeded')
        return [output.path, bytes]
      }),
    )
    return {
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      metrics: body.metrics,
    }
  }

  async getFile(handle: SandboxHandle, path: string): Promise<Uint8Array> {
    const value = this.run(handle).outputs.get(path)
    if (!value) throw new Error(`sandbox_output_missing: ${path}`)
    return Uint8Array.from(value)
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.runs.delete(handle.id)
  }

  private run(handle: SandboxHandle): BufferedRun {
    const run = this.runs.get(handle.id)
    if (!run) throw new Error('sandbox_handle_not_found')
    return run
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const token = await this.authToken()
    return this.fetchFn(new URL(path, this.config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((this.config.maxExecSec + 15) * 1000),
    })
  }

  private async authToken(): Promise<string | null> {
    if (this.secretAlias) return resolveConnectorApiKey(this.secretAlias)
    if (this.config.provider !== 'cloud_run') return null
    const audience = this.config.baseUrl.replace(/\/$/, '')
    const url = new URL(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
    )
    url.searchParams.set('audience', audience)
    url.searchParams.set('format', 'full')
    const response = await this.fetchFn(url, {
      headers: { 'metadata-flavor': 'Google' },
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok)
      throw new Error('code_sandbox_cloud_run_identity_token_failed')
    return response.text()
  }
}

export class CloudRunSandboxAdapter extends HttpSandboxProvider {}
export { E2BCompatibleSandboxAdapter } from './e2b-sandbox-provider'

export function createSandboxProvider(
  config: CodeSandboxConfig,
  secretAlias: string | null,
): SandboxProvider {
  const baseUrl =
    config.baseUrl ??
    (config.provider === 'cloud_run'
      ? process.env.CODE_SANDBOX_CLOUD_RUN_URL
      : process.env.CODE_SANDBOX_E2B_BASE_URL)
  if (!baseUrl) throw new Error('code_sandbox_base_url_missing')
  const resolved = { ...config, baseUrl }
  return config.provider === 'cloud_run'
    ? new CloudRunSandboxAdapter(resolved, secretAlias)
    : new E2BCompatibleSandboxAdapter(resolved, secretAlias)
}
