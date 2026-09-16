import type { FileEditorService } from '@/domain/file-editor/file-editor-service'
import {
  codeSandboxLimits,
  normalizeSandboxWorkspacePath,
  truncateUtf8,
  type CodeSandboxConfig,
  type SandboxExecMetrics,
  type SandboxProvider,
} from './code-sandbox-types'

export type SandboxExecInput = {
  command: string[]
  script?: string
  inputs?: string[]
  outputs?: string[]
  timeoutMs?: number
  allowEgress?: boolean
}

export type SandboxExecResult = {
  exitCode: number
  stdout: string
  stderr: string
  outputs: string[]
  stdoutTruncated: boolean
  stderrTruncated: boolean
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
    private readonly fileEditor: FileEditorService,
    private readonly provider: SandboxProvider,
    private readonly config: CodeSandboxConfig,
  ) {}

  async execute(input: {
    tenantId: string
    scopeKey: string
    args: SandboxExecInput
  }): Promise<SandboxExecResult> {
    if (process.env.CODE_SANDBOX_ENABLED === 'false')
      throw new Error('code_sandbox_disabled')
    const startedAt = Date.now()
    const limits = codeSandboxLimits()
    const command = input.args.command
    if (
      command.length === 0 ||
      command.some((part) => !part || Buffer.byteLength(part) > 8192)
    ) {
      throw new Error('invalid_sandbox_command')
    }
    const timeoutMs =
      input.args.timeoutMs ?? Math.min(this.config.maxExecSec * 1000, 120_000)
    if (timeoutMs < 1 || timeoutMs > this.config.maxExecSec * 1000) {
      throw new CodeSandboxDeniedError(
        `sandbox_timeout_exceeds_connector_limit_${this.config.maxExecSec}s`,
      )
    }
    const inputs = [
      ...new Set((input.args.inputs ?? []).map(normalizeSandboxWorkspacePath)),
    ]
    const outputs = [
      ...new Set((input.args.outputs ?? []).map(normalizeSandboxWorkspacePath)),
    ]
    if (
      inputs.length +
        outputs.length +
        (input.args.script === undefined ? 0 : 1) >
      limits.maxFiles
    ) {
      throw new CodeSandboxDeniedError('sandbox_file_count_limit_exceeded')
    }

    const preparedInputs: Array<{ path: string; bytes: Uint8Array }> = []
    let inputBytes = 0
    for (const path of inputs) {
      const bytes = await this.fileEditor.readRawFile(
        input.tenantId,
        input.scopeKey,
        { path },
      )
      if (!bytes) throw new Error(`sandbox_input_missing: ${path}`)
      if (bytes.length > limits.maxFileBytes)
        throw new CodeSandboxDeniedError(
          `sandbox_input_file_too_large: ${path}`,
        )
      inputBytes += bytes.length
      if (inputBytes > limits.maxInputBytes)
        throw new CodeSandboxDeniedError('sandbox_input_total_size_exceeded')
      preparedInputs.push({ path: `/work/in/${path}`, bytes })
    }
    if (input.args.script !== undefined) {
      const script = Buffer.from(input.args.script, 'utf8')
      if (script.length > limits.maxFileBytes)
        throw new CodeSandboxDeniedError('sandbox_script_too_large')
      inputBytes += script.length
      if (inputBytes > limits.maxInputBytes)
        throw new CodeSandboxDeniedError('sandbox_input_total_size_exceeded')
      preparedInputs.push({ path: '/work/run.py', bytes: script })
    }

    const provisionStarted = Date.now()
    const handle = await this.provider.provision({
      tenantId: input.tenantId,
      scopeKey: input.scopeKey,
      allowEgress: input.args.allowEgress === true,
    })
    const provisionMs = Date.now() - provisionStarted
    try {
      for (const file of preparedInputs)
        await this.provider.putFile(handle, file.path, file.bytes)
      const execStarted = Date.now()
      const executed = await this.provider.exec(handle, { command, timeoutMs })
      const execMs = Date.now() - execStarted

      const downloaded: Array<{ path: string; bytes: Uint8Array }> = []
      let outputBytes = 0
      for (const path of outputs) {
        const bytes = await this.provider.getFile(handle, `/work/out/${path}`)
        if (bytes.length > limits.maxFileBytes)
          throw new CodeSandboxDeniedError(
            `sandbox_output_file_too_large: ${path}`,
          )
        outputBytes += bytes.length
        if (outputBytes > limits.maxOutputBytes)
          throw new CodeSandboxDeniedError('sandbox_output_total_size_exceeded')
        downloaded.push({ path, bytes })
      }

      await this.writeOutputsAtomically(
        input.tenantId,
        input.scopeKey,
        downloaded,
      )
      const stdout = truncateUtf8(executed.stdout, limits.maxStdoutBytes)
      const stderr = truncateUtf8(executed.stderr, limits.maxStderrBytes)
      return {
        exitCode: executed.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        outputs,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
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

  private async writeOutputsAtomically(
    tenantId: string,
    scopeKey: string,
    outputs: Array<{ path: string; bytes: Uint8Array }>,
  ): Promise<void> {
    const previous = new Map<string, Buffer | null>()
    for (const output of outputs) {
      previous.set(
        output.path,
        await this.fileEditor.readRawFile(tenantId, scopeKey, {
          path: output.path,
        }),
      )
    }
    const written: string[] = []
    try {
      for (const output of outputs) {
        await this.fileEditor.writeRawFile(tenantId, scopeKey, output)
        written.push(output.path)
      }
    } catch (error) {
      for (const path of written.reverse()) {
        const bytes = previous.get(path)
        if (bytes)
          await this.fileEditor.writeRawFile(tenantId, scopeKey, {
            path,
            bytes,
          })
        else await this.fileEditor.deleteRawFile(tenantId, scopeKey, path)
      }
      throw error
    }
  }
}
