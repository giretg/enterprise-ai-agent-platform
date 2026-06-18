export type GooseCommandEnv = Record<string, string | undefined>

/**
 * Goose CLI parancs JSON tömbként (HARNESS_COMMAND_JSON szerződés).
 * HARNESS_MODE=goose esetén a job-entrypoint ezt használja, ha nincs explicit parancs.
 */
export function buildGooseCommandJson(env: GooseCommandEnv): string | null {
  const mode = env.HARNESS_MODE ?? 'callback-only'
  if (mode !== 'goose') return null

  const recipePath = env.HARNESS_RECIPE_PATH ?? '/recipes/wiki-answer.yaml'
  const ticketId = env.TICKET_ID
  const agentVersion = env.AGENT_VERSION ?? '1'
  const question = env.HARNESS_QUESTION?.trim()
  const provider = env.GOOSE_PROVIDER ?? 'openai'
  const model = env.GOOSE_MODEL ?? 'chatgpt-oauth-default'
  if (!ticketId) return null
  if (!question) return null

  const args = [
    'goose',
    'run',
    '--no-session',
    '--max-turns',
    env.HARNESS_MAX_TURNS ?? '12',
    '--provider',
    provider,
    '--model',
    model,
    '--recipe',
    recipePath,
    '--params',
    `ticket_id=${ticketId}`,
    '--params',
    `agent_version=${agentVersion}`,
    '--params',
    `question=${question}`,
  ]

  const outputFormat = env.HARNESS_OUTPUT_FORMAT
  if (outputFormat) {
    args.push('--output-format', outputFormat)
  }

  return JSON.stringify(args)
}

export function resolveHarnessCommandJson(env: GooseCommandEnv): string | null {
  if (env.HARNESS_COMMAND_JSON) return env.HARNESS_COMMAND_JSON
  return buildGooseCommandJson(env)
}
