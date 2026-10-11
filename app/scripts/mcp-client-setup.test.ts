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
import enMessages from '../src/messages/en.json'
import huMessages from '../src/messages/hu.json'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpSetupLanding } from '../src/components/mcp/mcp-setup-landing'
import {
  buildMcpClientSetup,
  claudeMcpAddCommand,
  codexMcpSetupCommand,
  grokMcpAddCommand,
  cursorMcpInstallHref,
  hermesMcpInstallHref,
  mcpClientName,
  mcpUrlForTenant,
} from '../src/lib/mcp-client-setup'
import { onboardingSteps } from '../src/lib/overview-onboarding'

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

  check('Hermes install link is one-click and encodes OAuth HTTP config', () => {
    const href = hermesMcpInstallHref(setup.mcpUrl)
    assert.equal(setup.hermesInstallHref, href)
    assert.match(href, /^hermes:\/\/mcp\/install\?name=excellence&config=/)
    const url = new URL(href)
    const config = url.searchParams.get('config')
    assert.ok(config)
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(config), 'base64').toString('utf8')) as {
      url?: string
      auth?: string
    }
    assert.equal(decoded.url, setup.mcpUrl)
    assert.equal(decoded.auth, 'oauth')
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

  check('control-plane gyökér az Áttekintésre küld, nem az útmutatóra', () => {
    const root = readFileSync(resolve(process.cwd(), 'src/app/control-plane/page.tsx'), 'utf8')
    assert.match(root, /resolveDefaultAgentWorkspacePath/)
    assert.doesNotMatch(root, /get-started/)
  })

  check('header catalog: Áttekintés leaf replaces Első lépések', () => {
    const nav = readFileSync(resolve(process.cwd(), 'src/lib/control-plane-nav.ts'), 'utf8')
    assert.match(nav, /key: 'dashboard'/)
    assert.match(nav, /href: '\/control-plane\/dashboard'/)
    assert.doesNotMatch(nav, /key: 'get-started'/)
  })

  check('onboarding: admin 3 lépés, operátor csak a saját MCP-je', () => {
    const none = { companyConnectorCount: 0, agentCount: 0, mcpUsed: false }
    assert.deepEqual(
      onboardingSteps({ isAdmin: true, ...none }).map((s) => s.key),
      ['connectors', 'agents', 'mcp'],
    )
    assert.deepEqual(onboardingSteps({ isAdmin: false, ...none }), [{ key: 'mcp', done: false }])
    const done = onboardingSteps({ isAdmin: true, companyConnectorCount: 1, agentCount: 2, mcpUsed: true })
    assert.ok(done.every((s) => s.done))
    const partial = onboardingSteps({ isAdmin: true, companyConnectorCount: 0, agentCount: 1, mcpUsed: false })
    assert.deepEqual(partial.map((s) => s.done), [false, true, false])
  })

  check('Hermes is first; every client guide starts collapsed, branded cards', () => {
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: 'hu', timeZone: 'Europe/Budapest', messages: huMessages },
        createElement(McpSetupLanding, { setup, continueHref: '/control-plane' }),
      ),
    )
    const details = html.match(/<details\b[^>]*>/g) ?? []
    assert.equal(details.length, 11)
    assert.equal(details.some((tag) => /\sopen(?:\s|=|>|"")/.test(tag)), false)
    assert.ok(html.indexOf('>Hermes Desktop') < html.indexOf('>Codex<'))
    assert.match(html, /hermes:\/\/mcp\/install\?name=excellence/)
    assert.match(html, /hermes mcp add excellence --url https:\/\/app\.example\.com\/api\/mcp\/acme --auth oauth &amp;&amp; hermes mcp login excellence/)
    assert.match(html, /Töltsd le az AI munkatársaimat/)
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

  check('admin Enterprise telepítő: munkatárs-választó, egy letöltés, egy parancs', () => {
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: 'hu', timeZone: 'Europe/Budapest', messages: huMessages },
        createElement(McpSetupLanding, {
          setup,
          continueHref: '/control-plane',
          hermesAdmin: {
            modelKeyConfigured: true,
            members: [{ userId: '22222222-2222-4222-8222-222222222222', name: 'Kovács Anna', email: 'anna@example.com' }],
            defaultUserId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ),
    )
    assert.match(html, /\/control-plane\/ai-client-policy/)
    assert.match(html, /Kovács Anna \(anna@example.com\)/)
    assert.match(html, /Telepítő letöltése/)
    assert.match(html, /sudo bash excellence-telepito\.sh/)
    assert.match(html, /Windows: Windowsos számítógépen ez a telepítő még nem működik/)
    assert.doesNotMatch(html, /natív Hermes|gépi csomag/)
    assert.match(enMessages.GetStarted.hermesEntInstallWindows, /does not work on a Windows computer yet/)
    assert.doesNotMatch(enMessages.GetStarted.hermesEntInstallWindows + enMessages.ClientPolicy.floorHelp, /native/)
    assert.doesNotMatch(enMessages.ClientPolicy.effectiveNotice, /machine package/)
    assert.doesNotMatch(huMessages.ClientPolicy.effectiveNotice + huMessages.ClientPolicy.floorHelp, /gépi csomag|natív/)
    assert.doesNotMatch(html, /github\.com\/giretg\/enterprise-ai-agent-platform\/archive/)
    assert.doesNotMatch(html, /install-managed\.sh floor\.json/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
