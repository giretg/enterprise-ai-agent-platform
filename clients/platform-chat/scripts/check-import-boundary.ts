/**
 * D7 / elfogadási feltétel 7: a worker nem importál a platform kódjából (`app/`), és a platform
 * sem a worker kódjából. A worker a platformot csak HTTP-n éri el (MCP + Model Gateway).
 * Futtatás: npm run test:import-boundary (a CI ezt futtatja).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const WORKER = resolve(import.meta.dirname, '..')
const REPO = resolve(WORKER, '../..')
const APP = join(REPO, 'app')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry.startsWith('.')) return []
    const abs = join(dir, entry)
    return statSync(abs).isDirectory() ? walk(abs) : [abs]
  })
}

const specifiers = (text: string) =>
  [...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  )

let violations = 0
for (const file of walk(WORKER).filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f))) {
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    const crossesIntoApp =
      spec.startsWith('@/') ||
      spec.startsWith('@prisma/') ||
      (spec.startsWith('.') && resolve(join(file, '..'), spec).startsWith(APP + '/'))
    if (crossesIntoApp) {
      console.error(`FORBIDDEN import "${spec}" in ${relative(REPO, file)} — a worker csak HTTP-n érheti el a platformot`)
      violations++
    }
  }
}
for (const file of walk(join(APP, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))) {
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    if (spec.includes('clients/platform-chat') || spec.includes('platform-chat-worker')) {
      console.error(`FORBIDDEN import "${spec}" in ${relative(REPO, file)} — a platform nem importálhat a workerből`)
      violations++
    }
  }
}
if (violations) {
  console.error(`platform-chat import boundary: ${violations} violation(s)`)
  process.exit(1)
}
console.log('platform-chat import boundary: ok')
