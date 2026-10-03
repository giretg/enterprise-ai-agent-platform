/**
 * Hermes Managed Client — gép-padló generátor (#746 V1-8, spec §5.5, §9 R5, D9).
 *
 * A `/etc/hermes` gépenként egy, ezért a user látható agentjeire feloldott effektív
 * policyk uniója (a legbővebb engedély). Ami egyik agentnél sem engedett, az
 * `agent.disabled_toolsets`. A finomabb, user × agent döntés a Guardé.
 *
 * Nincs látható agent → minden kapuzott toolset tiltva (üres unió, fail-closed).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { CapabilityKey } from '@/domain/client-policy/capabilities'
import { getPolicySnapshot, type ClientPolicyStore, type PolicySnapshot } from '@/domain/client-policy/policy-service'

/** A toolset csak akkor kerül a padlóba, ha minden látható agent effektív szintje pontosan ez. */
const TOOLSET_GATES: { key: CapabilityKey; denied: string; toolsets: readonly string[] }[] = [
  { key: 'code_execution', denied: 'denied', toolsets: ['terminal', 'code_execution'] },
  { key: 'local_files', denied: 'none', toolsets: ['file'] },
  { key: 'browser', denied: 'denied', toolsets: ['browser', 'computer_use'] },
  { key: 'web_search', denied: 'denied', toolsets: ['web'] },
  { key: 'local_memory', denied: 'denied', toolsets: ['memory'] },
  { key: 'autonomous_run', denied: 'denied', toolsets: ['delegation', 'cronjob'] },
]

/**
 * Hermes aux feladatok, amelyek saját providerre kaphatnának (2026-10, hermes-agent main).
 * Mindegyik `provider: main`, üres base_url/api_key, üres fallback_chain — a H-1b levél-pin,
 * mert az aux `base_url` felülírja a providert.
 */
export const AUXILIARY_TASKS = [
  'approval',
  'compression',
  'curator',
  'kanban_decomposer',
  'mcp',
  'monitor',
  'profile_describer',
  'review',
  'title_generation',
  'triage_specifier',
  'tts_audio_tags',
  'vision',
  'web_extract',
] as const

/**
 * Ismert modell-szolgáltatói kulcsok és base-URL env-ek. A managed `.env` üresre pineli őket,
 * ezért a `/model --provider openrouter` (és társai) nem visz ki a gateway mellé.
 * Csak a Hermes folyamat env-jét írja felül, a gép többi programjáét nem.
 */
export const PINNED_EMPTY_ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ARCEE_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GMI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'NEBIUS_API_KEY',
  'NOVITA_API_KEY',
  'NVIDIA_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'STEPFUN_API_KEY',
  'TOGETHER_API_KEY',
  'UPSTAGE_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'ZAI_API_KEY',
] as const

export const EXC_TOKEN_KEY_CMD = '/opt/excellence/bin/exc-token model'
export const EXC_GUARD_COMMAND = '/opt/excellence/bin/exc-guard'
export const GUARD_PLUGIN_NAME = 'excellence-guard'

/** A Guard heartbeatje ugyanezt a kanonikus hash-t küldi (V1-6). A fájltartalom bájtja számít, a sorrend fix. */
export const MANAGED_DIR_HASH_VERSION = 'excellence-managed-dir-v1'
export const MANAGED_DIR_FILE_NAMES = ['config.yaml', '.env', 'excellence-install-id'] as const

export type ManagedDirFiles = {
  'config.yaml': string
  '.env': string
  'excellence-install-id': string
}

export type MachineFloorPackage = {
  installId: string
  managedDirHash: string
  gatewayBaseUrl: string
  agentIds: string[]
  disabledToolsets: string[]
  files: ManagedDirFiles
}

export interface MachineFloorStore {
  /** Atomi kiosztás: párhuzamos első letöltések ugyanazt az ID-t kapják. */
  getOrCreateInstallId(input: { tenantId: string; userId: string; installId: string }): Promise<string>
  save(input: { tenantId: string; userId: string; installId: string; managedDirHash: string }): Promise<void>
  /** null = ehhez az installhoz nincs kiadott padló (az env-tartalék dönthet). */
  expectedHash(input: { tenantId: string; userId: string; installId: string }): Promise<string | null>
}

export type MachineFloorDeps = {
  policyStore: ClientPolicyStore
  listVisibleAgentIds: (input: { tenantId: string; userId: string }) => Promise<string[]>
  floors: MachineFloorStore
  newInstallId?: () => string
}

const q = (value: string) => JSON.stringify(value)

export function modelGatewayBaseUrl(origin: string): string {
  const trimmed = origin.trim().replace(/\/$/, '')
  if (!/^https?:\/\/[^/\s]+$/.test(trimmed)) throw new Error('bad_gateway_origin')
  return `${trimmed}/api/model-gateway/v1`
}

/** Üres lista: minden kapu tilt (nincs agent, amin engedve lenne). */
export function disabledToolsetsForPolicies(policies: readonly Pick<PolicySnapshot, 'capabilities'>[]): string[] {
  const disabled = new Set<string>()
  for (const gate of TOOLSET_GATES) {
    if (policies.every((p) => p.capabilities[gate.key] === gate.denied)) {
      for (const toolset of gate.toolsets) disabled.add(toolset)
    }
  }
  return [...disabled].sort()
}

export function renderManagedEnv(): string {
  const lines = [
    '# Excellence gép-padló: az ismert modell-kulcsok üresek, a Hermes nem írhatja felül őket.',
    ...PINNED_EMPTY_ENV_KEYS.map((key) => `${key}=`),
    '',
  ]
  return lines.join('\n')
}

export function renderManagedConfig(input: { gatewayBaseUrl: string; disabledToolsets: readonly string[] }): string {
  const url = q(input.gatewayBaseUrl)
  const aux = AUXILIARY_TASKS.map(
    (task) =>
      `  ${task}:\n    provider: "main"\n    model: ""\n    base_url: ""\n    api_key: ""\n    fallback_chain: []`,
  ).join('\n')
  const disabled =
    input.disabledToolsets.length === 0
      ? '  disabled_toolsets: []'
      : `  disabled_toolsets:\n${[...input.disabledToolsets].sort().map((t) => `    - ${q(t)}`).join('\n')}`
  return [
    'model:',
    '  provider: "excellence"',
    `  base_url: ${url}`,
    '  api_mode: "chat_completions"',
    'providers:',
    '  excellence:',
    `    api: ${url}`,
    `    key_cmd: ${q(EXC_TOKEN_KEY_CMD)}`,
    '    session_affinity_header: "X-Excellence-Session"',
    'auxiliary:',
    aux,
    'fallback_providers: []',
    'plugins:',
    '  enabled:',
    `    - ${q(GUARD_PLUGIN_NAME)}`,
    '  disabled: []',
    'hooks:',
    '  pre_tool_call:',
    `    - command: ${q(EXC_GUARD_COMMAND)}`,
    '      timeout: 30',
    '      fail_closed: true',
    'hooks_auto_accept: true',
    'security:',
    '  redact_secrets: true',
    'agent:',
    disabled,
    '',
  ].join('\n')
}

export function managedDirHash(files: ManagedDirFiles): string {
  const body = MANAGED_DIR_FILE_NAMES.map((name) => {
    const digest = createHash('sha256').update(files[name]).digest('hex')
    return `${name}\n${digest}\n`
  }).join('')
  return createHash('sha256').update(`${MANAGED_DIR_HASH_VERSION}\n${body}`).digest('hex')
}

export function buildManagedFiles(input: {
  gatewayBaseUrl: string
  disabledToolsets: readonly string[]
  installId: string
}): { files: ManagedDirFiles; managedDirHash: string } {
  const files: ManagedDirFiles = {
    'config.yaml': renderManagedConfig(input),
    '.env': renderManagedEnv(),
    'excellence-install-id': `${input.installId}\n`,
  }
  return { files, managedDirHash: managedDirHash(files) }
}

export async function resolveMachineFloor(
  deps: Pick<MachineFloorDeps, 'policyStore' | 'listVisibleAgentIds'>,
  input: { tenantId: string; userId: string },
): Promise<{ agentIds: string[]; disabledToolsets: string[] }> {
  const agentIds = [...(await deps.listVisibleAgentIds(input))].sort()
  const policies = await Promise.all(agentIds.map((agentId) => getPolicySnapshot(deps.policyStore, { ...input, agentId })))
  return { agentIds, disabledToolsets: disabledToolsetsForPolicies(policies) }
}

export async function issueMachineFloor(
  deps: MachineFloorDeps,
  input: { tenantId: string; userId: string; gatewayBaseUrl: string },
): Promise<MachineFloorPackage> {
  const { agentIds, disabledToolsets } = await resolveMachineFloor(deps, input)
  const installId = await deps.floors.getOrCreateInstallId({ ...input, installId: (deps.newInstallId ?? randomUUID)() })
  const built = buildManagedFiles({ gatewayBaseUrl: input.gatewayBaseUrl, disabledToolsets, installId })
  await deps.floors.save({ ...input, installId, managedDirHash: built.managedDirHash })
  return { installId, gatewayBaseUrl: input.gatewayBaseUrl, agentIds, disabledToolsets, ...built }
}
