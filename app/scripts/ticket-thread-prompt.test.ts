/**
 * Ticket-szál soft-resume prompt.
 * Run: npx tsx scripts/ticket-thread-prompt.test.ts
 */
import assert from 'node:assert/strict'
import {
  TICKET_CONTINUE_RULES,
  TICKET_DISCUSSION_RULES,
  buildThreadContextPrompt,
  buildTicketDiscussionHistory,
} from '../src/lib/ticket-thread-prompt'
import type { TicketCommentWithAttachments } from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function comment(
  partial: Partial<TicketCommentWithAttachments> & Pick<TicketCommentWithAttachments, 'seq' | 'kind' | 'body'>,
): TicketCommentWithAttachments {
  return {
    id: `c-${partial.seq}`,
    ticketId: 't1',
    authorType: partial.kind === 'agent_answer' ? 'agent' : partial.kind === 'system_note' ? 'system' : 'human',
    authorUserId: null,
    authorAgentId: null,
    authorDisplayName: partial.kind === 'agent_answer' ? 'LACI' : 'Gergely',
    agentVersion: partial.kind === 'agent_answer' ? 6 : null,
    structured: null,
    parentId: null,
    transitionId: null,
    createdAt: new Date(),
    attachments: [],
    ...partial,
  }
}

check('első futás: nincs continue szabály', () => {
  const prompt = buildThreadContextPrompt({
    comments: [comment({ seq: 1, kind: 'human_comment', body: 'csatolva a tulajdoni lap' })],
    originalTask: 'csatolva a tulajdoni lap',
  })
  assert.doesNotMatch(prompt, /Folytatasi szabalyok/)
  assert.match(prompt, /Eredeti feladat/)
})

check('handback után: continue szabály + checkpoint + deliverable lista', () => {
  const prompt = buildThreadContextPrompt({
    comments: [
      comment({
        seq: 1,
        kind: 'agent_answer',
        body: '## Elkészült\n- Excel kész\n\n## Nem készült el\n- formázás',
      }),
      comment({ seq: 2, kind: 'human_comment', body: 'folytasd' }),
    ],
    originalTask: 'csatolva a tulajdoni lap',
    workspaceFiles: ['043.pdf', 'audit.xlsx', '.tool-results/x.json'],
  })
  assert.match(prompt, /Folytatasi szabalyok/)
  assert.match(prompt, new RegExp(TICKET_CONTINUE_RULES.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, /CHECKPOINT/)
  assert.match(prompt, /audit\.xlsx/)
  assert.doesNotMatch(prompt, /\.tool-results/)
  assert.match(prompt, /folytasd/)
})

check('megbeszélés mód: discussion szabály, nincs continue', () => {
  const prompt = buildThreadContextPrompt({
    comments: [
      comment({
        seq: 1,
        kind: 'agent_answer',
        body: '## Elkészült\n- Excel kész',
      }),
      comment({ seq: 2, kind: 'human_comment', body: 'meséld el mi volt' }),
    ],
    originalTask: 'csatolva a tulajdoni lap',
    mode: 'discussion',
  })
  assert.match(prompt, /Megbeszelesi szabalyok/)
  assert.match(prompt, new RegExp(TICKET_DISCUSSION_RULES.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(prompt, /Folytatasi szabalyok/)
  assert.match(prompt, /CHECKPOINT/)
  assert.match(prompt, /meséld el mi volt/)
})

check('megbeszélés history: eredeti feladat + szál a chat UI-nak', () => {
  const history = buildTicketDiscussionHistory({
    comments: [
      comment({ seq: 1, kind: 'human_comment', body: 'csatolva a tulajdoni lap' }),
      comment({ seq: 2, kind: 'agent_answer', body: 'Excel kész' }),
      comment({ seq: 3, kind: 'human_comment', body: 'mi hiányzik?' }),
    ],
    originalTask: 'csatolva a tulajdoni lap',
    ticketCreatedAt: new Date('2026-08-05T06:57:00Z'),
  })
  assert.equal(history[0]?.text, 'csatolva a tulajdoni lap')
  assert.equal(history[0]?.authorLabel, 'Eredeti feladat')
  // Az első human komment = eredeti feladat → ne duplikálódjon.
  assert.equal(history.length, 3)
  assert.equal(history[1]?.role, 'agent')
  assert.equal(history[1]?.text, 'Excel kész')
  assert.equal(history[2]?.role, 'user')
  assert.equal(history[2]?.text, 'mi hiányzik?')
})

if (failures > 0) {
  console.error(`\n${failures} ticket-thread-prompt test(s) failed`)
  process.exit(1)
}
console.log('\nticket-thread-prompt tests passed')
