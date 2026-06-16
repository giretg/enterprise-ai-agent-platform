export type HarnessRunParams = {
  ticketId: string
  agentId: string
  lockToken: string
  agentVersion?: number
  question?: string
}

export type HarnessRunEnvConfig = {
  callbackUrl?: string
  callbackToken?: string
  commandJson?: string
  harnessMode?: string
  recipePath?: string
  modelGatewayUrl?: string
  toolBrokerMcpUrl?: string
  platformApiUrl?: string
  harnessAgentApiKey?: string
  egressEnforce?: boolean
  egressProbeUrl?: string
  stubBrokerFallback?: boolean
}

function pushEnv(
  env: Array<{ name: string; value: string }>,
  name: string,
  value: string | undefined,
) {
  if (value?.trim()) env.push({ name, value: value.trim() })
}

export function resolveHarnessCallbackUrl(
  callbackUrl: string | undefined,
  platformApiUrl: string | undefined,
  ticketId: string,
): string | undefined {
  const raw = callbackUrl?.trim()
  if (raw) {
    if (raw.includes('{ticketId}')) return raw.replaceAll('{ticketId}', encodeURIComponent(ticketId))
    return `${raw.replace(/\/$/, '')}/api/v1/harness/tickets/${encodeURIComponent(ticketId)}/complete`
  }
  if (platformApiUrl?.trim()) {
    return `${platformApiUrl.replace(/\/$/, '')}/api/v1/harness/tickets/${encodeURIComponent(ticketId)}/complete`
  }
  return undefined
}

export function resolveModelGatewayUrl(
  modelGatewayUrl: string | undefined,
  platformApiUrl: string | undefined,
): string | undefined {
  if (modelGatewayUrl?.trim()) return modelGatewayUrl.trim()
  if (platformApiUrl?.trim()) return `${platformApiUrl.replace(/\/$/, '')}/api/v1/gateway/v1`
  return undefined
}

/** Közös harness konténer env — docker-local és Cloud Run Job override egyaránt. */
export function buildHarnessContainerEnv(
  input: HarnessRunParams,
  config: HarnessRunEnvConfig,
): Array<{ name: string; value: string }> {
  const platformApiUrl = config.platformApiUrl?.trim()
  const callbackUrl = resolveHarnessCallbackUrl(config.callbackUrl, platformApiUrl, input.ticketId)
  const modelGatewayUrl = resolveModelGatewayUrl(config.modelGatewayUrl, platformApiUrl)
  const harnessMode = config.harnessMode?.trim() || 'goose'
  const recipePath = config.recipePath?.trim() || '/recipes/wiki-answer.yaml'

  const env: Array<{ name: string; value: string }> = [
    { name: 'TICKET_ID', value: input.ticketId },
    { name: 'AGENT_ID', value: input.agentId },
    { name: 'DISPATCH_LOCK_TOKEN', value: input.lockToken },
    { name: 'HARNESS_MODE', value: harnessMode },
    { name: 'HARNESS_RECIPE_PATH', value: recipePath },
  ]

  if (input.agentVersion !== undefined) {
    env.push({ name: 'AGENT_VERSION', value: String(input.agentVersion) })
  }

  if (input.question?.trim()) {
    env.push({ name: 'HARNESS_QUESTION', value: input.question.trim() })
  }

  pushEnv(env, 'HARNESS_CALLBACK_URL', callbackUrl)
  pushEnv(env, 'HARNESS_CALLBACK_TOKEN', config.callbackToken)
  pushEnv(env, 'HARNESS_COMMAND_JSON', config.commandJson)
  pushEnv(env, 'MODEL_GATEWAY_URL', modelGatewayUrl)
  pushEnv(env, 'PLATFORM_API_URL', platformApiUrl)
  pushEnv(env, 'TOOL_BROKER_MCP_URL', config.toolBrokerMcpUrl)
  pushEnv(env, 'HARNESS_AGENT_API_KEY', config.harnessAgentApiKey)

  if (config.egressEnforce) {
    env.push({ name: 'HARNESS_EGRESS_ENFORCE', value: 'true' })
    pushEnv(env, 'HARNESS_EGRESS_PROBE_URL', config.egressProbeUrl ?? 'https://example.com')
  }

  if (config.stubBrokerFallback) {
    env.push({ name: 'HARNESS_STUB_BROKER_FALLBACK', value: '1' })
  }

  return env
}

export function harnessEnvToDockerArgs(env: Array<{ name: string; value: string }>): string[] {
  const args: string[] = []
  for (const entry of env) {
    args.push('-e', `${entry.name}=${entry.value}`)
  }
  return args
}

export function harnessEnvToCloudRunOverrides(env: Array<{ name: string; value: string }>) {
  return env.map(({ name, value }) => ({ name, value }))
}
