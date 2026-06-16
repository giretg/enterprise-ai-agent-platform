import { mkdir, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import path from 'node:path'

export type GooseHarnessEnv = Record<string, string | undefined>

type GooseConfigInput = {
  ticketId: string
  agentApiKey: string
  modelGatewayBaseUrl: string
  platformApiUrl: string
  bridgeScriptPath?: string
}

function requireValue(env: GooseHarnessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing harness env for goose config: ${name}`)
  return value
}

function resolveBridgeScript(env: GooseHarnessEnv): string {
  return env.HARNESS_MCP_BRIDGE_SCRIPT?.trim() || path.join(process.cwd(), 'scripts/platform-mcp-bridge.ts')
}

async function resolveBridgeCommand(env: GooseHarnessEnv): Promise<{ cmd: string; args: string[] }> {
  const script = resolveBridgeScript(env)
  const localTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
  try {
    await access(localTsx)
    return { cmd: localTsx, args: [script] }
  } catch {
    return { cmd: 'npx', args: ['tsx', script] }
  }
}

export function shouldPrepareGooseConfig(env: GooseHarnessEnv): boolean {
  const mode = env.HARNESS_MODE ?? 'callback-only'
  return mode === 'goose' && Boolean(env.MODEL_GATEWAY_URL?.trim() && env.PLATFORM_API_URL?.trim())
}

export async function prepareGooseHarnessEnv(env: GooseHarnessEnv): Promise<GooseHarnessEnv> {
  if (!shouldPrepareGooseConfig(env)) return env

  const ticketId = requireValue(env, 'TICKET_ID')
  const agentApiKey = requireValue(env, 'HARNESS_AGENT_API_KEY')
  const modelGatewayBaseUrl = requireValue(env, 'MODEL_GATEWAY_URL').replace(/\/$/, '')
  const platformApiUrl = requireValue(env, 'PLATFORM_API_URL').replace(/\/$/, '')
  const bridgeScript = resolveBridgeScript(env)
  const bridgeCommand = await resolveBridgeCommand(env)

  const gatewayUrl = new URL(modelGatewayBaseUrl.includes('://') ? modelGatewayBaseUrl : `http://${modelGatewayBaseUrl}`)
  const openAiHost = `${gatewayUrl.protocol}//${gatewayUrl.host}`
  const openAiBasePath = `${gatewayUrl.pathname.replace(/^\//, '').replace(/\/$/, '')}/chat/completions`

  const gooseRoot = env.GOOSE_PATH_ROOT?.trim() || path.join('/tmp', `goose-harness-${ticketId}`)
  const configDir = path.join(gooseRoot, 'config')
  await mkdir(configDir, { recursive: true })

  const configYaml = [
    'GOOSE_PROVIDER: openai',
    'GOOSE_MODEL: chatgpt-oauth-default',
    'GOOSE_MODE: auto',
    'extensions:',
    '  developer:',
    '    bundled: true',
    '    enabled: false',
    '    name: developer',
    '    type: builtin',
    '  platform_broker:',
    '    enabled: true',
    '    name: platform_broker',
    '    type: stdio',
    `    cmd: ${bridgeCommand.cmd}`,
    `    args: ${JSON.stringify(bridgeCommand.args)}`,
    '    timeout: 300',
    '    env_keys:',
    '      - TICKET_ID',
    '      - PLATFORM_API_URL',
    '      - HARNESS_AGENT_API_KEY',
    '    available_tools:',
    '      - kb_search',
    '      - board_write',
    '',
  ].join('\n')

  await writeFile(path.join(configDir, 'config.yaml'), configYaml, 'utf8')

  return {
    ...env,
    GOOSE_PATH_ROOT: gooseRoot,
    GOOSE_DISABLE_KEYRING: env.GOOSE_DISABLE_KEYRING ?? '1',
    GOOSE_PROVIDER: 'openai',
    GOOSE_MODEL: env.GOOSE_MODEL ?? 'chatgpt-oauth-default',
    GOOSE_MODE: env.GOOSE_MODE ?? 'auto',
    GOOSE_MAX_TURNS: env.HARNESS_MAX_TURNS ?? env.GOOSE_MAX_TURNS ?? '25',
    OPENAI_API_KEY: agentApiKey,
    OPENAI_HOST: openAiHost,
    OPENAI_BASE_PATH: openAiBasePath,
    OPENAI_BASE_URL: `${openAiHost}/${openAiBasePath}`,
    OPENAI_CUSTOM_HEADERS: `X-Ticket-Id=${ticketId}`,
    PLATFORM_API_URL: platformApiUrl,
    HARNESS_MCP_BRIDGE_SCRIPT: bridgeScript,
  }
}

export function gooseConfigPreview(input: GooseConfigInput) {
  return {
    goosePathRoot: `/tmp/goose-harness-${input.ticketId}`,
    openAiBaseUrl: input.modelGatewayBaseUrl,
    platformApiUrl: input.platformApiUrl,
    bridgeScript: input.bridgeScriptPath ?? 'scripts/platform-mcp-bridge.ts',
    developerExtensionEnabled: false,
    platformBrokerTools: ['kb_search', 'board_write'],
  }
}
