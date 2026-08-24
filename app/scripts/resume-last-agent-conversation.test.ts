/**
 * Beszélgetés gomb: a legutóbbi szálat nyitja, nem üres újat.
 * Futtatás: npm run test:resume-last-agent-conversation
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { conversationIdToResume } from '../src/lib/resume-last-agent-conversation'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const latest = { id: 'conv-latest' }
const older = { id: 'conv-older' }

function base(
  patch: Partial<Parameters<typeof conversationIdToResume>[0]> = {},
): Parameters<typeof conversationIdToResume>[0] {
  return {
    open: true,
    initialConversationId: null,
    currentConversationId: null,
    userStartedNew: false,
    sessionsLoading: false,
    sessionsFilter: 'active',
    sessions: [latest, older],
    ...patch,
  }
}

check('van előzmény → a lista első (legutóbbi) beszélgetését nyitja', () => {
  assert.equal(conversationIdToResume(base()), 'conv-latest')
})

check('nincs előzmény → üres új beszélgetés marad', () => {
  assert.equal(conversationIdToResume(base({ sessions: [] })), null)
})

check('a user Új beszélgetést kért → nem tölti vissza a legutóbbit', () => {
  assert.equal(conversationIdToResume(base({ userStartedNew: true })), null)
})

check('deep-link conversationId → nem írja felül a célzott szálat', () => {
  assert.equal(
    conversationIdToResume(base({ initialConversationId: 'conv-linked' })),
    null,
  )
})

check('már van nyitott szál → nem cseréli le', () => {
  assert.equal(
    conversationIdToResume(base({ currentConversationId: 'conv-older' })),
    null,
  )
})

check('a lista még tölt → nem nyúl hozzá (ne a előző agent szálát húzza be)', () => {
  assert.equal(conversationIdToResume(base({ sessionsLoading: true })), null)
})

check('archivált szűrőn nem resume-ol — az nem a folytatandó szál', () => {
  assert.equal(conversationIdToResume(base({ sessionsFilter: 'archived' })), null)
})

check('Elemezd / prefill belépés → új téma, nem a Futás-elemző előző szálát nyitja', () => {
  assert.equal(
    conversationIdToResume(base({ initialPrefill: 'Elemezd ezt a ticketet (ticketId: t-1).' })),
    null,
  )
})

const workspace = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-workspace.tsx'),
  'utf8',
)
const panel = readFileSync(
  resolve(process.cwd(), 'src/components/agents/agent-chat-panel.tsx'),
  'utf8',
)

check('a fejléc Új beszélgetés gombja korall és széles képernyőn feliratos', () => {
  assert.match(workspace, /Új beszélgetés/)
  assert.match(workspace, /bg-coral/)
  assert.match(workspace, /hidden lg:inline/)
  assert.match(workspace, /workspaceChatStartNew/)
})

check('a chatpanel a resume-döntést használja, nem üresen nyit', () => {
  assert.match(panel, /conversationIdToResume/)
  assert.match(panel, /userStartedNew/)
  assert.match(panel, /setUserStartedNew\(true\)/)
})

check('Elemezd prefill a resume-döntésbe bekerül — különben a URL-strip után a régi szál visszajön', () => {
  assert.match(panel, /conversationIdToResume\(\{[^}]*initialPrefill/)
})

check('Elemezd prefill új beszélgetést indít, mielőtt a composerbe ír', () => {
  const apply = panel.match(/prefillAppliedRef[\s\S]{0,500}setInput\(initialPrefill\)/)
  assert.ok(apply, 'prefill apply blokk megtalálható')
  assert.match(apply[0], /startNewSession/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
