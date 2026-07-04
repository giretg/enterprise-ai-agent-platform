import { spawn } from 'node:child_process'
import { assertEgressDenyByDefault } from './egress-guard'
import { resolveHarnessCommandJson } from './goose-command'
import { prepareGooseHarnessEnv } from './goose-config'
import { runStubHarnessAgentLoop, shouldRunStubHarnessAgentLoop } from './stub-harness-agent-loop'
import {
  HarnessProcessError,
  runWikiTicketProcessViaPlatform,
  shouldRunWikiTicketProcess,
} from './wiki-ticket-process'

export type HarnessRunStatus = 'succeeded' | 'failed'

export type HarnessEntrypointResult = {
  status: HarnessRunStatus
  completionStatus: number
}

type HarnessEnv = Record<string, string | undefined>

type SpawnResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

type HarnessEntrypointDeps = {
  fetch: typeof fetch
  spawnCommand: (command: string, args: string[], env: HarnessEnv) => Promise<SpawnResult>
  log: Pick<Console, 'log' | 'error'>
}

type HarnessContext = {
  ticketId: string
  agentId: string
  lockToken: string
  callbackUrl: string
  callbackToken: string
  commandJson: string | null
  cloudRunJob: string | null
  cloudRunExecution: string | null
}

function requiredEnv(env: HarnessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing harness env: ${name}`)
  return value
}

function readContext(env: HarnessEnv): HarnessContext {
  return {
    ticketId: requiredEnv(env, 'TICKET_ID'),
    agentId: requiredEnv(env, 'AGENT_ID'),
    lockToken: requiredEnv(env, 'DISPATCH_LOCK_TOKEN'),
    callbackUrl: requiredEnv(env, 'HARNESS_CALLBACK_URL'),
    callbackToken: requiredEnv(env, 'HARNESS_CALLBACK_TOKEN'),
    commandJson: resolveHarnessCommandJson(env),
    cloudRunJob: env.CLOUD_RUN_JOB ?? null,
    cloudRunExecution: env.CLOUD_RUN_EXECUTION ?? null,
  }
}

function completionEndpoint(callbackUrl: string, ticketId: string): string {
  if (callbackUrl.includes('{ticketId}')) {
    return callbackUrl.replaceAll('{ticketId}', encodeURIComponent(ticketId))
  }

  return `${callbackUrl.replace(/\/$/, '')}/api/v1/harness/tickets/${encodeURIComponent(ticketId)}/complete`
}

function parseCommand(commandJson: string): { command: string; args: string[] } {
  const parsed = JSON.parse(commandJson) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('HARNESS_COMMAND_JSON must be a non-empty JSON string array')
  }

  const [command, ...args] = parsed
  return { command, args }
}

async function defaultSpawnCommand(
  command: string,
  args: string[],
  env: HarnessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
}

async function runConfiguredCommand(
  ctx: HarnessContext,
  env: HarnessEnv,
  deps: HarnessEntrypointDeps,
) {
  if (!ctx.commandJson) {
    deps.log.log('No harness command configured; running completion contract-only proof.')
    return
  }

  const { command, args } = parseCommand(ctx.commandJson)
  deps.log.log(`Starting harness command: ${command} ${args.join(' ')}`)
  const result = await deps.spawnCommand(command, args, env)
  if (result.exitCode !== 0) {
    throw new Error(
      `Harness command failed: exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'}`,
    )
  }
}

async function postCompletion(
  ctx: HarnessContext,
  status: HarnessRunStatus,
  error: string | null,
  errorCategory: 'permanent' | 'transient' | null,
  deps: HarnessEntrypointDeps,
): Promise<number> {
  const endpoint = completionEndpoint(ctx.callbackUrl, ctx.ticketId)
  const response = await deps.fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.callbackToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      lockToken: ctx.lockToken,
      status,
      jobId: ctx.cloudRunJob ?? 'local-harness',
      executionName: ctx.cloudRunExecution ?? undefined,
      error: error ?? undefined,
      errorCategory: errorCategory ?? undefined,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Harness completion callback failed: ${response.status} ${body.slice(0, 500)}`)
  }

  return response.status
}

export async function runHarnessEntrypoint(
  env: HarnessEnv = process.env,
  deps: Partial<HarnessEntrypointDeps> = {},
): Promise<HarnessEntrypointResult> {
  const resolvedDeps: HarnessEntrypointDeps = {
    fetch,
    spawnCommand: defaultSpawnCommand,
    log: console,
    ...deps,
  }
  const ctx = readContext(env)
  const wikiMode = shouldRunWikiTicketProcess(env)
  const runtimeEnv = wikiMode ? env : await prepareGooseHarnessEnv(env)

  let status: HarnessRunStatus = 'succeeded'
  let error: string | null = null
  let errorCategory: 'permanent' | 'transient' | null = null
  try {
    await assertEgressDenyByDefault(runtimeEnv, resolvedDeps.fetch)
    if (wikiMode) {
      resolvedDeps.log.log('Running wiki ticket process via platform API (provider-agnostic).')
      await runWikiTicketProcessViaPlatform(runtimeEnv, resolvedDeps.fetch)
    } else {
      await runConfiguredCommand(ctx, runtimeEnv, resolvedDeps)
      if (shouldRunStubHarnessAgentLoop(runtimeEnv)) {
        resolvedDeps.log.log('Running stub harness agent loop (Gateway tool_calls + MCP bridge fallback).')
        await runStubHarnessAgentLoop(runtimeEnv, resolvedDeps.fetch)
      }
    }
  } catch (e) {
    status = 'failed'
    error = e instanceof Error ? e.message : String(e)
    errorCategory = e instanceof HarnessProcessError ? e.category : null
    resolvedDeps.log.error(error)
  }

  const completionStatus = await postCompletion(ctx, status, error, errorCategory, resolvedDeps)
  return { status, completionStatus }
}
