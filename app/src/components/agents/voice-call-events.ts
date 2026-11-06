/** #1111: a hangszolgáltató adatcsatorna-eseményeiből készül az átirat és a várakozási mérés. */
export type VoiceTranscriptLine = { role: 'user' | 'assistant' | 'tool'; text: string; atSeconds?: number }

export type VoiceCallView = {
  lines: VoiceTranscriptLine[]
  started: boolean
  startedAtMs: number | null
  seconds: number
  closedReason: string | null
  /** Utolsó nem végzetes szolgáltatói hibaüzenet, például ha az eszközök beállítása nem érvényes. */
  providerError: string | null
  backendSince: number | null
  backendCalls: number
  lastBackendWaitMs: number | null
  maxBackendWaitMs: number
  totalBackendWaitMs: number
  completedBackendCalls: number
  backendWaitsMs: number[]
}

const MAX_LINES = 300
const MAX_REPORTED_WAITS = 100
/** A `keepalive` kérés törzse legfeljebb 64 KB lehet, és a mérések is ebben mennek. */
const MAX_REPORTED_TRANSCRIPT_BYTES = 48_000

export const INITIAL_VOICE_CALL_VIEW: VoiceCallView = {
  lines: [],
  started: false,
  startedAtMs: null,
  seconds: 0,
  closedReason: null,
  providerError: null,
  backendSince: null,
  backendCalls: 0,
  lastBackendWaitMs: null,
  maxBackendWaitMs: 0,
  totalBackendWaitMs: 0,
  completedBackendCalls: 0,
  backendWaitsMs: [],
}

/** Az átiratban a hang-engedélylista eszközei, hétköznapi szöveggel (a hang közben használt alias néven). */
const TOOL_LABELS: Record<string, string> = {
  kb_search: 'A munkatárs keresett a tudásbázisban.',
  kb_list_index: 'A munkatárs megnézte a tudásbázis tartalomjegyzékét.',
  kb_get_page: 'A munkatárs elolvasott egy tudásbázis-oldalt.',
  platform__project_memory__read: 'A munkatárs megnézte a memóriáját.',
  platform__work_file__list: 'A munkatárs megnézte a munkafájlokat.',
  platform__work_file__read: 'A munkatárs elolvasott egy munkafájlt.',
  platform__work_file__append: 'A munkatárs hozzáírt egy munkafájlhoz.',
}

function elapsedSeconds(view: VoiceCallView, nowMs: number): { atSeconds?: number } {
  return view.startedAtMs === null ? {} : { atSeconds: Math.max(0, Math.round((nowMs - view.startedAtMs) / 1000)) }
}

function appendText(view: VoiceCallView, role: 'user' | 'assistant', delta: string, nowMs: number): VoiceTranscriptLine[] {
  const last = view.lines.at(-1)
  if (last?.role === role) return [...view.lines.slice(0, -1), { ...last, text: last.text + delta }]
  return [...view.lines, { role, text: delta, ...elapsedSeconds(view, nowMs) }].slice(-MAX_LINES)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function usageSeconds(event: Record<string, unknown>): number | null {
  const seconds = asRecord(event.usage)?.seconds
  return typeof seconds === 'number' ? seconds : null
}

function applyBackendEvent(view: VoiceCallView, nested: Record<string, unknown>, nowMs: number): VoiceCallView {
  if (nested.type === 'response.output_item.done') {
    const item = asRecord(nested.item)
    if (item?.type !== 'mcp_call' || typeof item.name !== 'string') return view
    const failed = item.error ? ' Ez nem sikerült.' : ''
    const line: VoiceTranscriptLine = {
      role: 'tool',
      text: `${TOOL_LABELS[item.name] ?? 'A munkatárs használt egy eszközt.'}${failed}`,
      ...elapsedSeconds(view, nowMs),
    }
    return { ...view, lines: [...view.lines, line].slice(-MAX_LINES) }
  }
  if (nested.type === 'response.completed' && view.backendSince !== null) {
    const waited = Math.max(0, nowMs - view.backendSince)
    return {
      ...view,
      backendSince: null,
      lastBackendWaitMs: waited,
      maxBackendWaitMs: Math.max(view.maxBackendWaitMs, waited),
      totalBackendWaitMs: view.totalBackendWaitMs + waited,
      completedBackendCalls: view.completedBackendCalls + 1,
      backendWaitsMs: [...view.backendWaitsMs, waited].slice(-MAX_REPORTED_WAITS),
    }
  }
  return view
}

export function applyVoiceEvent(view: VoiceCallView, event: unknown, nowMs: number): VoiceCallView {
  const e = asRecord(event)
  if (!e) return view
  switch (e.type) {
    case 'session.started':
      return { ...view, started: true, startedAtMs: view.startedAtMs ?? nowMs }
    case 'session.input_transcript.delta':
      return typeof e.delta === 'string' ? { ...view, lines: appendText(view, 'user', e.delta, nowMs) } : view
    case 'session.output_transcript.delta':
      return typeof e.delta === 'string' ? { ...view, lines: appendText(view, 'assistant', e.delta, nowMs) } : view
    case 'session.delegation.created':
      return { ...view, backendCalls: view.backendCalls + 1, backendSince: view.backendSince ?? nowMs }
    case 'response.event': {
      const nested = asRecord(e.event)
      return nested ? applyBackendEvent(view, nested, nowMs) : view
    }
    case 'session.usage.updated':
      return { ...view, seconds: usageSeconds(e) ?? view.seconds }
    case 'session.closed':
      return { ...view, closedReason: typeof e.reason === 'string' ? e.reason : 'unknown', seconds: usageSeconds(e) ?? view.seconds }
    case 'error': {
      const error = asRecord(e.error)
      const text = typeof error?.message === 'string' ? error.message : typeof error?.code === 'string' ? error.code : 'ismeretlen hiba'
      return { ...view, providerError: text.slice(0, 300) }
    }
    default:
      return view
  }
}

/** A legfrissebb sorok maradnak meg, ha az átirat nem férne bele a lezáró kérésbe. */
function reportableLines(lines: VoiceTranscriptLine[]): VoiceTranscriptLine[] {
  const encoder = new TextEncoder()
  const kept: VoiceTranscriptLine[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    bytes += encoder.encode(JSON.stringify(lines[index])).length + 1
    if (bytes > MAX_REPORTED_TRANSCRIPT_BYTES) break
    kept.unshift(lines[index])
  }
  return kept
}

export function voiceEndReport(view: VoiceCallView) {
  const transcript = reportableLines(view.lines)
  return {
    transcript,
    transcriptTruncated: transcript.length < view.lines.length,
    backendWaitsMs: view.backendWaitsMs,
    reason: view.closedReason,
    seconds: view.seconds,
    backendCalls: view.backendCalls,
    avgBackendWaitMs: view.completedBackendCalls > 0 ? view.totalBackendWaitMs / view.completedBackendCalls : null,
    maxBackendWaitMs: view.completedBackendCalls > 0 ? view.maxBackendWaitMs : null,
  }
}

/** A munkamenet közbeni szolgáltatói hiba szövege angol és technikai, ezért a teendő kerül elé. */
export function voiceProviderErrorMessage(detail: string): string {
  return `Az OpenAI hibát jelzett, ezért a munkatárs lehet, hogy nem éri el az adatokat. Próbáld újra, és ha ismétlődik, küldd el ezt a szöveget a rendszergazdának: ${detail}`
}

export function voiceEndedMessage(closedReason: string | null, limitReached: boolean): string {
  if (limitReached || closedReason === 'expired') return 'A beszélgetés véget ért, mert elérte az időkorlátot. Ha kell, indíts újat.'
  if (closedReason === 'content') return 'Az OpenAI tartalmi szűrője lezárta a beszélgetést. Ha kell, indíts újat.'
  if (closedReason === 'connection_lost') return 'Megszakadt a kapcsolat. Ellenőrizd a hálózatot, és indíts új beszélgetést.'
  return 'A beszélgetés véget ért.'
}

const FAILURE_MESSAGES: Record<string, string> = {
  bad_request: 'A beszélgetést nem sikerült elindítani. Frissítsd az oldalt, és próbáld újra.',
  bad_origin: 'A kérés nem erről az oldalról érkezett. Frissítsd az oldalt, és próbáld újra.',
  unauthenticated: 'Lejárt a belépésed. Lépj be újra, és próbáld újra.',
  no_tenant_access: 'Ehhez a szervezethez most nincs hozzáférésed, vagy a szervezet nem aktív. Válts szervezetet, vagy szólj egy adminisztrátornak.',
  agent_unavailable: 'Ez a munkatárs most nem érhető el neked: nincs publikálva, vagy nincs hozzá jogosultságod. Kérj hozzáférést egy adminisztrátortól.',
  voice_disabled: 'Ennél a munkatársnál közben kikapcsolták a hang-beszélgetést. Frissítsd az oldalt, és ha újra kell, kérd egy platform-adminisztrátortól.',
  key_missing: 'Nincs céges OpenAI-kulcs. A kulcsot egy adminisztrátor adhatja meg a Beállítások → Céges modellkulcsok oldalon.',
  not_configured: 'A platformon hiányzik a hang-beszélgetés beállítása. Szólj a rendszergazdának.',
  provider_key_rejected: 'Az OpenAI nem fogadta el a céges kulcsot. Ellenőrizd a kulcsot a Beállítások → Céges modellkulcsok oldalon.',
  provider_no_access: 'Ez az OpenAI-projekt nem éri el a hangmodellt. Ellenőrizd az OpenAI-fiók jogosultságát.',
  provider_quota: 'Az OpenAI-fiókban elfogyott a keret, vagy túl sok a kérés. Ellenőrizd az egyenleget, majd próbáld újra később.',
  provider_error: 'Az OpenAI most nem indította el a beszélgetést. Próbáld újra pár perc múlva.',
}

export function voiceFailureMessage(code: string): string {
  return FAILURE_MESSAGES[code] ?? 'A beszélgetést nem sikerült elindítani. Próbáld újra pár perc múlva.'
}

export function microphoneFailureMessage(errorName: string): string {
  return errorName === 'NotAllowedError'
    ? 'A böngésző nem kapott engedélyt a mikrofonra. Engedélyezd a címsorban, majd próbáld újra.'
    : 'Nem sikerült elérni a mikrofont. Ellenőrizd, hogy csatlakoztatva van-e, és más program nem használja-e.'
}
