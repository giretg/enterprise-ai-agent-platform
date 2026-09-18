/**
 * Architecture smoke check: the target composition root and MCP/definition
 * modules must not import the legacy runtime graph.
 *
 * Run: npx tsx src/domain/import-boundary-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const TARGETS = [
  'src/domain/gateway-services.ts',
  'src/auth/mcp-principal.ts',
  'src/app/api/mcp',
  'src/domain/agent-definition',
  'src/domain/enterprise-tools',
  'src/domain/gateway-operation',
]

const FORBIDDEN = [
  /from ['"]@\/domain['"]/,
  /from ['"]@\/domain\/index/,
  /from ['"]@\/domain\/agent\//,
  /from ['"]@\/domain\/gateway\//,
  /from ['"]@\/domain\/dispatcher/,
  /from ['"]@\/domain\/conversation/,
  /from ['"]@\/domain\/channel/,
  /AgentChatRuntime/,
  /ChatTurnLauncher/,
  /ModelGateway/,
  /WikiAgentRuntime/,
  /GeneralTaskRuntime/,
  /BookkeeperAgentRuntime/,
  /ConversationService/,
]

function walk(path: string): string[] {
  const abs = join(ROOT, path)
  const st = statSync(abs)
  if (st.isFile()) return [abs]
  return readdirSync(abs).flatMap((entry) => walk(join(path, entry)))
}

let failed = 0
for (const target of TARGETS) {
  for (const file of walk(target)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const text = readFileSync(file, 'utf8')
    const importLines = text
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) || /^\s*export\s.*from\s/.test(line))
      .join('\n')
    for (const pattern of FORBIDDEN) {
      if (pattern.test(importLines)) {
        console.error(`FORBIDDEN ${pattern} in ${file.slice(ROOT.length + 1)}`)
        failed += 1
      }
    }
  }
}

if (failed > 0) {
  console.error(`import-boundary-guard: ${failed} violation(s)`)
  process.exit(1)
}
console.log('import-boundary-guard: ok')
