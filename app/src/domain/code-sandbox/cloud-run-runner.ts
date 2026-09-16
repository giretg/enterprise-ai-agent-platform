import { spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  isCanonicalBase64,
  normalizeSandboxWorkspacePath,
  type CodeSandboxLimits,
} from './code-sandbox-types'

const requestSchema = z.object({
  id: z.string().uuid(),
  allowEgress: z.boolean(),
  command: z.array(z.string().min(1).max(8192)).min(1).max(64),
  timeoutMs: z.number().int().min(1).max(900_000),
  env: z.record(z.string(), z.string().max(8192)).default({}),
  limits: z.object({
    maxFiles: z.number().int().min(1).max(256),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024),
    maxInputBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    maxStdoutBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    maxStderrBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
  }),
  files: z
    .array(
      z.object({
        path: z.string(),
        contentBase64: z
          .string()
          .max(70 * 1024 * 1024)
          .refine(isCanonicalBase64),
      }),
    )
    .max(256),
})

type RunResult = { stdout: string; stderr: string; exitCode: number }

function sandboxBinary(): string {
  return process.env.CODE_SANDBOX_BINARY ?? '/usr/local/gcp/bin/sandbox'
}

function appendCapped(
  chunks: Buffer[],
  chunk: Buffer,
  current: number,
  max: number,
): number {
  if (current >= max + 1) return current
  const remaining = max + 1 - current
  chunks.push(chunk.subarray(0, remaining))
  return current + Math.min(chunk.length, remaining)
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  limits: CodeSandboxLimits,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = appendCapped(
        stdout,
        chunk,
        stdoutBytes,
        limits.maxStdoutBytes,
      )
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = appendCapped(
        stderr,
        chunk,
        stderrBytes,
        limits.maxStderrBytes,
      )
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: timedOut ? 124 : (code ?? 1),
      })
    })
  })
}

function safeMountedPath(root: string, sandboxPath: string): string {
  const relative =
    sandboxPath === '/work/run.py'
      ? 'run.py'
      : sandboxPath.startsWith('/work/in/')
        ? normalizeSandboxWorkspacePath(sandboxPath.slice('/work/in/'.length))
        : (() => {
            throw new Error(`invalid_sandbox_input_path: ${sandboxPath}`)
          })()
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error('sandbox_input_path_escape')
  return resolved
}

export async function collectSandboxOutputs(
  root: string,
  limits: CodeSandboxLimits,
) {
  const outputs: Array<{ path: string; contentBase64: string }> = []
  let total = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const stat = await lstat(full)
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      ) {
        throw new Error(
          `invalid_sandbox_output_type: ${path.relative(root, full)}`,
        )
      }
      if (stat.isDirectory()) {
        await walk(full)
        continue
      }
      if (stat.size > limits.maxFileBytes)
        throw new Error(
          `sandbox_output_file_too_large: ${path.relative(root, full)}`,
        )
      total += stat.size
      if (total > limits.maxOutputBytes)
        throw new Error('sandbox_output_total_size_exceeded')
      if (outputs.length >= limits.maxFiles)
        throw new Error('sandbox_output_file_count_exceeded')
      outputs.push({
        path: `/work/out/${path.relative(root, full).split(path.sep).join('/')}`,
        contentBase64: (await readFile(full)).toString('base64'),
      })
    }
  }
  await walk(root)
  return { outputs, outputBytes: total }
}

export async function executeCloudRunSandbox(raw: unknown) {
  const request = requestSchema.parse(raw)
  if (request.files.length > request.limits.maxFiles)
    throw new Error('sandbox_input_file_count_exceeded')
  const root = await mkdtemp(path.join(tmpdir(), 'code-sandbox-'))
  const inputDir = path.join(root, 'in')
  const outputDir = path.join(root, 'out')
  const scriptDir = path.join(root, 'script')
  const sandboxName = `exec-${randomUUID()}`
  await Promise.all([mkdir(inputDir), mkdir(outputDir), mkdir(scriptDir)])
  await Promise.all([
    chmod(inputDir, 0o755),
    chmod(outputDir, 0o777),
    chmod(scriptDir, 0o755),
  ])
  let inputBytes = 0
  let provisionMs = 0
  const startedAt = Date.now()
  try {
    for (const file of request.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64')
      if (bytes.length > request.limits.maxFileBytes)
        throw new Error(`sandbox_input_file_too_large: ${file.path}`)
      inputBytes += bytes.length
      if (inputBytes > request.limits.maxInputBytes)
        throw new Error('sandbox_input_total_size_exceeded')
      const rootForFile = file.path === '/work/run.py' ? scriptDir : inputDir
      const target = safeMountedPath(rootForFile, file.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o400 })
      await chmod(target, 0o444)
    }

    const runArgs = [
      'run',
      '--write',
      sandboxName,
      '--detach',
      '--mount',
      `type=bind,source=${inputDir},destination=/work/in,readonly`,
      '--mount',
      `type=bind,source=${outputDir},destination=/work/out`,
    ]
    if (request.files.some((file) => file.path === '/work/run.py')) {
      runArgs.push(
        '--mount',
        `type=bind,source=${path.join(scriptDir, 'run.py')},destination=/work/run.py,readonly`,
      )
    }
    if (request.allowEgress) runArgs.push('--allow-egress')
    runArgs.push('--', '/bin/sleep', '1000')
    const provisionStarted = Date.now()
    const provision = await runProcess(
      sandboxBinary(),
      runArgs,
      30_000,
      request.limits,
    )
    provisionMs = Date.now() - provisionStarted
    if (provision.exitCode !== 0)
      throw new Error(`sandbox_provision_failed: ${provision.stderr}`)

    const execStarted = Date.now()
    const envArgs = Object.entries(request.env).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ])
    const result = await runProcess(
      sandboxBinary(),
      [
        'exec',
        sandboxName,
        '--workdir',
        '/work',
        ...envArgs,
        '--',
        ...request.command,
      ],
      request.timeoutMs,
      request.limits,
    )
    const execMs = Date.now() - execStarted
    const { outputs, outputBytes } = await collectSandboxOutputs(outputDir, {
      ...request.limits,
      maxFiles: request.limits.maxFiles - request.files.length,
    })
    return {
      ...result,
      outputs,
      metrics: {
        provisionMs,
        execMs,
        totalMs: Date.now() - startedAt,
        inputBytes,
        outputBytes,
        egressBytes: null,
        coldStart: null,
        exitStatus: result.exitCode,
      },
    }
  } finally {
    await runProcess(
      sandboxBinary(),
      ['delete', sandboxName, '--force'],
      15_000,
      request.limits,
    ).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

export function authorizeSandboxRequest(header: string | undefined): boolean {
  const expected = process.env.CODE_SANDBOX_SHARED_TOKEN
  if (!expected) return true // Cloud Run IAM marad a külső auth-határ.
  const actual = header?.replace(/^Bearer\s+/i, '') ?? ''
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  )
}
