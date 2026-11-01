/**
 * Képernyőkép a futó dev szerver oldalairól — hogy egy fejlesztés (ember vagy
 * Claude Code) a böngészőben is ellenőrizhető legyen, belépési lépés nélkül
 * (dev-belépés: `npm run dev:setup`, Clerk nélkül).
 *
 * Használat:
 *   npm run screenshot -- /control-plane /control-plane/agents
 *   npm run screenshot -- --base http://localhost:3001 --out /tmp/shots --mobile /control-plane
 *
 * Kimenet: PNG-k (alap: .data/screenshots/), és minden oldal konzol-hibái/HTTP-státusza.
 * Böngésző: a projekt Playwright-ja; lokálisan egyszer: npx playwright install chromium.
 * Más böngésző: PLAYWRIGHT_CHROMIUM_PATH=/út/chromium. A Claude Code felhőkonténerben
 * előtelepített Chromiumot (/opt/pw-browsers/chromium) magától használja.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, devices } from '@playwright/test'

/** Claude Code felhőkonténer: a Chromium előtelepítve, de más Playwright-verzióhoz. */
const CLOUD_CHROMIUM = '/opt/pw-browsers/chromium'

function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return undefined
  return existsSync(CLOUD_CHROMIUM) ? CLOUD_CHROMIUM : undefined
}

function parseArgs(argv: string[]) {
  let base = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:3000'
  let out = resolve(process.cwd(), '.data/screenshots')
  let mobile = false
  const paths: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base') base = argv[++i]
    else if (arg === '--out') out = resolve(argv[++i])
    else if (arg === '--mobile') mobile = true
    else paths.push(arg)
  }
  return { base, out, mobile, paths: paths.length ? paths : ['/control-plane'] }
}

function fileNameFor(path: string, mobile: boolean): string {
  const slug = path.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '_') || 'root'
  return `${slug}${mobile ? '.mobile' : ''}.png`
}

async function main() {
  const { base, out, mobile, paths } = parseArgs(process.argv.slice(2))
  mkdirSync(out, { recursive: true })

  const browser = await chromium.launch({ executablePath: chromiumPath() })
  const context = await browser.newContext(
    mobile ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } },
  )
  let failed = false
  try {
    for (const path of paths) {
      const page = await context.newPage()
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })
      page.on('pageerror', (err) => consoleErrors.push(err.message))

      const response = await page.goto(new URL(path, base).toString(), {
        waitUntil: 'networkidle',
        timeout: 120_000,
      })
      const file = resolve(out, fileNameFor(path, mobile))
      await page.screenshot({ path: file, fullPage: true })

      const status = response?.status() ?? 0
      if (status >= 400 || consoleErrors.length) failed = true
      console.log(`${status} ${path} → ${file}`)
      if (page.url() !== new URL(path, base).toString()) console.log(`    átirányítva: ${page.url()}`)
      for (const err of consoleErrors) console.log(`    konzol-hiba: ${err.slice(0, 300)}`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
