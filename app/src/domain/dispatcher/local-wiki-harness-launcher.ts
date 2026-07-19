import type { HarnessLauncher } from './dispatcher-service'
import { scheduleBackgroundWork } from '@/lib/schedule-background'
import {
  resolveTicketProcessRoute,
  type TicketProcessRoute,
} from '@/lib/ticket-process-route'
import { logger } from '@/lib/observability/logger'

export type LocalWikiTicketSnapshot = {
  processInstanceId: string | null
  payload: unknown
  state: string
}

export type LocalWikiHarnessDeps = {
  findTicket: (ticketId: string) => Promise<LocalWikiTicketSnapshot | null>
  processGeneral: (input: { ticketId: string; agentId: string }) => Promise<void>
  processWiki: (input: { ticketId: string; agentId: string }) => Promise<void>
  releaseDispatchLock: (ticketId: string, lockToken: string) => Promise<void>
  /**
   * Launch/process hiba: a dispatcher már `in_progress`-re állította a ticketet.
   * Ha még ott van, állítsuk vissza `ready`-re (mint a szinkron launch catch ága).
   */
  recoverLaunchFailure: (input: {
    ticketId: string
    lockToken: string
    error: unknown
  }) => Promise<void>
  resolveRoute?: (payload: unknown) => TicketProcessRoute
  /** Teszt/override: alapból Next `after()` vagy fire-and-forget. */
  scheduleBackground?: (task: () => Promise<void>) => void
}

/**
 * Beépített (in-process) harness — docker-local / cloud-run-job mintájára
 * fire-and-forget: a `launch()` a futás *indulása* után azonnal visszatér,
 * a processTicket a háttérben fut. Így a board create / pontosítás-visszaadás
 * UI nem blokkolódik a teljes agent-futásra.
 */
export class LocalWikiHarnessLauncher implements HarnessLauncher {
  readonly mode = 'local-wiki'

  constructor(private readonly deps: LocalWikiHarnessDeps) {}

  async launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
    agentVersion?: number
    actingUserId?: string
    question?: string
    gooseModel?: string
    harnessAgentApiKey?: string
    ephemeralKeyId?: string
  }): Promise<{ jobId: string; executionName?: string }> {
    const jobId = `local-wiki-${input.ticketId}`
    const schedule = this.deps.scheduleBackground ?? scheduleBackgroundWork
    schedule(() => this.run(input))
    return { jobId, executionName: 'local-wiki:in-process' }
  }

  private async run(input: {
    ticketId: string
    agentId: string
    lockToken: string
  }): Promise<void> {
    try {
      const ticket = await this.deps.findTicket(input.ticketId)
      // Process-instance ticketek a generalTaskRuntime-on futnak: a wikiRuntime
      // `question` mezőt vár, a process ticketek title + inputSlot-okat tartalmaznak.
      const isProcessTicket = Boolean(ticket?.processInstanceId)
      const resolveRoute = this.deps.resolveRoute ?? resolveTicketProcessRoute
      const route: TicketProcessRoute = isProcessTicket
        ? 'general'
        : resolveRoute(ticket?.payload)

      if (route === 'general') {
        await this.deps.processGeneral({
          ticketId: input.ticketId,
          agentId: input.agentId,
        })
      } else {
        await this.deps.processWiki({
          ticketId: input.ticketId,
          agentId: input.agentId,
        })
      }
      await this.deps.releaseDispatchLock(input.ticketId, input.lockToken)
    } catch (error) {
      try {
        await this.deps.recoverLaunchFailure({
          ticketId: input.ticketId,
          lockToken: input.lockToken,
          error,
        })
      } catch (recoverError) {
        logger.error(
          {
            event: 'local_wiki_harness',
            result: 'recover_failed',
            ticketId: input.ticketId,
            error: recoverError instanceof Error ? recoverError.message : String(recoverError),
            originalError: error instanceof Error ? error.message : String(error),
          },
          'local-wiki harness recover failed',
        )
      }
      logger.error(
        {
          event: 'local_wiki_harness',
          result: 'error',
          ticketId: input.ticketId,
          agentId: input.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'local-wiki harness run failed',
      )
    }
  }
}
