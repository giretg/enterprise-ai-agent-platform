/**
 * Agent API tool-context ownership regressziók.
 * Futtatás: npm run test:agent-api-tool-context
 */
import assert from 'node:assert/strict'
import {
  isAgentApiToolContextOwnedByAgent,
  type AgentApiToolContextLookup,
} from '../src/lib/agent-api-tool-context'

let passed = 0
let failed = 0

function lookup(input: {
  ticketAgentId?: string | null
  ticketOwners?: Record<string, string | null>
  conversationAgentId?: string | null
}): AgentApiToolContextLookup {
  return {
    async findTicketOwner(ticketId) {
      if (input.ticketOwners && Object.prototype.hasOwnProperty.call(input.ticketOwners, ticketId)) {
        return { agentId: input.ticketOwners[ticketId] ?? null }
      }
      return input.ticketAgentId === undefined ? null : { agentId: input.ticketAgentId }
    },
    async findConversationOwner() {
      return input.conversationAgentId === undefined || input.conversationAgentId === null
        ? null
        : { agentId: input.conversationAgentId }
    },
  }
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (error) {
    console.error(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

async function main() {
  await check('a saját ticketes workspace-hívás engedélyezett', async () => {
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', ticketIds: ['ticket-a'] },
        lookup({ ticketAgentId: 'agent-a' }),
      ),
      true,
    )
  })

  await check('idegen agent ticketje nem választhat ki más tenant-munkaterületet', async () => {
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', ticketIds: ['ticket-b'] },
        lookup({ ticketAgentId: 'agent-b' }),
      ),
      false,
  )
})

  await check('hiányzó ticket és board_write cél-ticket is fail-closed', async () => {
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', ticketIds: ['missing-ticket'] },
        lookup({}),
      ),
      false,
    )
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        // A második az MCP/API board_write args.ticketId-je: nem elég csak a külső kontextust nézni.
        { agentId: 'agent-a', ticketIds: ['ticket-a', 'ticket-b'] },
        lookup({ ticketOwners: { 'ticket-a': 'agent-a', 'ticket-b': 'agent-b' } }),
      ),
      false,
    )
  })

  await check('idegen vagy hiányzó beszélgetés nem használható tool-kontektsusként', async () => {
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', conversationId: 'conversation-b' },
        lookup({ conversationAgentId: 'agent-b' }),
      ),
      false,
    )
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', conversationId: 'missing-conversation' },
        lookup({}),
      ),
      false,
    )
  })

  await check('a két saját kontextus együtt is működik', async () => {
    assert.equal(
      await isAgentApiToolContextOwnedByAgent(
        { agentId: 'agent-a', ticketIds: ['ticket-a'], conversationId: 'conversation-a' },
        lookup({ ticketAgentId: 'agent-a', conversationAgentId: 'agent-a' }),
      ),
      true,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
