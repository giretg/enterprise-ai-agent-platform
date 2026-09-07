/**
 * Workspace HTML előnézet: a Cloud Run/Envoy "upstream connect error" törzsét
 * TILOS riportként megjeleníteni, és a hideg-instance resetet újra kell próbálni.
 *
 * Run: npm run test:workspace-html-preview
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isGatewayTerminationBody,
  loadWorkspaceHtmlPreview,
  WorkspaceHtmlPreviewError,
  WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE,
} from '../src/lib/load-workspace-html-preview'
import { htmlWithInlinePreviewCsp } from '../src/lib/workspace-inline-html-headers'

const ENVOY_BODY =
  'upstream connect error or disconnect/reset before headers. reset reason: connection termination'

const REPORT_HTML =
  '<!doctype html><html><head><title>Riport</title></head><body><h1>OK</h1></body></html>'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type FetchStep =
  | { network: true }
  | { status: number; body: string; contentType?: string }

function htmlResponse(status: number, body: string, contentType = 'text/html; charset=utf-8'): FetchStep {
  return { status, body, contentType }
}

function textResponse(status: number, body: string): FetchStep {
  return { status, body, contentType: 'text/plain' }
}

function jsonResponse(status: number, body: unknown): FetchStep {
  return { status, body: JSON.stringify(body), contentType: 'application/json' }
}

function sequenceFetch(steps: FetchStep[]): { fetch: typeof fetch; calls: number } {
  const state = { calls: 0 }
  const fetchImpl: typeof fetch = async (_input, init) => {
    state.calls += 1
    assert.equal(init?.credentials, 'same-origin')
    const step = steps[state.calls - 1] ?? steps[steps.length - 1]
    if (step && 'network' in step) throw new TypeError('Failed to fetch')
    const typed = step as { status: number; body: string; contentType?: string }
    return new Response(typed.body, {
      status: typed.status,
      headers: { 'content-type': typed.contentType ?? 'text/html; charset=utf-8' },
    })
  }
  return { fetch: fetchImpl, get calls() { return state.calls } }
}

async function main() {
console.log('Workspace HTML előnézet (gateway-hiba ne legyen a riport)\n')

await test('az Envoy/Cloud Run hibaszöveg felismerhető', () => {
  assert.equal(isGatewayTerminationBody(ENVOY_BODY), true)
  assert.equal(
    isGatewayTerminationBody(`Nem nyílik meg a fájl :${ENVOY_BODY}`),
    true,
  )
  assert.equal(isGatewayTerminationBody(REPORT_HTML), false)
  assert.equal(isGatewayTerminationBody('{"success":false,"error":"File not found"}'), false)
})

await test('503 Envoy-törzs után a második próbálkozás a riportot adja', async () => {
  const seq = sequenceFetch([textResponse(503, ENVOY_BODY), htmlResponse(200, REPORT_HTML)])
  const html = await loadWorkspaceHtmlPreview('/api/v1/conversations/c/workspace/files?path=r.html', {
    fetch: seq.fetch,
    sleep: async () => {},
  })
  assert.equal(html, REPORT_HTML)
  assert.equal(seq.calls, 2)
})

await test('hálózati szakadás után újrapróbál és sikerül', async () => {
  const seq = sequenceFetch([{ network: true }, htmlResponse(200, REPORT_HTML)])
  const html = await loadWorkspaceHtmlPreview('/api/preview', {
    fetch: seq.fetch,
    sleep: async () => {},
  })
  assert.equal(html, REPORT_HTML)
  assert.equal(seq.calls, 2)
})

await test('kimerített gateway-hiba NEM a proxy szövegét dobja', async () => {
  const seq = sequenceFetch([textResponse(503, ENVOY_BODY)])
  await assert.rejects(
    () =>
      loadWorkspaceHtmlPreview('/api/preview', {
        fetch: seq.fetch,
        attempts: 3,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceHtmlPreviewError)
      assert.equal(error.code, 'gateway')
      assert.equal(error.retryable, true)
      assert.equal(error.message, WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE)
      assert.equal(error.message.includes('upstream connect'), false)
      assert.equal(seq.calls, 3)
      return true
    },
  )
})

await test('200-as Envoy-törzs sem mehet riportként', async () => {
  const seq = sequenceFetch([htmlResponse(200, ENVOY_BODY, 'text/plain')])
  await assert.rejects(
    () =>
      loadWorkspaceHtmlPreview('/api/preview', {
        fetch: seq.fetch,
        attempts: 2,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceHtmlPreviewError)
      assert.equal(error.code, 'gateway')
      return true
    },
  )
})

await test('404 JSON nem retry, nem_found', async () => {
  const seq = sequenceFetch([jsonResponse(404, { success: false, error: 'File not found' })])
  await assert.rejects(
    () =>
      loadWorkspaceHtmlPreview('/api/preview', {
        fetch: seq.fetch,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceHtmlPreviewError)
      assert.equal(error.code, 'not_found')
      assert.equal(error.retryable, false)
      assert.equal(seq.calls, 1)
      return true
    },
  )
})

await test('401 nem retry', async () => {
  const seq = sequenceFetch([jsonResponse(401, { success: false, error: 'Unauthorized' })])
  await assert.rejects(
    () =>
      loadWorkspaceHtmlPreview('/api/preview', {
        fetch: seq.fetch,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceHtmlPreviewError)
      assert.equal(error.code, 'unauthorized')
      assert.equal(seq.calls, 1)
      return true
    },
  )
})

await test('a blob-ba kerülő HTML megkapja a meta CSP-t (header nélkül is zár)', () => {
  const out = htmlWithInlinePreviewCsp(REPORT_HTML)
  assert.match(out, /http-equiv="Content-Security-Policy"/i)
  assert.match(out, /img-src data:/)
  assert.equal(/https?:/.test(out.match(/Content-Security-Policy" content="([^"]+)"/i)?.[1] ?? ''), false)
})

const modalPath = fileURLToPath(
  new URL('../src/components/workspace/html-preview-modal.tsx', import.meta.url),
)
const modalSrc = readFileSync(modalPath, 'utf8')

await test('az iframe NEM a nyers API URL-t tölti (gateway-oldal ne legyen a riport)', () => {
  assert.equal(
    /<iframe[\s\S]*?\bsrc=\{target\.url\}/.test(modalSrc),
    false,
    'iframe src={target.url} a proxy hiboldalát jelenítené meg',
  )
  assert.ok(
    modalSrc.includes('loadWorkspaceHtmlPreview'),
    'a modalnak a fetch+retry helperrel kell töltenie',
  )
})

await test('az iframe sandbox attribútuma ki van kényszerítve (nincs script/same-origin)', () => {
  assert.match(modalSrc, /<iframe[\s\S]*?\bsandbox=""/)
  assert.equal(modalSrc.includes('allow-scripts'), false)
  assert.equal(modalSrc.includes('allow-same-origin'), false)
})

await test('új ablak / letöltés sem a nyers API URL-re navigál a betöltés előtt', () => {
  assert.equal(
    modalSrc.includes('href={target.url}'),
    false,
    'Megnyitom új ablakban ne a hideg Cloud Run URL-t nyissa',
  )
})

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden workspace-HTML előnézet teszt zöld.')
}

void main()
