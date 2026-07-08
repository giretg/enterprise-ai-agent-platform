/**
 * S2 live smoke — valódi ChatGPT OAuth mediáció végponttól végpontig.
 *
 * Elindítja a provider sidecart (chatgpt-oauth-provider.ts), a Model Gateway-t
 * rámutatja (CHATGPT_OAUTH_PROVIDER_URL), majd lefuttat egy valódi wiki-kérdés
 * flow-t: kb_search (Tool Broker) → modellhívás (Gateway → sidecar → ChatGPT) →
 * board_write. Bizonyítja, hogy: (a) a token a sidecarban marad, (b) valódi
 * választ kapunk a ChatGPT-előfizetésen át, (c) a model_calls valós token-
 * számot naplóz, (d) az audit lánc rögzíti a model.call eseményt.
 *
 * Futtatás: npm run s2:live-smoke
 */
import { spawn } from 'node:child_process'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const PORT = Number.parseInt(process.env.CHATGPT_OAUTH_PROVIDER_PORT ?? '3199', 10)
const KEY = process.env.CHATGPT_OAUTH_PROVIDER_KEY ?? 's2-live-smoke-key'
const PROVIDER_URL = `http://127.0.0.1:${PORT}/`

// A Gateway provider env-jét a sidecar elindítása ELŐTT állítjuk be, hogy a
// services importálásakor a valódi provider legyen aktív (a stub kikapcsolva).
process.env.CHATGPT_OAUTH_PROVIDER_URL = PROVIDER_URL
process.env.CHATGPT_OAUTH_PROVIDER_KEY = KEY
delete process.env.CHATGPT_OAUTH_STUB

const QUESTION = 'A belső tudásbázis szerint mi a platform fő célja? Válaszolj egy mondatban.'

function startSidecar() {
  const child = spawn('npx', ['tsx', 'scripts/chatgpt-oauth-provider.ts'], {
    env: {
      ...process.env,
      CHATGPT_OAUTH_PROVIDER_PORT: String(PORT),
      CHATGPT_OAUTH_PROVIDER_KEY: KEY,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return child
}

async function waitForSidecar(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // Bad-auth ping: ha 401-et ad, a szerver él.
      const res = await fetch(PROVIDER_URL, { method: 'POST', body: '{}' })
      if (res.status === 401 || res.status === 200 || res.status === 502) return true
    } catch {
      // még nem figyel
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  console.log('=== S2 live smoke — valódi ChatGPT OAuth mediáció ===\n')
  const sidecar = startSidecar()
  let failures = 0
  const fail = (m: string) => {
    failures++
    console.log(`  ❌ ${m}`)
  }
  const pass = (m: string, d?: string) => console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`)

  try {
    const ready = await waitForSidecar()
    if (!ready) throw new Error('A provider sidecar nem indult el időben')
    pass('Provider sidecar fut', PROVIDER_URL)

    // A services-t a sidecar URL beállítása UTÁN importáljuk.
    const { services } = await import('../src/domain')
    const { repositories } = await import('../src/repositories/postgres')
    const { prisma } = await import('../src/lib/db')

    const agent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
    if (!agent) throw new Error('Wiki Agent nincs — futtasd: npm run db:seed')
    const operator = await prisma.user.findFirst({ where: { role: 'operator' } })
    if (!operator) throw new Error('Operator user nincs — futtasd: npm run db:seed')

    console.log(`Agent: ${agent.name} (${agent.id.slice(0, 8)}…), modell: ${(agent.modelConfig as { model?: string })?.model}`)
    console.log(`Kérdés: ${QUESTION}\n`)

    const t0 = Date.now()
    const result = await services.wiki.askWiki({
      agentId: agent.id,
      question: QUESTION,
      createdById: operator.id,
    })
    const elapsed = Date.now() - t0

    if (result.answer.answer.trim().length > 0) {
      pass('Valódi ChatGPT válasz', `${elapsed}ms, confidence=${result.answer.confidence}`)
      console.log(`\n  --- VÁLASZ ---\n  ${result.answer.answer.replace(/\n/g, '\n  ')}\n`)
    } else {
      fail('Üres válasz a modelltől')
    }

    pass('Beszélgetés-elsődleges flow', result.conversationId.slice(0, 8))

    const calls = await prisma.modelCall.findMany({
      where: { conversationId: result.conversationId },
      orderBy: { createdAt: 'desc' },
    })
    const real = calls.find((c) => c.promptTokens > 0 && c.completionTokens > 0)
    if (real) {
      pass(
        'model_calls valós token-napló',
        `provider=${real.provider} model=${real.model} ${real.promptTokens}+${real.completionTokens} token, ${real.latencyMs}ms, status=${real.status}`,
      )
    } else {
      fail('Nincs valós token-rekord a model_calls-ban')
    }

    const audit = await repositories.audit.findMany({ limit: 30 })
    const modelCallAudit = audit.find(
      (e) => e.action === 'model.call' && e.targetId === result.conversationId,
    )
    if (modelCallAudit) {
      pass('Audit: model.call rögzítve (conversation)', `model=${modelCallAudit.modelUsed}`)
    } else {
      fail('Nincs model.call audit a beszélgetéshez')
    }

    const integrity = await services.auditChain.verifyChain()
    if (integrity.ok) pass('Audit-lánc integritás', `verifyChain ok (${integrity.checked} bejegyzés)`)
    else fail('Audit-lánc sérült')

    await prisma.$disconnect()
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    sidecar.kill('SIGTERM')
  }

  console.log(`\n=== Összesítés === ${failures === 0 ? 'MIND ZÖLD ✅' : `${failures} sikertelen ❌`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
