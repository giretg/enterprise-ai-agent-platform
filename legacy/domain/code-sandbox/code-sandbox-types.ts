import path from 'node:path'
import { z } from 'zod'

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export const codeSandboxConfigSchema = z.object({
  provider: z.enum(['cloud_run', 'e2b_compatible']),
  region: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((region) => /^(europe|eu-)/i.test(region), {
      message: 'A sandbox régiójának EU-régiónak kell lennie.',
    }),
  baseUrl: z.string().url().optional(),
  maxExecSec: z.number().int().min(1).max(900).default(120),
  defaultAllowEgress: z.literal(false).default(false),
  cpuProfile: z.string().trim().min(1).max(64).default('1'),
  memoryProfile: z.string().trim().min(1).max(64).default('512Mi'),
  maxCallsPerScope: z.number().int().min(1).max(1000).default(10),
  maxExecSecPerScope: z.number().int().min(1).max(3600).default(300),
})

export type CodeSandboxConfig = z.infer<typeof codeSandboxConfigSchema>

export type SandboxHandle = {
  id: string
  tenantId: string
  scopeKey: string
  allowEgress: boolean
}

export type SandboxExecMetrics = {
  provider: CodeSandboxConfig['provider']
  region: string
  provisionMs: number
  execMs: number
  totalMs: number
  cpuProfile: string
  memoryProfile: string
  inputBytes: number
  outputBytes: number
  egressBytes: number | null
  coldStart: boolean | null
  exitStatus: number
}

export interface SandboxProvider {
  checkHealth(): Promise<'ready' | 'failed'>
  provision(input: {
    tenantId: string
    scopeKey: string
    allowEgress: boolean
  }): Promise<SandboxHandle>
  exec(
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
  }>
  putFile(handle: SandboxHandle, path: string, bytes: Uint8Array): Promise<void>
  getFile(handle: SandboxHandle, path: string): Promise<Uint8Array>
  destroy(handle: SandboxHandle): Promise<void>
}

export type CodeSandboxLimits = {
  maxFiles: number
  maxFileBytes: number
  maxInputBytes: number
  maxOutputBytes: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

export function codeSandboxLimits(): CodeSandboxLimits {
  return {
    maxFiles: positiveIntegerEnv('CODE_SANDBOX_MAX_FILES', 32),
    maxFileBytes: positiveIntegerEnv('CODE_SANDBOX_MAX_FILE_BYTES', 5 * 1024 * 1024),
    maxInputBytes: positiveIntegerEnv(
      'CODE_SANDBOX_MAX_INPUT_BYTES',
      20 * 1024 * 1024,
    ),
    maxOutputBytes: positiveIntegerEnv(
      'CODE_SANDBOX_MAX_OUTPUT_BYTES',
      20 * 1024 * 1024,
    ),
    maxStdoutBytes: positiveIntegerEnv('CODE_SANDBOX_MAX_STDOUT_BYTES', 256 * 1024),
    maxStderrBytes: positiveIntegerEnv('CODE_SANDBOX_MAX_STDERR_BYTES', 256 * 1024),
  }
}

export function relativeSandboxPath(
  sandboxPath: string,
  prefix: '/work/in/' | '/work/out/',
): string {
  if (prefix === '/work/in/' && sandboxPath === '/work/run.py') return 'run.py'
  if (!sandboxPath.startsWith(prefix))
    throw new Error(`invalid_sandbox_path: ${sandboxPath}`)
  return normalizeSandboxWorkspacePath(sandboxPath.slice(prefix.length))
}

export const SMOKE_INPUT_PATH = '/work/in/ping.txt'
export const SMOKE_OUTPUT_PATH = '/work/out/pong.txt'
export const SMOKE_INPUT_BYTES = Buffer.from('ping', 'utf8')

export function smokeSandboxRequest() {
  return {
    allowEgress: false,
    command: [
      'python3',
      '-c',
      'from pathlib import Path; Path("/work/out/pong.txt").write_text(Path("/work/in/ping.txt").read_text())',
    ],
    timeoutMs: 15_000,
    env: {},
    files: [
      {
        path: SMOKE_INPUT_PATH,
        contentBase64: SMOKE_INPUT_BYTES.toString('base64'),
      },
    ],
    limits: {
      maxFiles: 2,
      maxFileBytes: 1024,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    },
  }
}

export function isSmokeSuccess(body: {
  exitCode: number
  outputs?: Array<{ path: string; contentBase64: string }>
}): boolean {
  const pong = body.outputs?.find((output) => output.path === SMOKE_OUTPUT_PATH)
  return (
    body.exitCode === 0 &&
    Boolean(pong) &&
    Buffer.from(pong!.contentBase64, 'base64').equals(SMOKE_INPUT_BYTES)
  )
}

/** Szigorú, kanonikus, workspace-relatív útvonal; nincs javítgató normalizálás. */
export function normalizeSandboxWorkspacePath(value: string): string {
  if (
    !value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`invalid_sandbox_workspace_path: ${value}`)
  }
  const normalized = path.posix.normalize(value)
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    value.split('/').includes('..')
  ) {
    throw new Error(`invalid_sandbox_workspace_path: ${value}`)
  }
  return normalized
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { value, truncated: false }
  return {
    value: bytes.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  }
}

export function isCanonicalBase64(value: string): boolean {
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) && Buffer.from(value, 'base64').toString('base64') === value
  )
}
