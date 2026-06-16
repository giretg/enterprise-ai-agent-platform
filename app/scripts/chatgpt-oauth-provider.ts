/**
 * S2 — valódi ChatGPT OAuth provider sidecar.
 *
 * A Model Gateway `CHATGPT_OAUTH_PROVIDER_URL` erre mutat. A sidecar a
 * `~/.codex/auth.json`-ból olvassa a „Sign in with ChatGPT" OAuth tokeneket
 * (szerveroldalon marad — az agent és a Goose sosem látja), szükség esetén
 * frissíti a refresh_token-nel, és a ChatGPT Responses backendet hívja.
 *
 * Futtatás:
 *   npm run s2:provider
 * Env:
 *   CHATGPT_OAUTH_PROVIDER_KEY  belső bearer kulcs (a Gateway ezzel hív; default dev érték)
 *   CHATGPT_OAUTH_PROVIDER_PORT default 3101
 *   CODEX_AUTH_FILE             default ~/.codex/auth.json
 *   CHATGPT_OAUTH_MODEL         default gpt-5.5 (a seed sentinel-modell helyett)
 *
 * Kontraktus (a Gateway felé): POST { agentId, ticketId, messages, modelConfig }
 *   → { content, usage: { promptTokens, completionTokens } }
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  callChatGptOAuth,
  isAccessTokenExpired,
  refreshAccessToken,
  type ChatGptOAuthTokens,
} from '../src/domain/gateway/chatgpt-oauth-bridge'
import type { GatewayMessage } from '../src/domain/gateway/model-gateway'

const PORT = Number.parseInt(process.env.CHATGPT_OAUTH_PROVIDER_PORT ?? '3101', 10)
const EXPECTED_KEY = process.env.CHATGPT_OAUTH_PROVIDER_KEY ?? 'dev-internal-key'
const AUTH_FILE = process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json')

type AuthFile = {
  tokens: { access_token: string; refresh_token: string; account_id: string; id_token?: string }
  last_refresh?: string
}

function loadAuth(): AuthFile {
  return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as AuthFile
}

/** Lejárat előtt frissít és visszaírja az auth.json-t; visszaadja a használandó tokeneket. */
async function getFreshTokens(): Promise<ChatGptOAuthTokens> {
  const auth = loadAuth()
  if (!isAccessTokenExpired(auth.tokens.access_token)) {
    return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id }
  }
  console.log('[s2-provider] access token lejárt — frissítés refresh_token-nel…')
  const refreshed = await refreshAccessToken(auth.tokens.refresh_token)
  auth.tokens.access_token = refreshed.accessToken
  auth.tokens.refresh_token = refreshed.refreshToken
  if (refreshed.idToken) auth.tokens.id_token = refreshed.idToken
  auth.last_refresh = new Date().toISOString()
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 })
  console.log('[s2-provider] token frissítve, auth.json visszaírva')
  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  if ((req.headers.authorization ?? '') !== `Bearer ${EXPECTED_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: GatewayMessage[]
      modelConfig?: { model?: string }
    }

    const tokens = await getFreshTokens()
    const result = await callChatGptOAuth({
      tokens,
      messages: body.messages ?? [],
      model: body.modelConfig?.model ?? '',
    })

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: result.content, usage: result.usage, model: result.model }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[s2-provider] hiba:', message)
    const status = /429|rate|quota/i.test(message) ? 429 : 502
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[s2-provider] ChatGPT OAuth provider listening on http://127.0.0.1:${PORT}/`)
  console.log(`[s2-provider] auth file: ${AUTH_FILE}`)
})
