/**
 * ChatGPT OAuth híd: hibatitok- és beragadás-védelmi regressziós tesztek.
 * Futtatás: npm run test:chatgpt-oauth-runtime-safety
 */
import assert from 'node:assert/strict'
import {
  callChatGptOAuth,
  ChatGptOAuthBackendError,
  DEFAULT_CHATGPT_OAUTH_REQUEST_TIMEOUT_MS,
  chatGptOAuthRequestTimeoutMs,
  refreshAccessToken,
} from '../src/domain/gateway/chatgpt-oauth-bridge'
import { classifyProviderError, isFallbackEligible } from '../src/domain/gateway/fallback-chain'
import { ChatGptOAuthProvider } from '../src/domain/gateway/model-gateway'
import { SecretManagerTokenStore } from '../src/domain/gateway/oauth-token-store'

let failures = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  OK ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

const input = {
  tokens: { accessToken: 'access-token', accountId: 'account-1' },
  messages: [{ role: 'user' as const, content: 'bizalmas üzleti kérés' }],
  model: 'gpt-5.5',
}

async function main() {
  console.log('=== ChatGPT OAuth runtime safety teszt ===')

  await check('hibás Responses-válasz nem tükröz vissza nyers upstream adatot', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('prompt=bizalmas-ügyféladat token=should-not-leak', {
      status: 502,
    })) as typeof fetch
    try {
      await assert.rejects(
        () => callChatGptOAuth(input),
        (error: unknown) => {
          assert.ok(error instanceof ChatGptOAuthBackendError)
          assert.equal(error.kind, 'http')
          assert.equal(error.status, 502)
          assert.equal(error.message.includes('bizalmas-ügyféladat'), false)
          assert.equal(error.message.includes('should-not-leak'), false)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('hibás token-refresh válasz sem tükröz vissza titkot', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('refresh_token=should-not-leak', { status: 401 })) as typeof fetch
    try {
      await assert.rejects(
        () => refreshAccessToken('refresh-token'),
        (error: unknown) => {
          assert.ok(error instanceof ChatGptOAuthBackendError)
          assert.equal(error.kind, 'http')
          assert.equal(error.status, 401)
          assert.equal(error.message.includes('should-not-leak'), false)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('hálózati OAuth-hiba fallback-képes marad, nyers hiba nélkül', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('upstream diagnostic: prompt=bizalmas-ügyféladat')
    }) as typeof fetch
    try {
      await assert.rejects(
        () => callChatGptOAuth(input),
        (error: unknown) => {
          assert.ok(error instanceof ChatGptOAuthBackendError)
          assert.equal(error.kind, 'network')
          assert.equal(error.message.includes('bizalmas-ügyféladat'), false)
          assert.equal(classifyProviderError(error), 'provider_unavailable')
          assert.equal(isFallbackEligible(classifyProviderError(error)), true)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('beragadt OAuth-kérés timeout után feloldja az account-sávot', async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = process.env.CHATGPT_OAUTH_REQUEST_TIMEOUT_MS
    process.env.CHATGPT_OAUTH_REQUEST_TIMEOUT_MS = '10'
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })) as typeof fetch
    try {
      await assert.rejects(
        () => callChatGptOAuth({ ...input, tokens: { ...input.tokens, accountId: 'timeout-account' } }),
        (error: unknown) => {
          assert.ok(error instanceof ChatGptOAuthBackendError)
          assert.equal(error.kind, 'timeout')
          assert.match(error.message, /10ms/)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
      if (originalTimeout === undefined) delete process.env.CHATGPT_OAUTH_REQUEST_TIMEOUT_MS
      else process.env.CHATGPT_OAUTH_REQUEST_TIMEOUT_MS = originalTimeout
    }
  })

  await check('Secret Manager hibaüzenet sem tartalmaz upstream választörzset', async () => {
    const originalFetch = globalThis.fetch
    const originalServiceToken = process.env.SECRET_MANAGER_ACCESS_TOKEN
    process.env.SECRET_MANAGER_ACCESS_TOKEN = 'service-token'
    globalThis.fetch = (async () => new Response('secret_payload=should-not-leak', { status: 503 })) as typeof fetch
    try {
      await assert.rejects(
        () => new SecretManagerTokenStore('projects/demo/secrets/oauth').load(),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'Secret Manager access failed: 503')
          assert.equal(error.message.includes('should-not-leak'), false)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
      if (originalServiceToken === undefined) delete process.env.SECRET_MANAGER_ACCESS_TOKEN
      else process.env.SECRET_MANAGER_ACCESS_TOKEN = originalServiceToken
    }
  })

  await check('beragadt Gateway–sidecar kapcsolat is timeoutol', async () => {
    const originalFetch = globalThis.fetch
    const keys = [
      'CHATGPT_OAUTH_PROVIDER_URL',
      'CHATGPT_OAUTH_PROVIDER_KEY',
      'CHATGPT_OAUTH_TOKEN_SECRET',
      'CHATGPT_OAUTH_EMBEDDED',
      'MODEL_PROVIDER_FETCH_TIMEOUT_MS',
    ] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.CHATGPT_OAUTH_PROVIDER_URL = 'https://oauth-sidecar.example.test'
    process.env.CHATGPT_OAUTH_PROVIDER_KEY = 'internal-key'
    process.env.CHATGPT_OAUTH_TOKEN_SECRET = ''
    process.env.CHATGPT_OAUTH_EMBEDDED = 'false'
    process.env.MODEL_PROVIDER_FETCH_TIMEOUT_MS = '10'
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })) as typeof fetch
    try {
      await assert.rejects(
        () => new ChatGptOAuthProvider().chat({
          agentId: 'agent-1',
          messages: input.messages,
          modelConfig: { provider: 'chatgpt-oauth', model: 'gpt-5.5' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /timed out after 10ms/)
          assert.equal(classifyProviderError(error), 'provider_unavailable')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  await check('érvénytelen timeout-konfiguráció fail-safe alapértékre esik vissza', () => {
    assert.equal(chatGptOAuthRequestTimeoutMs({ CHATGPT_OAUTH_REQUEST_TIMEOUT_MS: '0' }), DEFAULT_CHATGPT_OAUTH_REQUEST_TIMEOUT_MS)
    assert.equal(chatGptOAuthRequestTimeoutMs({ CHATGPT_OAUTH_REQUEST_TIMEOUT_MS: 'not-a-number' }), DEFAULT_CHATGPT_OAUTH_REQUEST_TIMEOUT_MS)
  })

  console.log(`\n=== Összesítés === ${failures === 0 ? 'MIND ZÖLD' : `${failures} sikertelen`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
