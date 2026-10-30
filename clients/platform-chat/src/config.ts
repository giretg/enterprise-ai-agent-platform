import { DEFAULT_CORE_TOOLS } from './tool-loading.ts'

/** A worker konfigurációja env-ből. A platformot CSAK a publikus URL-jén éri el (§3, D7). */
export type Config = {
  port: number
  /** A platform publikus originje: MCP, Model Gateway, folytatási token; CORS is csak ezt fogadja. */
  platformOrigin: string
  /** A worker saját publikus címe (Cloud Tasks cél + OIDC audience). */
  selfUrl: string
  chatTokenSecret: string
  databaseUrl: string
  queue:
    | { kind: 'inline' }
    | { kind: 'cloud_tasks'; project: string; location: string; queue: string; serviceAccountEmail: string }
  storage: { kind: 'gcs'; bucket: string } | { kind: 'local'; dir: string }
  /** #1022: alapból teljes sémával betöltött eszközök; a többi az eszköz-indexből `tool_describe`-bal tölthető be. */
  coreTools: string[]
  limits: {
    maxSteps: number
    maxTurnSeconds: number
    maxAttemptsPerStep: number
    historyMessages: number
    toolResultChars: number
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const secret = required(env, 'PLATFORM_CHAT_TOKEN_SECRET')
  if (secret.length < 32) throw new Error('PLATFORM_CHAT_TOKEN_SECRET must be at least 32 characters')
  const queueKind = env.PLATFORM_CHAT_QUEUE ?? 'cloud_tasks'
  return {
    port: int(env.PORT, 8080),
    platformOrigin: required(env, 'PLATFORM_ORIGIN').replace(/\/+$/, ''),
    selfUrl: required(env, 'PLATFORM_CHAT_SELF_URL').replace(/\/+$/, ''),
    chatTokenSecret: secret,
    databaseUrl: required(env, 'PLATFORM_CHAT_DATABASE_URL'),
    queue:
      queueKind === 'inline'
        ? { kind: 'inline' }
        : {
            kind: 'cloud_tasks',
            project: required(env, 'GOOGLE_CLOUD_PROJECT'),
            location: env.PLATFORM_CHAT_TASKS_LOCATION ?? 'europe-west3',
            queue: env.PLATFORM_CHAT_TASKS_QUEUE ?? 'platform-chat-steps',
            serviceAccountEmail: required(env, 'PLATFORM_CHAT_TASKS_SA'),
          },
    storage: env.PLATFORM_CHAT_ATTACHMENTS_BUCKET
      ? { kind: 'gcs', bucket: env.PLATFORM_CHAT_ATTACHMENTS_BUCKET }
      : { kind: 'local', dir: env.PLATFORM_CHAT_LOCAL_STORAGE_DIR ?? '.platform-chat-attachments' },
    coreTools: env.PLATFORM_CHAT_CORE_TOOLS !== undefined
      ? env.PLATFORM_CHAT_CORE_TOOLS.split(',').map((n) => n.trim()).filter(Boolean)
      : [...DEFAULT_CORE_TOOLS],
    limits: {
      maxSteps: int(env.PLATFORM_CHAT_MAX_STEPS, 25),
      // A platform folytatási tokenje 45 percig él — ennél hosszabb forduló nem lehet.
      maxTurnSeconds: Math.min(int(env.PLATFORM_CHAT_TURN_MAX_SECONDS, 40 * 60), 44 * 60),
      maxAttemptsPerStep: 3,
      historyMessages: int(env.PLATFORM_CHAT_HISTORY_MESSAGES, 30),
      toolResultChars: int(env.PLATFORM_CHAT_TOOL_RESULT_CHARS, 40_000),
    },
  }
}
