/**
 * Beszélgetés gomb: a legutóbbi szálat nyitja, nem üres újat.
 * Futtatás: npm run test:resume-last-agent-conversation
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  conversationIdToResume,
  previousConversationLoaderVisible,
  shouldSkipDuplicateSessionSelect,
} from '../src/lib/resume-last-agent-conversation'

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

function base(
  patch: Partial<Parameters<typeof conversationIdToResume>[0]> = {},
): Parameters<typeof conversationIdToResume>[0] {
  return {
    open: true,
    initialConversationId: null,
    currentConversationId: null,
    userStartedNew: false,
    latestConversationId: latest.id,
    ...patch,
  }
}

check('van előzmény → a legutóbbi aktív szálat nyitja (nem a session-listára vár)', () => {
  assert.equal(conversationIdToResume(base()), 'conv-latest')
})

check('nincs előzmény → üres új beszélgetés marad', () => {
  assert.equal(conversationIdToResume(base({ latestConversationId: null })), null)
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

check('a legutóbbi szál id-ja még tölt → nem nyúl hozzá', () => {
  assert.equal(conversationIdToResume(base({ latestConversationId: undefined })), null)
})

check('a session-lista töltése NEM blokkolja a resume-t', () => {
  assert.equal(conversationIdToResume(base()), 'conv-latest')
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

function loader(
  patch: Partial<Parameters<typeof previousConversationLoaderVisible>[0]> = {},
): Parameters<typeof previousConversationLoaderVisible>[0] {
  return {
    messageCount: 0,
    ticketHistoryCount: 0,
    isAgentTyping: false,
    userStartedNew: false,
    statusMessage: null,
    conversationId: null,
    historyLoadState: 'idle',
    latestConversationId: null,
    ...patch,
  }
}

check('a legutóbbi szál id-ja még tölt → loader, ne üdvözlő', () => {
  assert.equal(
    previousConversationLoaderVisible(loader({ latestConversationId: undefined })),
    true,
  )
})

check('van előzmény, a resume még nem commitolt → loader marad (ne villogjon üdvözlőre)', () => {
  assert.equal(
    previousConversationLoaderVisible(loader({ latestConversationId: latest.id })),
    true,
  )
})

check('az előzmény-lista (history sáv) töltése ne takarja a chatet', () => {
  assert.equal(
    previousConversationLoaderVisible(
      loader({
        conversationId: latest.id,
        historyLoadState: 'ready',
        latestConversationId: latest.id,
      }),
    ),
    false,
  )
})

check('üzenetek töltése közben a loader folyamatos', () => {
  assert.equal(
    previousConversationLoaderVisible(
      loader({ conversationId: 'conv-latest', historyLoadState: 'loading' }),
    ),
    true,
  )
})

check('üres előzmény ready állapotban üdvözlőt mutat, nem örökké pörgő loadert', () => {
  assert.equal(
    previousConversationLoaderVisible(
      loader({ conversationId: 'conv-latest', historyLoadState: 'ready' }),
    ),
    false,
  )
})

check('nincs előzmény, a latest id megvan → üdvözlő, nem loader', () => {
  assert.equal(
    previousConversationLoaderVisible(loader({ latestConversationId: null, historyLoadState: 'idle' })),
    false,
  )
})

check('Új beszélgetés gomb → nincs loader', () => {
  assert.equal(
    previousConversationLoaderVisible(loader({ userStartedNew: true, latestConversationId: latest.id })),
    false,
  )
})

check('ugyanarra a szálra már futó betöltést nem indít újra', () => {
  assert.equal(
    shouldSkipDuplicateSessionSelect({
      requestedId: 'conv-latest',
      currentConversationId: null,
      inFlightId: 'conv-latest',
    }),
    true,
  )
})

check('másik szálra váltáskor nem skippel', () => {
  assert.equal(
    shouldSkipDuplicateSessionSelect({
      requestedId: 'conv-older',
      currentConversationId: 'conv-latest',
      inFlightId: null,
    }),
    false,
  )
})

check('a chatpanel a dupla-betöltés őrt és a loader-predikátumot használja', () => {
  assert.match(panel, /shouldSkipDuplicateSessionSelect/)
  assert.match(panel, /previousConversationLoaderVisible/)
  assert.match(panel, /inFlightSessionRef/)
  assert.match(panel, /historyLoadState/)
  const select = panel.match(
    /const selectSession = useCallback\(\s*async \(id: string\) => \{[\s\S]{0,1800}loadAgentChatMessages/,
  )
  assert.ok(select, 'selectSession blokk megtalálható')
  assert.match(select[0], /sessionLoadGenRef\.current \+= 1/)
})

check('a resume effect nem a selectSession identitásra van kötve (ne fusson újra thinking-trace/sessions miatt)', () => {
  const resume = panel.match(
    /const resumeId = conversationIdToResume\([\s\S]*?\n  \}, \[([\s\S]*?)\]\)/,
  )
  assert.ok(resume, 'resume effect dependency tömb megtalálható')
  assert.doesNotMatch(resume[1], /selectSession/)
})

check('nyitáskor a legutóbbi szálat kéri, a session-listát csak az előzmények sáv kinyitásakor', () => {
  assert.match(panel, /findLatestAgentChatSession/)
  assert.match(panel, /if \(!open \|\| !sessionsOpen\) return/)
  const openList = panel.match(
    /useEffect\(\(\) => \{\n    if \(!open\) return\n    const timer = window\.setTimeout\(\(\) => void refreshSessions\(\)/,
  )
  assert.equal(openList, null)
})

check('a findLatest lekérdezés olcsó: findFirst, első user-üzenet join nélkül', () => {
  const platform = readFileSync(resolve(process.cwd(), 'src/app/actions/platform.ts'), 'utf8')
  const start = platform.indexOf('export async function findLatestAgentChatSession')
  const end = platform.indexOf('export async function listAgentChatSessions', start)
  assert.ok(start >= 0 && end > start, 'findLatestAgentChatSession megtalálható')
  const body = platform.slice(start, end)
  assert.match(body, /findFirst\(/)
  assert.match(body, /status: 'active'/)
  assert.doesNotMatch(body, /include:\s*\{/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
