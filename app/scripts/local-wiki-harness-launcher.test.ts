/**
 * Regression: local-wiki launch fire-and-forget — a board create / pontosítás
 * UI ne várja meg a teljes processTicket futást.
 */
import assert from 'node:assert/strict'
import { LocalWikiHarnessLauncher } from '../src/domain/dispatcher/local-wiki-harness-launcher'

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    throw err
  }
}

async function main() {
  console.log('local-wiki-harness-launcher')

  await test('launch visszatér mielőtt a processTicket befejeződik', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let processStarted = false
    let processFinished = false
    const pending: Promise<void>[] = []

    const launcher = new LocalWikiHarnessLauncher({
      findTicket: async () => ({
        processInstanceId: null,
        payload: { source: 'board', task: 'x' },
        state: 'in_progress',
      }),
      processGeneral: async () => {
        processStarted = true
        await barrier
        processFinished = true
      },
      processWiki: async () => {
        throw new Error('wiki path should not run for board source')
      },
      releaseDispatchLock: async () => {},
      recoverLaunchFailure: async () => {},
      scheduleBackground: (task) => {
        pending.push(task())
      },
    })

    const startedAt = Date.now()
    const result = await launcher.launch({
      ticketId: 't1',
      agentId: 'a1',
      lockToken: 'lock-1',
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(result.jobId, 'local-wiki-t1')
    assert.ok(elapsedMs < 200, `launch blocked too long: ${elapsedMs}ms`)
    assert.equal(processFinished, false)

    // A háttértask elindul (microtask), de a barrier miatt még nem fejeződik be.
    await Promise.resolve()
    assert.equal(processStarted, true)

    release()
    await Promise.all(pending)
    assert.equal(processFinished, true)
  })

  await test('process hiba → recoverLaunchFailure, lock release a recover-ben', async () => {
    const recoverCalls: Array<{ ticketId: string; lockToken: string; error: unknown }> = []
    const pending: Promise<void>[] = []

    const launcher = new LocalWikiHarnessLauncher({
      findTicket: async () => ({
        processInstanceId: null,
        payload: { source: 'wiki' },
        state: 'in_progress',
      }),
      processGeneral: async () => {
        throw new Error('should use wiki')
      },
      processWiki: async () => {
        throw new Error('boom')
      },
      releaseDispatchLock: async () => {
        throw new Error('release should not run after process failure')
      },
      recoverLaunchFailure: async (input) => {
        recoverCalls.push(input)
      },
      scheduleBackground: (task) => {
        pending.push(task())
      },
    })

    await launcher.launch({ ticketId: 't2', agentId: 'a2', lockToken: 'lock-2' })
    await Promise.all(pending)

    assert.equal(recoverCalls.length, 1)
    assert.equal(recoverCalls[0]?.ticketId, 't2')
    assert.equal(recoverCalls[0]?.lockToken, 'lock-2')
    assert.match(String(recoverCalls[0]?.error), /boom/)
  })

  await test('process ticket → general runtime route', async () => {
    const routes: string[] = []
    const pending: Promise<void>[] = []

    const launcher = new LocalWikiHarnessLauncher({
      findTicket: async () => ({
        processInstanceId: 'proc-1',
        payload: { source: 'wiki' },
        state: 'in_progress',
      }),
      processGeneral: async () => {
        routes.push('general')
      },
      processWiki: async () => {
        routes.push('wiki')
      },
      releaseDispatchLock: async () => {},
      recoverLaunchFailure: async () => {},
      scheduleBackground: (task) => {
        pending.push(task())
      },
    })

    await launcher.launch({ ticketId: 't3', agentId: 'a3', lockToken: 'lock-3' })
    await Promise.all(pending)
    assert.deepEqual(routes, ['general'])
  })

  console.log('OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
