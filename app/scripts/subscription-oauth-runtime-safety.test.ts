/**
 * Claude Code / Grok CLI OAuth: hibatitok-védelmi regresszió.
 * Futtatás: npm run test:subscription-oauth-runtime-safety
 */
import assert from 'node:assert/strict'
import {
  callClaudeCodeOAuth,
  ClaudeCodeOAuthBackendError,
  DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS,
  claudeCodeOAuthRequestTimeoutMs,
  refreshClaudeCodeAccessToken,
} from '../src/domain/gateway/claude-code-oauth-bridge'
import {
  callGrokCliOAuth,
  GrokCliOAuthBackendError,
  grokCliOAuthRequestTimeoutMs,
  refreshGrokCliAccessToken,
} from '../src/domain/gateway/grok-cli-oauth-bridge'
import { classifyProviderError, isFallbackEligible } from '../src/domain/gateway/fallback-chain'

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

const grokTokens = {
  entryKey: 'https://auth.x.ai::client',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  clientId: 'client',
  raw: {},
}

async function main() {
  console.log('=== Subscription OAuth runtime safety teszt ===')

  await check('Claude HTTP-hiba nem tükröz vissza nyers upstream adatot', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('prompt=bizalmas-ügyféladat token=should-not-leak', {
      status: 502,
    })) as typeof fetch
    try {
      await assert.rejects(
        () => callClaudeCodeOAuth({
          tokens: { accessToken: 'access-token' },
          messages: [{ role: 'user', content: 'bizalmas üzleti kérés' }],
          model: 'claude-sonnet-4-6',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ClaudeCodeOAuthBackendError)
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

  await check('Claude refresh-hiba sem szivárogtat tokent', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('refresh_token=should-not-leak', { status: 401 })) as typeof fetch
    try {
      await assert.rejects(
        () => refreshClaudeCodeAccessToken('refresh-token'),
        (error: unknown) => {
          assert.ok(error instanceof ClaudeCodeOAuthBackendError)
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

  await check('Claude hálózati hiba fallback-képes, nyers hiba nélkül', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('upstream diagnostic: prompt=bizalmas-ügyféladat')
    }) as typeof fetch
    try {
      await assert.rejects(
        () => callClaudeCodeOAuth({
          tokens: { accessToken: 'access-token' },
          messages: [{ role: 'user', content: 'hello' }],
          model: 'claude-sonnet-4-6',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ClaudeCodeOAuthBackendError)
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

  await check('Claude timeout fail-safe', () => {
    assert.equal(claudeCodeOAuthRequestTimeoutMs({}), DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS)
    assert.equal(claudeCodeOAuthRequestTimeoutMs({ CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS: 'nope' }), DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS)
    assert.equal(claudeCodeOAuthRequestTimeoutMs({ CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS: '15000' }), 15_000)
  })

  await check('Grok HTTP-hiba nem tükröz vissza nyers upstream adatot', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('prompt=bizalmas-ügyféladat token=should-not-leak', {
      status: 426,
    })) as typeof fetch
    try {
      await assert.rejects(
        () => callGrokCliOAuth({
          tokens: grokTokens,
          messages: [{ role: 'user', content: 'bizalmas üzleti kérés' }],
          model: 'grok-4.6',
        }),
        (error: unknown) => {
          assert.ok(error instanceof GrokCliOAuthBackendError)
          assert.equal(error.kind, 'http')
          assert.equal(error.status, 426)
          assert.equal(error.message.includes('bizalmas-ügyféladat'), false)
          assert.equal(error.message.includes('should-not-leak'), false)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('Grok refresh-hiba sem szivárogtat tokent', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('refresh_token=should-not-leak', { status: 400 })) as typeof fetch
    try {
      await assert.rejects(
        () => refreshGrokCliAccessToken(grokTokens),
        (error: unknown) => {
          assert.ok(error instanceof GrokCliOAuthBackendError)
          assert.equal(error.kind, 'http')
          assert.equal(error.status, 400)
          assert.equal(error.message.includes('should-not-leak'), false)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('Grok timeout fail-safe', () => {
    assert.equal(grokCliOAuthRequestTimeoutMs({ GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS: '' }), 120_000)
    assert.equal(grokCliOAuthRequestTimeoutMs({ GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS: '90000' }), 90_000)
  })

  console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
