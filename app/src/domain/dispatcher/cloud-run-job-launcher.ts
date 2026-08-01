import type { HarnessLauncher } from './dispatcher-service'
import { parseHarnessMode, type HarnessMode } from '@/harness/harness-mode'
import {
  buildHarnessContainerEnv,
  harnessEnvToCloudRunOverrides,
} from './harness-run-env'
import { cloudRunJobRunEndpoint, getCloudRunAccessToken } from './cloud-run-auth'

export type CloudRunJobLauncherConfig = {
  projectId: string
  location: string
  jobName: string
  bearerToken?: string
  callbackUrl?: string
  callbackToken?: string
  commandJson?: string
  harnessMode?: HarnessMode
  modelGatewayUrl?: string
  toolBrokerMcpUrl?: string
  platformApiUrl?: string
  harnessAgentApiKey?: string
  egressEnforce?: boolean
}

function requireConfigValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing Cloud Run harness config: ${name}`)
  return value
}

export function cloudRunConfigFromEnv(): CloudRunJobLauncherConfig {
  return {
    projectId: requireConfigValue('HARNESS_CLOUD_RUN_PROJECT_ID', process.env.HARNESS_CLOUD_RUN_PROJECT_ID),
    location: requireConfigValue('HARNESS_CLOUD_RUN_LOCATION', process.env.HARNESS_CLOUD_RUN_LOCATION),
    jobName: requireConfigValue('HARNESS_CLOUD_RUN_JOB_NAME', process.env.HARNESS_CLOUD_RUN_JOB_NAME),
    bearerToken: process.env.HARNESS_CLOUD_RUN_BEARER_TOKEN,
    callbackUrl: process.env.HARNESS_CALLBACK_URL,
    callbackToken: process.env.HARNESS_CALLBACK_TOKEN,
    commandJson: process.env.HARNESS_COMMAND_JSON,
    harnessMode: parseHarnessMode(process.env.HARNESS_MODE),
    modelGatewayUrl: process.env.MODEL_GATEWAY_URL,
    toolBrokerMcpUrl: process.env.TOOL_BROKER_MCP_URL,
    platformApiUrl: process.env.PLATFORM_API_URL,
    harnessAgentApiKey: process.env.HARNESS_AGENT_API_KEY,
    egressEnforce: process.env.HARNESS_EGRESS_ENFORCE === 'true',
  }
}

export class CloudRunJobHarnessLauncher implements HarnessLauncher {
  readonly mode = 'cloud-run-job'

  constructor(private config: CloudRunJobLauncherConfig) {}

  async launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
    agentVersion?: number
    actingUserId?: string
    question?: string
    harnessAgentApiKey?: string
    ephemeralKeyId?: string
  }): Promise<{ jobId: string; executionName?: string }> {
    const token = await getCloudRunAccessToken(this.config.bearerToken)
    const endpoint = cloudRunJobRunEndpoint(
      this.config.projectId,
      this.config.location,
      this.config.jobName,
    )

    const env = buildHarnessContainerEnv(input, {
      callbackUrl: this.config.callbackUrl,
      callbackToken: this.config.callbackToken,
      commandJson: this.config.commandJson,
      harnessMode: this.config.harnessMode,
      modelGatewayUrl: this.config.modelGatewayUrl,
      toolBrokerMcpUrl: this.config.toolBrokerMcpUrl,
      platformApiUrl: this.config.platformApiUrl,
      harnessAgentApiKey:
        input.harnessAgentApiKey?.trim() ??
        (() => {
          const fallback = this.config.harnessAgentApiKey?.trim()
          if (!fallback) {
            throw new Error(
              'Hiányzik a per-dispatch HARNESS_AGENT_API_KEY. A dispatcher efemer kulcsot kell adjon át.',
            )
          }
          return fallback
        })(),
      egressEnforce: this.config.egressEnforce,
    })

    const response = await fetch(`${endpoint}:run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{ env: harnessEnvToCloudRunOverrides(env) }],
        },
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Cloud Run Job launch failed: ${response.status} ${body.slice(0, 500)}`)
    }

    const data = (await response.json()) as { name?: string }
    const executionName = data.name
    return {
      jobId: executionName ?? `${this.config.jobName}:${input.ticketId}`,
      executionName,
    }
  }
}
