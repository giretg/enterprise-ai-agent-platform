/**
 * #468 — Tool-prompt méret: mennyi séma-szöveget fizet egy agent fordulónként
 * MA (minden grantolt tool teljes sémája + teljes connector-katalógus) vs. a
 * halasztott betöltéssel (mag-toolok sémája + tool-index + connector-index).
 * Futtatás: npm run tool-prompt-size -- <agentId>
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'
import { PostgresToolBrokerRepository } from '../src/repositories/postgres/tool-broker-repository'
import { listAllowedChatTools, loadHttpApiConnectorsForGate } from '../src/domain/agent/chat-tool-loop'
import { TOOL_REGISTRY, toolIndexSummary, toolJsonSchema } from '../src/domain/tool-broker/tool-registry'

const schemaChars = (name: keyof typeof TOOL_REGISTRY) =>
  JSON.stringify({ name, description: TOOL_REGISTRY[name].description, parameters: toolJsonSchema(name) }).length

async function main() {
  const agentId = process.argv[2]
  if (!agentId) throw new Error('Használat: tool-prompt-size <agentId>')
  const repo = new PostgresToolBrokerRepository()
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { systemRole: true } })
  const tools = await listAllowedChatTools(repo, agentId, agent ?? undefined)
  const connectors = await loadHttpApiConnectorsForGate(repo, agentId)

  const today = tools.reduce((n, t) => n + schemaChars(t), 0)
  const preloaded = tools.filter((t) => TOOL_REGISTRY[t].preload)
  const spec =
    preloaded.reduce((n, t) => n + schemaChars(t), 0) +
    tools.reduce((n, t) => n + t.length + toolIndexSummary(t).length + 4, 0)
  const connectorToday = connectors.spec ? [...connectors.describeBlocks.values()].join('\n\n').length + 600 : 0
  const connectorSpec = connectors.spec?.length ?? 0

  console.log(`Grantolt toolok: ${tools.length} (előtöltött: ${preloaded.length})`)
  console.log(`tools[] séma:        ma ${today} kar → spec ${spec} kar`)
  console.log(`connector-katalógus: ma ${connectorToday} kar → spec ${connectorSpec} kar`)
  const a = today + connectorToday
  const b = spec + connectorSpec
  console.log(`Összesen:            ma ${a} kar → spec ${b} kar (${a ? Math.round((1 - b / a) * 100) : 0}% csökkenés)`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
