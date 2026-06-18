import { defineConfig, devices } from '@playwright/test'
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'

loadEnv({ path: resolve(process.cwd(), '.env.local') })
loadEnv({ path: resolve(process.cwd(), '.env') })

const devServerEnv: Record<string, string> = {
  NODE_ENV: 'development',
  FILE_EDITOR_STUB: 'true',
  DEV_AUTH_ROLE: 'operator',
  CLERK_SECRET_KEY: '',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
}

for (const key of ['DATABASE_URL', 'DIRECT_URL', 'DEV_AUTH_USER_ID', 'DEV_AUTH_EMAIL', 'DEV_AUTH_NAME']) {
  if (process.env[key]) devServerEnv[key] = process.env[key]!
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx next dev --port 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    env: devServerEnv,
  },
})
