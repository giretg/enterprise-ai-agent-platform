/**
 * S2 spike — lokális ChatGPT OAuth provider stub.
 * A Model Gateway CHATGPT_OAUTH_PROVIDER_URL erre mutathat fejlesztés/acceptance alatt.
 *
 * Futtatás: npm run s2:stub
 * Env: CHATGPT_OAUTH_PROVIDER_URL=http://127.0.0.1:3101/v1/chat
 *      CHATGPT_OAUTH_PROVIDER_KEY=stub-internal-key
 */
import { createServer } from 'node:http'

const PORT = Number.parseInt(process.env.CHATGPT_OAUTH_STUB_PORT ?? '3101', 10)
const EXPECTED_KEY = process.env.CHATGPT_OAUTH_PROVIDER_KEY ?? 'stub-internal-key'

function stubWikiAnswer(messages: Array<{ role: string; content: string }>): string {
  const combined = messages.map((m) => m.content).join('\n').toLowerCase()
  const hasMvp = combined.includes('mvp') || combined.includes('átjáró') || combined.includes('gateway')
  const hasSources = combined.includes('forrás') || combined.includes('docid') || combined.includes('[1]')

  if (!hasSources && hasMvp) {
    return JSON.stringify({
      answer:
        'Az MVP célja egy architektúra-teljes walking skeleton. Minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.',
      sources: [{ docId: 'memory:stub', sectionRef: 'memory:stub:v1' }],
      rationale: 'Stub provider — belső tudásbázis mintából.',
      confidence: 'high',
    })
  }

  if (hasSources) {
    return JSON.stringify({
      answer:
        'Az MVP célja egy architektúra-teljes walking skeleton, amelyben minden komponens legalább egyszer valódi futásban összeáll.',
      sources: [{ docId: 'memory:stub', sectionRef: 'acceptance:wiki' }],
      rationale: 'Stub provider — a megadott forrásrészletek alapján.',
      confidence: 'high',
    })
  }

  return JSON.stringify({
    answer: 'Stub provider válasz — nincs elég forrás a kérdéshez.',
    sources: [],
    rationale: 'Stub provider — nincs egyező forrás.',
    confidence: 'low',
  })
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${EXPECTED_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    messages?: Array<{ role: string; content: string }>
  }

  const messages = body.messages ?? []
  const content = stubWikiAnswer(messages)
  const promptTokens = Math.ceil(messages.map((m) => m.content).join('\n').length / 4)
  const completionTokens = Math.ceil(content.length / 4)

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      content,
      usage: { promptTokens, completionTokens },
    }),
  )
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ChatGPT OAuth stub listening on http://127.0.0.1:${PORT}/v1/chat`)
})
