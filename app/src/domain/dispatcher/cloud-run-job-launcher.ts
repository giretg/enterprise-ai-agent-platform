import type { HarnessLauncher } from './dispatcher-service'

export type CloudRunJobLauncherConfig = {
  projectId: string
  location: string
  jobName: string
  bearerToken?: string
}

type MetadataTokenResponse = {
  access_token?: string
}

function requireConfigValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing Cloud Run harness config: ${name}`)
  return value
}

async function getMetadataServerToken(): Promise<string> {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!response.ok) {
    throw new Error(`Metadata server token request failed: ${response.status}`)
  }

  const data = (await response.json()) as MetadataTokenResponse
  if (!data.access_token) throw new Error('Metadata server token response is missing access_token')
  return data.access_token
}

export function cloudRunConfigFromEnv(): CloudRunJobLauncherConfig {
  return {
    projectId: requireConfigValue('HARNESS_CLOUD_RUN_PROJECT_ID', process.env.HARNESS_CLOUD_RUN_PROJECT_ID),
    location: requireConfigValue('HARNESS_CLOUD_RUN_LOCATION', process.env.HARNESS_CLOUD_RUN_LOCATION),
    jobName: requireConfigValue('HARNESS_CLOUD_RUN_JOB_NAME', process.env.HARNESS_CLOUD_RUN_JOB_NAME),
    bearerToken: process.env.HARNESS_CLOUD_RUN_BEARER_TOKEN,
  }
}

export class CloudRunJobHarnessLauncher implements HarnessLauncher {
  readonly mode = 'cloud-run-job'

  constructor(private config: CloudRunJobLauncherConfig) {}

  async launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
  }): Promise<{ jobId: string; executionName?: string }> {
    const token = this.config.bearerToken ?? (await getMetadataServerToken())
    const endpoint = [
      'https://run.googleapis.com/v2/projects',
      encodeURIComponent(this.config.projectId),
      'locations',
      encodeURIComponent(this.config.location),
      'jobs',
      encodeURIComponent(this.config.jobName),
    ].join('/')

    const response = await fetch(`${endpoint}:run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: 'TICKET_ID', value: input.ticketId },
                { name: 'AGENT_ID', value: input.agentId },
                { name: 'DISPATCH_LOCK_TOKEN', value: input.lockToken },
              ],
            },
          ],
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
