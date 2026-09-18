/**
 * Provider fetch + forduló-falióra AbortSignal egyesítés regressziója (#525 lyuk).
 * Futtatás: npm run test:provider-fetch-abort
 *
 * A `!callerSignal.aborted` szűrés kihagyná a már lejárt faliórát, és a fetch
 * a provider timeoutig (alap 120s) továbbmehetne — fizetős hívás a keret után.
 */
import assert from 'node:assert/strict'
import {
  combineProviderFetchSignal,
  fetchWithProviderTimeout,
  ModelCallAbortedError,
} from '../src/domain/gateway/model-gateway'

let passed = 0
let failed = 0

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  OK  ${name}`)
    })
    .catch((e: unknown) => {
      failed++
      console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  console.log('provider-fetch-abort')

  await check('már aborted hívó jel → a kombinált jel azonnal aborted', () => {
    const timeout = new AbortController()
    const caller = AbortSignal.abort()
    const combined = combineProviderFetchSignal(timeout.signal, caller)
    assert.equal(combined.aborted, true)
  })

  await check('élő hívó jel → a kombinált jel követi a hívó abortját', () => {
    const timeout = new AbortController()
    const caller = new AbortController()
    const combined = combineProviderFetchSignal(timeout.signal, caller.signal)
    assert.equal(combined.aborted, false)
    caller.abort()
    assert.equal(combined.aborted, true)
  })

  await check('nincs hívó jel → csak a timeout jel él', () => {
    const timeout = new AbortController()
    const combined = combineProviderFetchSignal(timeout.signal, null)
    assert.equal(combined.aborted, false)
    assert.equal(combined, timeout.signal)
  })

  await check('fetchWithProviderTimeout: már aborted jel → azonnal ModelCallAbortedError, nincs fetch', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response('should-not-run')
    }) as typeof fetch
    try {
      await assert.rejects(
        () =>
          fetchWithProviderTimeout('http://example.test/chat', {
            signal: AbortSignal.abort(),
          }),
        (e: unknown) => e instanceof ModelCallAbortedError,
      )
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('fetchWithProviderTimeout: abort a fetch közben → ModelCallAbortedError', async () => {
    const originalFetch = globalThis.fetch
    const caller = new AbortController()
    globalThis.fetch = (async (_url, init) => {
      const signal = init?.signal
      assert.ok(signal)
      return await new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
        // Szimuláljuk: a hívó a provider válasz előtt megszakít.
        setTimeout(() => caller.abort(), 0)
      })
    }) as typeof fetch
    try {
      await assert.rejects(
        () =>
          fetchWithProviderTimeout('http://example.test/chat', {
            signal: caller.signal,
          }),
        (e: unknown) => e instanceof ModelCallAbortedError,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  console.log(`\nprovider-fetch-abort: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
