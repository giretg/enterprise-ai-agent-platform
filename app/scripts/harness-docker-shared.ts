import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { HarnessMode } from '../src/harness/harness-mode'
import {
  buildHarnessContainerEnv,
  harnessEnvToDockerArgs,
} from '../src/domain/dispatcher/harness-run-env'

export type HarnessDockerRunParams = {
  ticketId: string
  agentId: string
  lockToken: string
  agentVersion?: number
  question?: string
  harnessMode: HarnessMode
  platformHost?: string
  platformPort?: string
  callbackToken?: string
  image?: string
  extraEnv?: Record<string, string>
}

export async function readSeedApiKey(): Promise<string> {
  try {
    const raw = await readFile(resolve(process.cwd(), '.seed-demo-api-key'), 'utf8')
    const key = raw.trim()
    if (key) return key
  } catch {
    // fall through
  }
  if (process.env.HARNESS_AGENT_API_KEY?.trim()) return process.env.HARNESS_AGENT_API_KEY.trim()
  throw new Error('Missing HARNESS_AGENT_API_KEY or .seed-demo-api-key — futtasd: npm run db:seed')
}

export function platformBaseUrl(host?: string, port?: string): string {
  const h = host ?? process.env.HARNESS_DOCKER_PLATFORM_HOST ?? 'host.docker.internal'
  const p = port ?? process.env.HARNESS_DOCKER_PLATFORM_PORT ?? '3000'
  return `http://${h}:${p}`
}

export function buildHarnessDockerArgs(params: HarnessDockerRunParams): string[] {
  const image = params.image ?? process.env.HARNESS_DOCKER_IMAGE ?? 'wiki-harness:local'
  const platformUrl = platformBaseUrl(params.platformHost, params.platformPort)
  const callbackToken =
    params.callbackToken ?? process.env.HARNESS_CALLBACK_TOKEN ?? 'docker-smoke-secret'

  const env = buildHarnessContainerEnv(
    {
      ticketId: params.ticketId,
      agentId: params.agentId,
      lockToken: params.lockToken,
      agentVersion: params.agentVersion,
      question: params.question ?? process.env.HARNESS_QUESTION,
    },
    {
      callbackUrl: `${platformUrl}/api/v1/harness/tickets/{ticketId}/complete`,
      callbackToken,
      harnessMode: params.harnessMode,
      platformApiUrl: platformUrl,
      harnessAgentApiKey:
        params.extraEnv?.HARNESS_AGENT_API_KEY ?? process.env.HARNESS_AGENT_API_KEY ?? '',
    },
  )

  const args = ['run', '--rm', ...harnessEnvToDockerArgs(env), image]

  for (const [key, value] of Object.entries(params.extraEnv ?? {})) {
    if (key === 'HARNESS_AGENT_API_KEY') continue
    args.splice(args.length - 1, 0, '-e', `${key}=${value}`)
  }

  return args
}

export function runDocker(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise(code ?? 1))
  })
}

export async function dockerImageExists(image: string): Promise<boolean> {
  const code = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (c) => resolvePromise(c ?? 1))
  })
  return code === 0
}

export async function isPlatformReachable(platformUrl: string): Promise<boolean> {
  const candidates = [platformUrl]
  if (platformUrl.includes('host.docker.internal')) {
    candidates.push(platformUrl.replace('host.docker.internal', '127.0.0.1'))
  }

  for (const url of candidates) {
    try {
      const response = await fetch(`${url}/api/v1/gateway/v1/chat/completions`, {
        method: 'OPTIONS',
      })
      if (response.status < 500) return true
    } catch {
      // try next candidate
    }
  }

  return false
}
