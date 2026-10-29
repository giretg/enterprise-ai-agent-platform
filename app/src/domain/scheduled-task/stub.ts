import { createHash } from 'node:crypto'
import { normalizeCron } from './cron'

/**
 * #640 0.a: a harness-be csak ez a vékony csonk kerül. A szöveget mindig a szerver állítja
 * elő (taskId + klienspéldány + sablonverzió), így tudja, minek kellene a gépen lennie.
 */
export const STUB_TEMPLATE_VERSION = 1
export const SCHEDULED_TASK_CLIENT_TYPES = ['claude_routine', 'claude_desktop', 'codex', 'goose', 'hermes', 'other'] as const
export type ScheduledTaskClientType = (typeof SCHEDULED_TASK_CLIENT_TYPES)[number]
export type ScheduledTaskClient = { clientType: string; clientInstanceId: string }

export function isScheduledTaskClientType(value: unknown): value is ScheduledTaskClientType {
  return typeof value === 'string' && (SCHEDULED_TASK_CLIENT_TYPES as readonly string[]).includes(value)
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Amit a gépen tükrözni kell: ütemezés + be/ki. Az utasítás nincs benne (futáskor jön). */
export function scheduleHash(input: { cron: string; timezone: string; enabled: boolean }): string {
  return shortHash(JSON.stringify([normalizeCron(input.cron), input.timezone, input.enabled ? 'on' : 'off']))
}

export function stubHash(text: string): string {
  return shortHash(text.replace(/\r\n/g, '\n').trim())
}

export function stubPrompt(input: { taskId: string; client: ScheduledTaskClient }): string {
  const args = JSON.stringify({
    taskId: input.taskId,
    installation: { clientType: input.client.clientType, clientInstanceId: input.client.clientInstanceId },
  })
  return [
    `[Excellence AI scheduled task v${STUB_TEMPLATE_VERSION} — do not edit]`,
    `Call the MCP tool platform.scheduled_task.run_start with ${args} and follow its answer exactly.`,
    'If the answer says skip or deny, stop without doing anything else.',
  ].join('\n')
}

export function expectedStubHash(taskId: string, client: ScheduledTaskClient): string {
  return stubHash(stubPrompt({ taskId, client }))
}

/** A csonkba helyben hozzáírt szöveg (§5.2 L4); a csonk maga nem számít bele. */
export function stubExtraText(stubText: string, taskId: string, client: ScheduledTaskClient): string {
  const canonical = stubPrompt({ taskId, client })
  const normalized = stubText.replace(/\r\n/g, '\n').trim()
  let rest = normalized
  for (const line of canonical.split('\n')) rest = rest.replace(line, '')
  return rest.trim()
}

/** S3: naponta egyszer futó szinkron-csonk. Nincs benne taskId, ezért nem kerül a leltárba. */
export function syncStubPrompt(client: ScheduledTaskClient): string {
  const args = JSON.stringify({ client, unattended: true, inventory: '<every platform stub on this client>' })
  return [
    `[Excellence AI scheduled task sync v${STUB_TEMPLATE_VERSION} — do not edit]`,
    `List the scheduled tasks on this client whose prompt starts with "[Excellence AI scheduled task v". Call the MCP tool platform.scheduled_task.sync with ${args}.`,
    'Carry out only the actions without a question (op is not "ask"), then report them with platform.scheduled_task.install_report. Leave every question for the next interactive session.',
  ].join('\n')
}

/** K10: laptopon munkaidőben (9:30 + 0–29 perc, a userhez kötött eltolással), felhőben bármikor. */
export function syncStubCron(userId: string): string {
  const offset = parseInt(shortHash(userId).slice(0, 4), 16) % 30
  return `${30 + offset} 9 * * *`
}
