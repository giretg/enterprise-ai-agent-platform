import path from 'node:path'
import { z } from 'zod'

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

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function codeSandboxLimits(): CodeSandboxLimits {
  return {
    maxFiles: positiveEnv('CODE_SANDBOX_MAX_FILES', 32),
    maxFileBytes: positiveEnv('CODE_SANDBOX_MAX_FILE_BYTES', 5 * 1024 * 1024),
    maxInputBytes: positiveEnv(
      'CODE_SANDBOX_MAX_INPUT_BYTES',
      20 * 1024 * 1024,
    ),
    maxOutputBytes: positiveEnv(
      'CODE_SANDBOX_MAX_OUTPUT_BYTES',
      20 * 1024 * 1024,
    ),
    maxStdoutBytes: positiveEnv('CODE_SANDBOX_MAX_STDOUT_BYTES', 256 * 1024),
    maxStderrBytes: positiveEnv('CODE_SANDBOX_MAX_STDERR_BYTES', 256 * 1024),
  }
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
