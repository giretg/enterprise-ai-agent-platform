/**
 * MCP kliens-telepítés: URL, Codex/Claude parancs, Cursor one-click link.
 *
 * Futtatás: npx tsx scripts/mcp-client-setup.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import huMessages from '../src/messages/hu.json'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpSetupLanding } from '../src/components/mcp/mcp-setup-landing'
import {
  CONTROL_PLANE_GET_STARTED_PATH,
  buildMcpClientSetup,
  claudeMcpAddCommand,
  codexMcpSetupCommand,
  grokMcpAddCommand,
  cursorMcpInstallHref,
  firstRunGetStartedPath,
  mcpClientName,
  mcpUrlForTenant,
} from '../src/lib/mcp-client-setup'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

function main() {
  const origin = 'https://app.example.com/'
  const slug = 'acme'
  const setup = buildMcpClientSetup({ origin, tenantSlug: slug })

  check('tenant MCP URL strips trailing slash and keeps the slug', () => {
    assert.equal(mcpUrlForTenant(origin, slug), 'https://app.example.com/api/mcp/acme')
    assert.equal(setup.mcpUrl, 'https://app.example.com/api/mcp/acme')
  })

  check('server name is slug-scoped so two tenants do not collide', () => {
    assert.equal(mcpClientName(slug), 'ea-acme')
    assert.equal(setup.serverName, 'ea-acme')
    assert.notEqual(mcpClientName('other'), mcpClientName(slug))
  })

  check('Codex one-liner adds streamable HTTP then starts OAuth login', () => {
    const cmd = codexMcpSetupCommand('ea-acme', setup.mcpUrl)
    assert.match(cmd, /^codex mcp add ea-acme --url https:\/\/app\.example\.com\/api\/mcp\/acme/)
    assert.match(cmd, /codex mcp login ea-acme$/)
    assert.equal(setup.codexCommand, cmd)
    assert.doesNotMatch(cmd, /mcp-remote/)
  })

  check('Claude Code uses HTTP transport, not stdio/mcp-remote', () => {
    const cmd = claudeMcpAddCommand('ea-acme', setup.mcpUrl)
    assert.equal(cmd, 'claude mcp add --transport http ea-acme https://app.example.com/api/mcp/acme')
    assert.equal(setup.claudeCommand, cmd)
  })

  check('Grok Build CLI uses HTTP transport like Claude', () => {
    const cmd = grokMcpAddCommand('ea-acme', setup.mcpUrl)
    assert.equal(cmd, 'grok mcp add --transport http ea-acme https://app.example.com/api/mcp/acme')
    assert.equal(setup.grokCommand, cmd)
  })

  check('Cursor install link is one-click and encodes {url} as base64 JSON', () => {
    const href = cursorMcpInstallHref('ea-acme', setup.mcpUrl)
    assert.equal(setup.cursorInstallHref, href)
    const url = new URL(href)
    assert.equal(url.origin + url.pathname, 'https://cursor.com/install-mcp')
    assert.equal(url.searchParams.get('name'), 'ea-acme')
    const config = url.searchParams.get('config')
    assert.ok(config)
    const decoded = JSON.parse(Buffer.from(config, 'base64').toString('utf8')) as {
      type?: string
      url?: string
    }
    assert.equal(decoded.type, 'http')
    assert.equal(decoded.url, setup.mcpUrl)
  })

  check('first login without cookie goes to get-started; returning user does not', () => {
    assert.equal(firstRunGetStartedPath(undefined), CONTROL_PLANE_GET_STARTED_PATH)
    assert.equal(firstRunGetStartedPath(''), CONTROL_PLANE_GET_STARTED_PATH)
    assert.equal(firstRunGetStartedPath('1'), null)
  })

  check('control-plane gyökér cookie nélkül a landingre küld, pending/platform előtt nem', () => {
    const root = readFileSync(resolve(process.cwd(), 'src/app/control-plane/page.tsx'), 'utf8')
    assert.match(root, /firstRunGetStartedPath/)
    assert.match(root, /MCP_SETUP_SEEN_COOKIE/)
    assert.match(root, /CONTROL_PLANE_PENDING_PATH/)
    assert.match(root, /CONTROL_PLANE_PLATFORM_HOME/)
  })

  check('header catalog keeps a standing Első lépések leaf', () => {
    const nav = readFileSync(resolve(process.cwd(), 'src/lib/control-plane-nav.ts'), 'utf8')
    assert.match(nav, /key: 'get-started'/)
    assert.match(nav, /href: '\/control-plane\/get-started'/)
    assert.match(nav, /label: 'Első lépések'/)
  })

  check('Hermes is first; every client guide starts collapsed, branded cards', () => {
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: 'hu', messages: huMessages },
        createElement(McpSetupLanding, { setup, continueHref: '/control-plane' }),
      ),
    )
    const details = html.match(/<details\b[^>]*>/g) ?? []
    assert.equal(details.length, 7)
    assert.equal(details.some((tag) => /\sopen(?:\s|=|>|"")/.test(tag)), false)
    assert.ok(html.indexOf('>Hermes Desktop') < html.indexOf('>Codex<'))
    assert.match(html, /hermes mcp add excellence --url https:\/\/app\.example\.com\/api\/mcp\/acme --auth oauth &amp;&amp; hermes mcp login excellence/)
    assert.match(html, /Szinkronizáld az Excellence agenteimet/)
    assert.match(html, /hermes-agent\.nousresearch\.com\/#downloads/)
    assert.match(html, /user-guide\/bot-mode/)
    for (const client of ['hermes', 'codex', 'cursor', 'grok', 'claude', 'claudecode', 'goose']) {
      assert.match(html, new RegExp(`/mcp-clients/${client}\\.svg`))
    }
    assert.match(html, /Goose Desktop/)
    assert.match(html, /Streamable HTTP/)
    assert.match(html, /Extensions → Add custom extension/)
    assert.match(html, /https:\/\/app\.example\.com\/api\/mcp\/acme/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
