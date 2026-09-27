import {
  codeSandboxLimits,
  relativeSandboxPath,
  truncateUtf8,
  type CodeSandboxConfig,
  type SandboxExecMetrics,
  type SandboxProvider,
} from './code-sandbox-types'

export type SandboxPreparedFile = {
  sandboxPath: string
  bytes: Uint8Array
}

export type SandboxRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  outputFiles: Array<{ path: string; bytes: Uint8Array }>
  metrics: SandboxExecMetrics
}

export class CodeSandboxDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'CodeSandboxDeniedError'
  }
}

export class CodeSandboxService {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly config: CodeSandboxConfig,
  ) {}

  async execute(input: {
    tenantId: string
    scopeKey: string
    command: string[]
    files: SandboxPreparedFile[]
    timeoutMs?: number
  }): Promise<SandboxRunResult> {
    if (process.env.CODE_SANDBOX_ENABLED === 'false') throw new Error('code_sandbox_disabled')
    const startedAt = Date.now()
    const limits = codeSandboxLimits()
    const command = input.command
    if (command.length === 0 || command.some((part) => !part || Buffer.byteLength(part) > 8192)) {
      throw new Error('invalid_sandbox_command')
    }
    const timeoutMs = input.timeoutMs ?? Math.min(this.config.maxExecSec * 1000, 120_000)
    if (timeoutMs < 1 || timeoutMs > this.config.maxExecSec * 1000) {
      throw new CodeSandboxDeniedError(
        `sandbox_timeout_exceeds_connector_limit_${this.config.maxExecSec}s`,
      )
    }
    if (input.files.length > limits.maxFiles) {
      throw new CodeSandboxDeniedError('sandbox_file_count_limit_exceeded')
    }
    let inputBytes = 0
    for (const file of input.files) {
      if (file.bytes.length > limits.maxFileBytes) {
        throw new CodeSandboxDeniedError(`sandbox_input_file_too_large: ${file.sandboxPath}`)
      }
      inputBytes += file.bytes.length
      if (inputBytes > limits.maxInputBytes) {
        throw new CodeSandboxDeniedError('sandbox_input_total_size_exceeded')
      }
    }

    const provisionStarted = Date.now()
    const handle = await this.provider.provision({
      tenantId: input.tenantId,
      scopeKey: input.scopeKey,
      allowEgress: false,
    })
    const provisionMs = Date.now() - provisionStarted
    try {
      for (const file of input.files) {
        await this.provider.putFile(handle, file.sandboxPath, file.bytes)
      }
      const execStarted = Date.now()
      const executed = await this.provider.exec(handle, { command, timeoutMs })
      const execMs = Date.now() - execStarted

      const downloaded: Array<{ path: string; bytes: Uint8Array }> = []
      let outputBytes = 0
      for (const sandboxPath of await this.provider.listOutputFiles(handle)) {
        const path = relativeSandboxPath(sandboxPath, '/work/out/')
        const bytes = await this.provider.getFile(handle, sandboxPath)
        if (bytes.length > limits.maxFileBytes) {
          throw new CodeSandboxDeniedError(`sandbox_output_file_too_large: ${path}`)
        }
        outputBytes += bytes.length
        if (outputBytes > limits.maxOutputBytes) {
          throw new CodeSandboxDeniedError('sandbox_output_total_size_exceeded')
        }
        downloaded.push({ path, bytes })
      }

      const stdout = truncateUtf8(executed.stdout, limits.maxStdoutBytes)
      const stderr = truncateUtf8(executed.stderr, limits.maxStderrBytes)
      return {
        exitCode: executed.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        outputFiles: downloaded,
        metrics: {
          provider: this.config.provider,
          region: this.config.region,
          provisionMs: executed.metrics?.provisionMs ?? provisionMs,
          execMs: executed.metrics?.execMs ?? execMs,
          totalMs: executed.metrics?.totalMs ?? Date.now() - startedAt,
          cpuProfile: this.config.cpuProfile,
          memoryProfile: this.config.memoryProfile,
          inputBytes,
          outputBytes,
          egressBytes: executed.metrics?.egressBytes ?? null,
          coldStart: executed.metrics?.coldStart ?? null,
          exitStatus: executed.exitCode,
        },
      }
    } finally {
      await this.provider.destroy(handle)
    }
  }
}
