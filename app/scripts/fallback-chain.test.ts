import assert from 'node:assert/strict'
import { findFallbackModelUsed } from '../src/domain/gateway/fallback-chain'

// „A beszélgetés a tartalék AI-modellen futott" jelző — a chat-fejléc sárga ikonja.
const fallbacks = [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }]

assert.equal(
  findFallbackModelUsed(
    [
      { provider: 'chatgpt-oauth', model: 'gpt-5.5' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
    ],
    fallbacks,
  ),
  'openrouter/deepseek/deepseek-v4-flash-0731',
)
assert.equal(findFallbackModelUsed([{ provider: 'chatgpt-oauth', model: 'gpt-5.5' }], fallbacks), null)
assert.equal(findFallbackModelUsed([], fallbacks), null)

console.log('fallback-chain.test.ts: OK')
