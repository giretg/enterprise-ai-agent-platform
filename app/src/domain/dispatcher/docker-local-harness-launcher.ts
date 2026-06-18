import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { HarnessLauncher } from './dispatcher-service'
import { buildHarnessContainerEnv, harnessEnvToDockerArgs } from './harness-run-env'

export type DockerLocalHarnessConfig = {
  image: string
  platformHost: string
  platformPort: string
  callbackToken: string
  callbackUrl?: string
  harnessMode: string
  recipePath: string
  agentApiKey?: string
  egressEnforce?: boolean
  stubBrokerFallback?: boolean
}

function requireConfigValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing docker-local harness config: ${name}`)
  return value
}

async function resolveAgentApiKey(config: DockerLocalHarnessConfig): Promise<string> {
  if (config.agentApiKey?.trim()) return config.agentApiKey.trim()
  try {
    const raw = await readFile(resolve(process.cwd(), '.seed-demo-api-key'), 'utf8')
    const key = raw.trim()
    if (key) return key
  } catch {
    // fall through
  }
  throw new Error('Missing HARNESS_AGENT_API_KEY or .seed-demo-api-key for docker-local launcher')
}

export function dockerLocalConfigFromEnv(): DockerLocalHarnessConfig {
  return {
    image: process.env.HARNESS_DOCKER_IMAGE ?? 'wiki-harness:local',
    platformHost: process.env.HARNESS_DOCKER_PLATFORM_HOST ?? 'host.docker.internal',
    platformPort: process.env.HARNESS_DOCKER_PLATFORM_PORT ?? '3000',
    callbackToken: requireConfigValue('HARNESS_CALLBACK_TOKEN', process.env.HARNESS_CALLBACK_TOKEN),
    callbackUrl: process.env.HARNESS_CALLBACK_URL,
    harnessMode: process.env.HARNESS_MODE ?? 'goose',
    recipePath: process.env.HARNESS_RECIPE_PATH ?? '/recipes/wiki-answer.yaml',
    agentApiKey: process.env.HARNESS_AGENT_API_KEY,
    egressEnforce: process.env.HARNESS_EGRESS_ENFORCE === 'true',
    stubBrokerFallback: process.env.HARNESS_STUB_BROKER_FALLBACK === '1',
  }
}

export class DockerLocalHarnessLauncher implements HarnessLauncher {
  readonly mode = 'docker-local'

  constructor(private config: DockerLocalHarnessConfig) {}

  async launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
    agentVersion?: number
    actingUserId?: string
    question?: string
  }): Promise<{ jobId: string; executionName?: string }> {
    const agentApiKey = await resolveAgentApiKey(this.config)
    const platformUrl = `http://${this.config.platformHost}:${this.config.platformPort}`

    const env = buildHarnessContainerEnv(input, {
      callbackUrl: this.config.callbackUrl ?? `${platformUrl}/api/v1/harness/tickets/{ticketId}/complete`,
      callbackToken: this.config.callbackToken,
      harnessMode: this.config.harnessMode,
      recipePath: this.config.recipePath,
      platformApiUrl: platformUrl,
      harnessAgentApiKey: agentApiKey,
      egressEnforce: this.config.egressEnforce,
      stubBrokerFallback: this.config.stubBrokerFallback ?? this.config.harnessMode === 'goose',
    })

    const dockerArgs = ['run', '--rm', ...harnessEnvToDockerArgs(env), this.config.image]

    return new Promise((resolvePromise, reject) => {
      const child = spawn('docker', dockerArgs, {
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolvePromise({
          jobId: `docker-local-${input.ticketId}`,
          executionName: `docker:${this.config.image}`,
        })
      })
    })
  }
}
