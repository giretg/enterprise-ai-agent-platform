/**
 * #1111 hang-pilot — DB-mentes stub-tesztek: beállítás, OpenAI-kérés, indítási kapuk, token,
 * eszköz-engedélylista, átirat-feldolgozás. Futtatás: npm run test:voice-pilot
 */
import assert from 'node:assert/strict'
import { MCP_ALLOWED_TOOLS, resolveMcpPrincipal, type McpPrincipalDeps } from '../src/auth/mcp-principal'
import {
  limitServerToVoiceTools,
  toolNameFromVoiceAlias,
  VOICE_TOOL_BLOCKED_MESSAGE,
  voiceAllowedToolAliases,
  voiceBlocksTool,
  voiceToolAlias,
} from '../src/auth/voice-tool-guard'
import {
  applyVoiceEvent,
  INITIAL_VOICE_CALL_VIEW,
  voiceEndedMessage,
  voiceEndReport,
  voiceFailureMessage,
  voiceProviderErrorMessage,
  type VoiceCallView,
} from '../src/components/agents/voice-call-events'
import { issueGatewayToken } from '../src/domain/model-gateway-token/gateway-token'
import { PLATFORM_CHAT_INSTALL_ID } from '../src/domain/platform-chat/gateway'
import { CHAT_TOKEN_AUDIENCE, CHAT_TURN_TOKEN_AUDIENCE, signChatToken, verifyChatToken } from '../src/domain/platform-chat/chat-token'
import {
  decryptContent,
  listVoiceTranscripts,
  readVoiceTranscript,
  recordVoiceTranscript,
  voiceTranscriptAllowed,
  type AiInteractionFilter,
  type AiInteractionRow,
} from '../src/domain/ai-audit/ai-audit-service'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'
import { canStartVoiceCall, readVoiceConfig, VOICE_TOKEN_TTL_SECONDS } from '../src/domain/voice/config'
import { buildLiveSessionRequest, createOpenAiLiveProvider, mapLiveFailure } from '../src/domain/voice/openai-live'
import { buildVoiceGreeting, buildVoiceInstructions } from '../src/domain/voice/prompt'
import type { VoiceBrowserSessionInput, VoiceProvider } from '../src/domain/voice/provider'
import { recordVoiceSessionEnd, startVoiceSession, type VoiceSessionDeps } from '../src/domain/voice/session'

const KEY = 'v'.repeat(40)
const USER = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-11-06T10:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)
const ENABLED = { enabled: true, voice: 'cedar', greeting: '' }

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n`, error)
  }
}

const sessionInput: VoiceBrowserSessionInput = {
  apiKey: 'sk-test',
  sdpOffer: 'v=0 offer',
  voice: 'cedar',
  voiceInstructions: 'beszéd',
  backendInstructions: 'háttér',
  greeting: 'Jó napot!',
  backendReasoningEffort: 'low',
  mcp: {
    serverUrl: 'https://app.example.com/api/mcp/acme',
    token: 'mcp-token',
    headers: { 'x-excellence-agent-id': AGENT },
    allowedTools: ['kb_search'],
  },
}

function principalDeps(): McpPrincipalDeps {
  return {
    verifyOAuthToken: async () => null,
    verifyChatToken: (t) => verifyChatToken(t, KEY, nowS),
    users: {
      findByExternalAuthId: async () => null,
      findById: async (id: string) => (id === USER ? ({ id: USER, status: 'active' } as never) : null),
    },
    tenants: {
      findBySlug: async (s: string) => (s === 'acme' ? ({ id: TENANT, slug: 'acme', status: 'active' } as never) : null),
      findById: async () => null,
    },
    memberships: { findByTenantAndUser: async () => ({ status: 'active', role: 'operator' }) as never },
    platformMemberships: { findByUser: async () => [] },
  }
}

function sessionDeps(over: Partial<VoiceSessionDeps> = {}) {
  const calls: VoiceBrowserSessionInput[] = []
  const audits: Array<{ action: string; metadata?: unknown }> = []
  const provider: VoiceProvider = {
    id: 'fake',
    model: 'fake-model',
    startBrowserSession: async (input) => {
      calls.push(input)
      return { ok: true, sessionId: 'live_1', sdpAnswer: 'v=0 answer' }
    },
  }
  const deps: VoiceSessionDeps = {
    signingKey: KEY,
    publicOrigin: 'https://app.example.com',
    agentHeaderName: 'x-excellence-agent-id',
    allowedTools: voiceAllowedToolAliases(),
    provider,
    loadTenantSlug: async () => 'acme',
    loadAgent: async () => ({ kind: 'internal', voiceConfig: ENABLED }),
    loadUsableDefinition: async () => ({ snapshot: { name: 'Réka', roleInstruction: 'Rendelést veszel fel.', rules: [{ text: 'Nem adsz kedvezményt.', source: 'hard' as const }] } }),
    loadApiKey: async () => 'sk-tenant',
    audit: { append: async (a) => void audits.push(a) },
    now: () => NOW,
    ...over,
  }
  return { deps, calls, audits }
}

const start = (deps: VoiceSessionDeps, body: unknown = { agentId: AGENT, sdp: 'v=0 offer' }) =>
  startVoiceSession(deps, { userId: USER, tenantId: TENANT, role: 'operator', body })

async function main() {
  await check('beállítás: hibás vagy hiányzó érték kikapcsolt állapot', () => {
    assert.equal(readVoiceConfig(null).enabled, false)
    assert.equal(readVoiceConfig({ enabled: true, voice: 'nincs-ilyen', greeting: '' }).enabled, false)
    assert.equal(readVoiceConfig(ENABLED).voice, 'cedar')
  })

  await check('gomb: csak belső, bekapcsolt, publikált, aktív munkatárson', () => {
    const base = { kind: 'internal', voiceConfig: ENABLED, status: 'active', currentDefinitionVersionId: 'v1' }
    assert.equal(canStartVoiceCall(base), true)
    assert.equal(canStartVoiceCall({ ...base, kind: 'public' }), false)
    assert.equal(canStartVoiceCall({ ...base, voiceConfig: { ...ENABLED, enabled: false } }), false)
    assert.equal(canStartVoiceCall({ ...base, status: 'paused' }), false)
    assert.equal(canStartVoiceCall({ ...base, currentDefinitionVersionId: null }), false)
  })

  await check('utasítás: a munkaköri leírás és a szabályok mindkét modellnek mennek; az AI-tájékoztatás nem hagyható el', () => {
    const built = buildVoiceInstructions({ name: 'Réka', roleInstruction: 'Rendelést veszel fel.', rules: [{ text: 'Nem adsz kedvezményt.', source: 'hard' }] })
    for (const text of [built.voice, built.backend]) {
      assert.match(text, /Rendelést veszel fel/)
      assert.match(text, /Nem adsz kedvezményt/)
    }
    assert.match(buildVoiceGreeting('Réka', ''), /Réka vagyok.*mesterséges intelligenciával/)
    assert.match(buildVoiceGreeting('Réka', 'Szia!'), /^Szia! .*mesterséges intelligenciával/)
  })

  await check('utasítás: mindkét modell megkapja a mai napot magyar idő szerint', () => {
    // UTC szerint még november 6., Budapesten már november 7., szombat.
    const built = buildVoiceInstructions({ name: 'Réka', roleInstruction: 'x', rules: [] }, new Date('2026-11-06T23:30:00Z'))
    for (const text of [built.voice, built.backend]) {
      assert.match(text, /Most: 2026\. november 7\., szombat/)
      assert.match(text, /szombat 0:30/)
    }
  })

  await check('átirat: a lezáró kérésbe csak annyi fér, amennyit a böngésző elküld, a legfrissebb sorok maradnak', () => {
    const lines = Array.from({ length: 200 }, (_, index) => ({ role: 'user' as const, text: `${index} ${'ő'.repeat(400)}` }))
    const report = voiceEndReport({ ...INITIAL_VOICE_CALL_VIEW, lines })
    assert.equal(report.transcriptTruncated, true)
    assert.ok(new TextEncoder().encode(JSON.stringify(report)).length < 60_000)
    assert.equal(report.transcript.at(-1)?.text, lines.at(-1)?.text)
  })

  await check('átirat: titkosítva az AI-naplóba kerül, a naplózási mélység szerint, és a tartalom nem megy az audit-sorba', async () => {
    const rows: AiInteractionRow[] = []
    const store = { insertMany: async (next: AiInteractionRow[]) => (rows.push(...next), next.length) } as never
    const input = { tenantId: TENANT, userId: USER, agentId: AGENT, sessionId: 'live_1', lines: [{ role: 'user', text: 'Kiss Anna vagyok' }], meta: { seconds: 5 } }
    await recordVoiceTranscript({ store, depthFor: async () => 'prompt_and_response', now: () => NOW, retentionDays: () => 90 }, input)
    assert.equal(rows[0].kind, 'voice_transcript')
    assert.equal(rows[0].source, 'voice')
    assert.equal(rows[0].sessionId, 'live_1')
    assert.equal(rows[0].expiresAt.getTime(), NOW.getTime() + 90 * 86_400_000)
    assert.equal(rows[0].content?.includes('Kiss Anna'), false)
    assert.deepEqual(JSON.parse(decryptContent(TENANT, rows[0].content as string)), { lines: input.lines })
    await recordVoiceTranscript({ store, depthFor: async () => 'metadata', now: () => NOW, retentionDays: () => 90 }, input)
    assert.equal(rows[1].content, null)
    assert.equal(rows[1].meta.lineCount, 1)
    assert.equal(voiceTranscriptAllowed('metadata'), false)
    assert.equal(voiceTranscriptAllowed('prompt_and_response'), true)
  })

  await check('átirat-olvasó: csak ennek a munkatársnak a hang-átiratát adja, más naplósort nem', async () => {
    const rows: AiInteractionRow[] = []
    const store = {
      insertMany: async (next: AiInteractionRow[]) => (rows.push(...next), next.length),
      list: async (f: AiInteractionFilter) =>
        rows.filter(
          (r) => r.tenantId === f.tenantId && r.agentId === f.agentId && r.kind === f.kind && (f.id === undefined || r.id === f.id),
        ),
    } as never
    const deps = { store, depthFor: async () => 'prompt_and_response' as const, now: () => NOW, retentionDays: () => 90 }
    await recordVoiceTranscript(deps, { tenantId: TENANT, userId: USER, agentId: AGENT, sessionId: 'live_1', lines: [{ role: 'user', text: 'Kiss Anna' }], meta: { seconds: 5 } })
    const [summary] = await listVoiceTranscripts(store, { tenantId: TENANT, agentId: AGENT })
    assert.equal(summary.hasContent, true)
    assert.equal(JSON.stringify(summary).includes('Kiss Anna'), false)
    assert.deepEqual(await readVoiceTranscript(store, { tenantId: TENANT, agentId: AGENT, id: summary.id }), { sessionId: 'live_1', lines: [{ role: 'user', text: 'Kiss Anna' }] })
    assert.equal(await readVoiceTranscript(store, { tenantId: TENANT, agentId: USER, id: summary.id }), null)
    rows[0].kind = 'model_call'
    assert.equal(await readVoiceTranscript(store, { tenantId: TENANT, agentId: AGENT, id: summary.id }), null)
    assert.deepEqual(await listVoiceTranscripts(store, { tenantId: TENANT, agentId: AGENT }), [])
  })

  await check('lezárás: az átirat érvényes jelentésnél mentődik, a hibája vagy a hibás formája nem bukhat el', async () => {
    const audits: Array<{ metadata?: unknown }> = []
    const saved: Array<{ lines: unknown[]; meta: Record<string, unknown> }> = []
    const base = { audit: { append: async (a: { metadata?: unknown }) => void audits.push(a) }, sessionAwaitsEnd: async () => true }
    const end = (deps: object, body: object) =>
      recordVoiceSessionEnd({ ...base, ...deps } as never, { userId: USER, tenantId: TENANT, body: { agentId: AGENT, sessionId: 'live_1', ...body } })
    const recordTranscript = async (row: { lines: unknown[]; meta: Record<string, unknown> }) => void saved.push(row)
    const transcript = [{ role: 'user', text: 'Kiss Anna vagyok', atSeconds: 3 }]
    assert.deepEqual(await end({ recordTranscript }, { transcript, backendWaitsMs: [1200.4], transcriptTruncated: true }), { ok: true })
    assert.deepEqual(saved[0].lines, transcript)
    assert.deepEqual(saved[0].meta.backendWaitsMs, [1200])
    assert.equal(saved[0].meta.truncated, true)
    assert.equal(JSON.stringify(audits).includes('Kiss Anna'), false)
    assert.deepEqual(await end({ recordTranscript }, { transcript: [{ role: 'admin', text: 'x' }] }), { ok: true })
    assert.deepEqual(await end({ recordTranscript }, { transcript: Array(301).fill(transcript[0]) }), { ok: true })
    assert.equal(saved.length, 1)
    const failing = async () => { throw new Error('nem érhető el') }
    assert.deepEqual(await end({ recordTranscript: failing }, { transcript }), { ok: true })
  })

  await check('első mondat: a rögzítésről csak akkor szól, ha az átirat tényleg a naplóba kerül; hibánál inkább szól', async () => {
    assert.equal(buildVoiceGreeting('Réka', '').includes('minőségbiztosítási'), false)
    assert.match(buildVoiceGreeting('Réka', '', true), /mesterséges intelligenciával beszél\. A beszélgetés szövegét minőségbiztosítási céllal rögzítjük\.$/)
    const on = sessionDeps({ transcriptRecorded: async () => true })
    assert.ok((await start(on.deps)).ok)
    assert.match(on.calls[0].greeting, /minőségbiztosítási/)
    const off = sessionDeps({ transcriptRecorded: async () => false })
    assert.ok((await start(off.deps)).ok)
    assert.equal(off.calls[0].greeting.includes('minőségbiztosítási'), false)
    const broken = sessionDeps({ transcriptRecorded: async () => { throw new Error('nem érhető el') } })
    assert.ok((await start(broken.deps)).ok)
    assert.match(broken.calls[0].greeting, /minőségbiztosítási/)
  })

  await check('hang-szabály: visszahívást csak a munkaköri leírás engedélyével ígérhet', () => {
    assert.match(buildVoiceInstructions({ name: 'Réka', roleInstruction: 'x', rules: [] }).voice, /csak akkor ígérj, ha a munkaköri leírásod kifejezetten megengedi/)
  })

  await check('OpenAI-kérés: MCP a háttérmodellnél, a böngésző nem írhatja át a beállításokat', () => {
    const body = buildLiveSessionRequest(sessionInput)
    assert.equal(body.session.model, 'gpt-live-1')
    assert.deepEqual(body.session.delegation.responses.reasoning, { effort: 'low' })
    assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'v=0 offer' })
    assert.equal(body.session.audio.output.voice, 'cedar')
    assert.equal('format' in body.session.audio, false)
    assert.deepEqual(body.session.client.data_channel.allowed_client_events, ['session.close', 'session.commentary.append'])
    const [tool] = body.session.delegation.responses.tools
    assert.equal(tool.type, 'mcp')
    assert.equal(tool.authorization, 'mcp-token')
    assert.equal(tool.require_approval, 'never')
    assert.deepEqual(tool.allowed_tools, ['kb_search'])
    assert.deepEqual(tool.headers, { 'x-excellence-agent-id': AGENT })
  })

  await check('OpenAI-válasz: siker, hibák érthető kódra, hiányos válasz nem siker', async () => {
    const respond = (status: number, body: unknown) =>
      createOpenAiLiveProvider({ fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch }).startBrowserSession(sessionInput)
    assert.deepEqual(await respond(201, { session: { id: 'live_9' }, transport: { type: 'webrtc', sdp: 'v=0 a' } }), { ok: true, sessionId: 'live_9', sdpAnswer: 'v=0 a' })
    assert.deepEqual(await respond(401, { error: { code: 'invalid_api_key' } }), { ok: false, code: 'provider_key_rejected' })
    assert.deepEqual(await respond(403, {}), { ok: false, code: 'provider_no_access' })
    assert.deepEqual(await respond(429, {}), { ok: false, code: 'provider_quota' })
    assert.deepEqual(await respond(500, {}), { ok: false, code: 'provider_error' })
    assert.deepEqual(await respond(201, { session: { id: 'x' } }), { ok: false, code: 'provider_error' })
    assert.equal(mapLiveFailure(400, 'model_not_found'), 'provider_no_access')
    const thrown = createOpenAiLiveProvider({ fetchImpl: (async () => { throw new Error('net') }) as typeof fetch })
    assert.deepEqual(await thrown.startBrowserSession(sessionInput), { ok: false, code: 'provider_error' })
  })

  await check('indítás: a háttérmodell gondolkodási mélysége a munkatárs beállítása, beállítás nélkül a gyors', async () => {
    const plain = sessionDeps()
    assert.ok((await start(plain.deps)).ok)
    assert.equal(plain.calls[0].backendReasoningEffort, 'low')
    const modelConfig = { provider: 'openrouter', model: 'vendor/model', reasoningEffort: 'high', fallbackModels: [] }
    const set = sessionDeps({ loadAgent: async () => ({ kind: 'internal', voiceConfig: ENABLED, modelConfig }) })
    assert.ok((await start(set.deps)).ok)
    assert.equal(set.calls[0].backendReasoningEffort, 'high')
  })

  await check('indítás: a kulcs és a token nem kerül a böngészőnek szánt válaszba, a token szűk', async () => {
    const { deps, calls, audits } = sessionDeps()
    const result = await start(deps)
    assert.ok(result.ok)
    const visible = JSON.stringify(result)
    assert.equal(visible.includes('sk-tenant'), false)
    assert.equal(visible.includes(calls[0].mcp.token), false)
    assert.equal(calls[0].apiKey, 'sk-tenant')
    assert.equal(calls[0].voice, 'cedar')
    assert.equal(calls[0].mcp.serverUrl, 'https://app.example.com/api/mcp/acme')
    assert.deepEqual(calls[0].mcp.headers, { 'x-excellence-agent-id': AGENT })
    assert.deepEqual(calls[0].mcp.allowedTools, voiceAllowedToolAliases())
    const claims = verifyChatToken(calls[0].mcp.token, KEY, nowS)
    assert.ok(claims)
    assert.equal(claims.aud, CHAT_TURN_TOKEN_AUDIENCE)
    assert.equal(claims.voice, true)
    assert.equal(claims.agentId, AGENT)
    assert.equal(claims.adminInsight, false)
    assert.equal(claims.exp - claims.iat, VOICE_TOKEN_TTL_SECONDS)
    assert.equal(verifyChatToken(calls[0].mcp.token, KEY, nowS + VOICE_TOKEN_TTL_SECONDS + 1), null)
    assert.equal(audits[0].action, 'voice.session_started')
    assert.equal((audits[0].metadata as { sessionId: string }).sessionId, 'live_1')
    assertAuditMetadataSafe(audits[0].metadata)
  })

  await check('indítás: kapuk', async () => {
    const code = async (over: Partial<VoiceSessionDeps>, body?: unknown) => {
      const { deps, calls } = sessionDeps(over)
      const result = await start(deps, body ?? { agentId: AGENT, sdp: 'v=0 offer' })
      assert.equal(result.ok, false)
      assert.equal(calls.length, 0, 'a szolgáltató nem hívható')
      return result.ok ? null : result.code
    }
    assert.equal(await code({ signingKey: undefined }), 'not_configured')
    assert.equal(await code({}, { agentId: 'nem-uuid', sdp: 'v=0' }), 'bad_request')
    assert.equal(await code({}, { agentId: AGENT, sdp: 'nem sdp' }), 'bad_request')
    assert.equal(await code({}, { agentId: AGENT, sdp: `v=0${'x'.repeat(70_000)}` }), 'bad_request')
    assert.equal(await code({ loadAgent: async () => null }), 'agent_unavailable')
    assert.equal(await code({ loadAgent: async () => ({ kind: 'public', voiceConfig: ENABLED }) }), 'agent_unavailable')
    assert.equal(await code({ loadAgent: async () => ({ kind: 'internal', voiceConfig: null }) }), 'voice_disabled')
    assert.equal(await code({ loadUsableDefinition: async () => null }), 'agent_unavailable')
    assert.equal(await code({ loadApiKey: async () => null }), 'key_missing')
  })

  await check('indítás: szolgáltatói hiba eljut a felületig, audit nem készül', async () => {
    const { deps, audits } = sessionDeps()
    deps.provider = { id: 'x', model: 'x', startBrowserSession: async () => ({ ok: false, code: 'provider_no_access' }) }
    assert.deepEqual(await start(deps), { ok: false, code: 'provider_no_access' })
    assert.equal(audits.length, 0)
    assert.match(voiceFailureMessage('provider_no_access'), /hangmodell/)
    assert.match(voiceFailureMessage('ismeretlen'), /próbáld újra/i)
  })

  await check('felület: hétköznapi eszköznév, teendő a hibáknál, a lezárás oka érthető', () => {
    const toolLine = (name: string, error?: string) =>
      applyVoiceEvent(INITIAL_VOICE_CALL_VIEW, { type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'mcp_call', name, error } } }, 0).lines[0].text
    assert.equal(toolLine('kb_search'), 'A munkatárs keresett a tudásbázisban.')
    for (const alias of voiceAllowedToolAliases()) assert.doesNotMatch(toolLine(alias), /__|platform|kb_|használt egy eszközt/, alias)
    assert.match(toolLine('platform__work_file__append', 'denied'), /hozzáírt egy munkafájlhoz\. Ez nem sikerült\./)
    assert.match(voiceProviderErrorMessage('responses_validation_failed'), /Próbáld újra.*rendszergazdának: responses_validation_failed/)
    assert.match(voiceEndedMessage('close_requested', true), /időkorlát/)
    assert.match(voiceEndedMessage('expired', false), /időkorlát/)
    assert.match(voiceEndedMessage('connection_lost', false), /hálózatot/)
    assert.equal(voiceEndedMessage(null, false), 'A beszélgetés véget ért.')
    for (const code of ['no_tenant_access', 'agent_unavailable', 'voice_disabled', 'key_missing']) {
      assert.match(voiceFailureMessage(code), /szólj|Kérj|kérd|adhatja meg/i, code)
    }
    assert.match(voiceFailureMessage('key_missing'), /Céges modellkulcsok/)
  })

  await check('utasítás: a szabály a leírás elé kerül, hosszú leírásnál sem esik ki; nincs teljesíthetetlen ígéret', () => {
    const built = buildVoiceInstructions({ name: 'Réka', roleInstruction: 'x'.repeat(30_000), rules: [{ text: 'KÖTELEZŐ SZABÁLY', source: 'hard' }] })
    assert.ok(built.voice.indexOf('KÖTELEZŐ SZABÁLY') < built.voice.indexOf('xxx'))
    assert.ok(built.voice.length < 10_000)
    assert.doesNotMatch(built.voice, /telefon|visszahív[^á]/i)
    assert.doesNotMatch(built.backend, /telefon/i)
    assert.doesNotMatch(VOICE_TOOL_BLOCKED_MESSAGE, /kolléga/)
  })

  await check('lezárás: a böngésző adata korlátozott, hibás kérés nem naplózódik', async () => {
    const audits: Array<{ action: string; metadata?: unknown }> = []
    const asked: unknown[] = []
    const deps = {
      audit: { append: async (a: { action: string; metadata?: unknown }) => void audits.push(a) },
      sessionAwaitsEnd: async (input: { sessionId: string }) => {
        asked.push(input)
        return input.sessionId === 'live_1'
      },
    }
    assert.deepEqual(await recordVoiceSessionEnd(deps as never, { userId: USER, tenantId: TENANT, body: { agentId: 'x', sessionId: 'live_1' } }), { ok: false })
    assert.deepEqual(await recordVoiceSessionEnd(deps as never, { userId: USER, tenantId: TENANT, body: { agentId: AGENT, sessionId: '<script>' } }), { ok: false })
    // Kitalált vagy már lezárt beszélgetéshez nem kerülhet sor az audit-láncba.
    assert.deepEqual(await recordVoiceSessionEnd(deps as never, { userId: USER, tenantId: TENANT, body: { agentId: AGENT, sessionId: 'live_other' } }), { ok: false })
    assert.deepEqual(asked, [{ tenantId: TENANT, userId: USER, agentId: AGENT, sessionId: 'live_other' }])
    assert.equal(audits.length, 0)
    const ended = await recordVoiceSessionEnd(deps as never, {
      userId: USER,
      tenantId: TENANT,
      body: { agentId: AGENT, sessionId: 'live_1', reason: 'close_requested', seconds: 61.4, maxBackendWaitMs: -5, extra: 'x' },
    })
    assert.deepEqual(ended, { ok: true })
    const meta = audits[0].metadata as Record<string, unknown>
    assert.equal(meta.reportedBy, 'browser')
    assert.equal(meta.seconds, 61)
    assert.equal(meta.closeReason, 'close_requested')
    // A valódi audit-tároló visszadobja a tiltott kulcsokat, ezért a tesztben is ugyanaz az ellenőrzés fut.
    assertAuditMetadataSafe(meta)
    assert.equal(meta.maxBackendWaitMs, null)
    assert.equal('extra' in meta, false)
  })

  await check('engedélylista: csak létező eszközök; nincs köztük levél, kapcsolat vagy publikálás; alias oda-vissza', () => {
    for (const alias of voiceAllowedToolAliases()) {
      assert.match(alias, /^[a-zA-Z0-9_-]+$/)
      assert.ok((MCP_ALLOWED_TOOLS as readonly string[]).includes(toolNameFromVoiceAlias(alias)), alias)
    }
    assert.equal(voiceToolAlias('platform.work_file.append'), 'platform__work_file__append')
    assert.equal(voiceBlocksTool({ voiceCall: true }, 'kb_get_document', { documentId: 'x', section: 'Dió torta' }), false)
    assert.equal(voiceBlocksTool({ voiceCall: true }, 'kb_get_document', { documentId: 'x', claimForWiki: true }), true)
    assert.equal(voiceBlocksTool({ voiceCall: true }, 'kb_get_document', { documentId: 'x', claimForWiki: false }), true)
    assert.equal(voiceBlocksTool({}, 'kb_get_document', { documentId: 'x', claimForWiki: true }), false)
    assert.equal(toolNameFromVoiceAlias('platform__work_file__append'), 'platform.work_file.append')
    const voice = { voiceCall: true as const }
    for (const blocked of ['mail_send', 'http_api_request', 'sandbox_run', 'mcp_call', 'platform.agent.publish', 'platform.work_file.delete', 'platform.work_file.write', 'új_eszköz']) {
      assert.equal(voiceBlocksTool(voice, blocked), true, blocked)
    }
    assert.equal(voiceBlocksTool(voice, 'kb_search'), false)
    assert.equal(voiceBlocksTool({}, 'mail_send'), false)
  })

  await check('engedélylista: a listán kívüli eszköz fel sem kerül a szerverre', () => {
    const registered: string[] = []
    const server = { registerTool: (name: string) => void registered.push(name) }
    limitServerToVoiceTools(server as never)
    server.registerTool('mail_send')
    server.registerTool('kb_search')
    server.registerTool('platform.work_file.append')
    assert.deepEqual(registered, ['kb_search', 'platform__work_file__append'])
  })

  const voiceToken = () =>
    signChatToken(
      { aud: CHAT_TURN_TOKEN_AUDIENCE, sub: USER, tenant: 'acme', tid: TENANT, role: 'operator', adminInsight: false, turnId: 'voice-1', agentId: AGENT, voice: true },
      KEY,
      NOW,
      VOICE_TOKEN_TTL_SECONDS,
    ).token

  await check('principal: a hang-token nem interaktív, az agentjéhez kötött, de nem kötelező jóváhagyású', async () => {
    const r = await resolveMcpPrincipal(
      { authorizationHeader: `Bearer ${voiceToken()}`, tenantSlug: 'acme', resourceOrigin: 'https://app.example.com' },
      principalDeps(),
    )
    assert.ok(r.ok)
    assert.equal(r.principal.voiceCall, true)
    assert.equal(r.principal.background, true)
    assert.equal(r.principal.boundAgentId, AGENT)
    assert.equal(r.principal.forceWriteApproval, undefined)
  })

  await check('principal: böngésző-tokenben a voice jelölés nem ad hang-módot, és más szervezetnél érvénytelen', async () => {
    const browser = signChatToken(
      { aud: CHAT_TOKEN_AUDIENCE, sub: USER, tenant: 'acme', tid: TENANT, role: 'operator', adminInsight: false, voice: true },
      KEY,
      NOW,
    ).token
    const r = await resolveMcpPrincipal({ authorizationHeader: `Bearer ${browser}`, tenantSlug: 'acme', resourceOrigin: 'https://app.example.com' }, principalDeps())
    assert.ok(r.ok && !r.principal.voiceCall)
    const other = await resolveMcpPrincipal({ authorizationHeader: `Bearer ${voiceToken()}`, tenantSlug: 'masik', resourceOrigin: 'https://app.example.com' }, principalDeps())
    assert.equal(other.ok, false)
  })

  await check('Model Gateway: hang-tokennel nem kérhető gateway-token', async () => {
    const result = await issueGatewayToken(
      {
        ...principalDeps(),
        signingKey: 'g'.repeat(40),
        now: () => NOW,
        loadDefinition: async ({ agentId }) => ({ agentId, status: 'active' }) as never,
        canViewAgent: async () => true,
        policyVersion: async () => 'pv1',
        listAgentIds: async () => [AGENT],
        platformChat: { loadAccess: async () => ({ tenantEnabled: true, agentEnabled: true, dailyBudgetUsd: 10 }), registerSession: async () => undefined },
      },
      {
        authorizationHeader: `Bearer ${voiceToken()}`,
        resourceOrigin: 'https://app.example.com',
        body: { tenantSlug: 'acme', agentId: AGENT, installId: PLATFORM_CHAT_INSTALL_ID, sessionId: 'v1' },
      },
    )
    assert.deepEqual(result, { ok: false, code: 'forbidden' })
  })

  await check('átirat: szereplőnként összefűz, eszközhívást és várakozást mér, hibát megmutat', () => {
    const run = (events: Array<[unknown, number]>): VoiceCallView =>
      events.reduce((view, [event, at]) => applyVoiceEvent(view, event, at), INITIAL_VOICE_CALL_VIEW)
    const view = run([
      [{ type: 'session.started' }, 0],
      [{ type: 'session.output_transcript.delta', delta: 'Jó ' }, 10],
      [{ type: 'session.output_transcript.delta', delta: 'napot.' }, 20],
      [{ type: 'session.input_transcript.delta', delta: 'Két láda bort.' }, 30],
      [{ type: 'session.delegation.created', target: 'responses' }, 1000],
      [{ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'mcp_call', name: 'platform__work_file__append' } } }, 2000],
      [{ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'message' } } }, 2100],
      [{ type: 'response.event', event: { type: 'response.completed' } }, 3500],
      [{ type: 'session.usage.updated', usage: { seconds: 42 } }, 3600],
      [{ type: 'error', error: { code: 'responses_validation_failed', message: 'Hibás eszköz' } }, 3700],
      [{ type: 'ismeretlen' }, 3800],
      ['nem objektum', 3900],
      [{ type: 'session.closed', reason: 'close_requested', usage: { seconds: 45 } }, 4000],
    ])
    assert.deepEqual(view.lines, [
      { role: 'assistant', text: 'Jó napot.', atSeconds: 0 },
      { role: 'user', text: 'Két láda bort.', atSeconds: 0 },
      { role: 'tool', text: 'A munkatárs hozzáírt egy munkafájlhoz.', atSeconds: 2 },
    ])
    assert.deepEqual(view.backendWaitsMs, [2500])
    const report = voiceEndReport(view)
    assert.deepEqual(report.transcript, view.lines)
    assert.equal(report.transcriptTruncated, false)
    assert.equal(view.lastBackendWaitMs, 2500)
    assert.equal(view.backendSince, null)
    assert.equal(view.providerError, 'Hibás eszköz')
    assert.equal(view.closedReason, 'close_requested')
    assert.deepEqual(voiceEndReport(view), {
      transcript: view.lines,
      transcriptTruncated: false,
      backendWaitsMs: [2500], reason: 'close_requested', seconds: 45, backendCalls: 1, avgBackendWaitMs: 2500, maxBackendWaitMs: 2500 })
    assert.equal(voiceEndReport(INITIAL_VOICE_CALL_VIEW).avgBackendWaitMs, null)
  })

  console.log(`\n${failures === 0 ? 'voice-pilot: ok' : `voice-pilot: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
