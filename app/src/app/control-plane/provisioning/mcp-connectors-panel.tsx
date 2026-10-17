'use client'

import { useCallback, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  approveMcpTools,
  archiveMcpConnector,
  createMcpConnector,
  listMcpConnectors,
  syncMcpConnector,
  tryMcpTool,
} from '@/app/actions/mcp-connectors'
import { startConnectorOAuth } from '@/app/actions/connector-grants'

type Risk = 'read' | 'write' | 'danger'
type ToolRow = {
  name: string
  description: string
  inputSchema: unknown
  risk: Risk
  approved: boolean
  suggestedRisk: Risk
  writeLikeName: boolean
}
type Diff = { added: string[]; removed: string[]; schemaChanged: string[]; descriptionChanged: string[] }
export type McpConnectorsData = { allowedHosts: string[]; connectors: ConnectorRow[] }

type ConnectorRow = {
  id: string
  name: string
  serverUrl: string
  authMode: string
  domainAllowed: boolean
  hasOwnGrant: boolean
  usedByAgents: string[]
  active: { versionId: string | null; tools: ToolRow[] } | null
  proposed: { versionId: string; versionNo: number; tools: ToolRow[]; diff: Diff | null } | null
}

const RISK_LABEL: Record<Risk, string> = {
  read: 'Olvasó — azonnal fut',
  write: 'Író — jóváhagyást kérhet',
  danger: 'Veszélyes — mindig jóváhagyás',
}

const input = 'w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm'
const button = 'rounded-lg border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-50'
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50'

function Message({ value }: { value: { tone: 'ok' | 'err'; text: string } | null }) {
  if (!value) return null
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-sm ${
        value.tone === 'ok'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
          : 'border-coral/35 bg-coral/10 text-coral-deep'
      }`}
    >
      {value.text}
    </p>
  )
}

function diffText(diff: Diff | null): string | null {
  if (!diff) return null
  const parts = [
    diff.added.length ? `${diff.added.length} új eszközt adott hozzá` : '',
    diff.removed.length ? `${diff.removed.length} eszközt megszüntetett` : '',
    diff.schemaChanged.length ? `${diff.schemaChanged.length} eszköz paramétereit módosította` : '',
    diff.descriptionChanged.length ? `${diff.descriptionChanged.length} leírást módosított` : '',
  ].filter(Boolean)
  return parts.length ? `A szolgáltató ${parts.join(', ')} — nézd át.` : null
}

/** Eszköztábla: pipa, név, teljes leírás, paraméterek, kockázat, kipróbálás (§6/2–3). */
function ToolReview({
  connectorId,
  versionId,
  tools,
  isActive,
  onDone,
}: {
  connectorId: string
  versionId: string
  tools: ToolRow[]
  isActive: boolean
  onDone: (text: string) => void
}) {
  const [rows, setRows] = useState(tools)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [tryArgs, setTryArgs] = useState<Record<string, string>>({})
  const [tryResult, setTryResult] = useState<Record<string, string>>({})

  const update = (name: string, patch: Partial<ToolRow>) =>
    setRows((current) => current.map((row) => (row.name === name ? { ...row, ...patch } : row)))

  function save(confirmReadDowngrade = false) {
    setMessage(null)
    startTransition(async () => {
      const res = await approveMcpTools({
        connectorId,
        versionId,
        decisions: rows.map((row) => ({ name: row.name, risk: row.risk, approved: row.approved })),
        confirmReadDowngrade,
      })
      if (res.success) {
        onDone(`${res.data.approved} eszköz jóváhagyva.`)
      } else if (!confirmReadDowngrade && res.error.startsWith('Írásra utaló')) {
        if (window.confirm(res.error)) save(true)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function tryTool(name: string) {
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = tryArgs[name]?.trim() ? JSON.parse(tryArgs[name]) : {}
    } catch {
      setTryResult((current) => ({ ...current, [name]: 'A paraméterek nem érvényes JSON.' }))
      return
    }
    startTransition(async () => {
      const res = await tryMcpTool({ connectorId, tool: name, arguments: parsedArgs })
      setTryResult((current) => ({
        ...current,
        [name]: res.success ? JSON.stringify(res.data, null, 2) : res.error,
      }))
    })
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
        A leírásokat a külső szolgáltató írta. Ezt fogja látni az AI munkatárs — olvasd át. A kockázatot te
        döntöd el: olvasó eszköz azonnal fut, író és veszélyes eszköz jóváhagyási sorba kerül.
      </p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.name} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={row.approved}
                  onChange={(e) => update(row.name, { approved: e.target.checked })}
                />
                <code>{row.name}</code>
              </label>
              <select
                value={row.risk}
                onChange={(e) => update(row.name, { risk: e.target.value as Risk })}
                className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
                aria-label={`${row.name} kockázata`}
              >
                {(['read', 'write', 'danger'] as const).map((risk) => (
                  <option key={risk} value={risk}>
                    {RISK_LABEL[risk]}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-soft">Javaslat a név alapján: {RISK_LABEL[row.suggestedRisk]}</span>
              {row.writeLikeName && row.risk === 'read' ? (
                <span className="text-xs text-coral-deep">A neve alapján adatot módosíthat!</span>
              ) : null}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{row.description || '(nincs leírás)'}</p>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-ink-soft">Paraméterek</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-paper p-2">
                {JSON.stringify(row.inputSchema, null, 2)}
              </pre>
            </details>
            {row.suggestedRisk === 'read' || (row.approved && row.risk === 'read') ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-ink-soft">Kipróbálás (valódi hívás)</summary>
                <textarea
                  className={`${input} mt-1 font-mono text-xs`}
                  rows={2}
                  placeholder='Paraméterek JSON-ben, pl. {"query": "teszt"}'
                  value={tryArgs[row.name] ?? ''}
                  onChange={(e) => setTryArgs((current) => ({ ...current, [row.name]: e.target.value }))}
                />
                <button type="button" className={`${button} mt-1`} disabled={pending} onClick={() => tryTool(row.name)}>
                  Futtatás
                </button>
                {tryResult[row.name] ? (
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-paper p-2">{tryResult[row.name]}</pre>
                ) : null}
              </details>
            ) : null}
          </div>
        ))}
      </div>
      <button type="button" className={primary} disabled={pending} onClick={() => save()}>
        {isActive ? 'Besorolás mentése' : 'Jóváhagyás — ezek lesznek elérhetők'}
      </button>
      <Message value={message} />
    </div>
  )
}

function ConnectorCard({ row, reload }: { row: ConnectorRow; reload: (text?: string) => void }) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const delegated = row.authMode === 'user_delegated'

  function sync() {
    setMessage(null)
    startTransition(async () => {
      const res = await syncMcpConnector({ connectorId: row.id })
      if (!res.success) return setMessage({ tone: 'err', text: res.error })
      reload(
        res.data.changed
          ? `A szerver ${res.data.toolCount} eszközt kínál — nézd át és hagyd jóvá.`
          : 'Nincs változás a szerver eszközlistájában.',
      )
    })
  }

  function login() {
    startTransition(async () => {
      const res = await startConnectorOAuth({ connectorId: row.id })
      if (res.success) window.location.href = res.data.url
      else setMessage({ tone: 'err', text: res.error })
    })
  }

  function archive() {
    if (!window.confirm(`Biztosan archiválod a(z) „${row.name}” kapcsolatot? Az agentek nem tudják tovább használni.`)) return
    startTransition(async () => {
      const res = await archiveMcpConnector({ connectorId: row.id })
      if (res.success) reload('Kapcsolat archiválva.')
      else setMessage({ tone: 'err', text: res.error })
    })
  }

  const changeNote = row.proposed && row.active ? diffText(row.proposed.diff) : null

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="break-all text-xs text-ink-soft">{row.serverUrl}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {delegated ? 'Mindenki a saját fiókjával' : 'Közös céges fiókkal'}
            {' · '}
            {row.active ? `${row.active.tools.filter((tool) => tool.approved).length} jóváhagyott eszköz` : 'még nincs jóváhagyott eszköz'}
            {row.usedByAgents.length ? ` · használja: ${row.usedByAgents.join(', ')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {delegated ? (
            <button type="button" className={button} disabled={pending} onClick={login}>
              {row.hasOwnGrant ? 'Újra belépés' : 'Belépés a saját fiókoddal'}
            </button>
          ) : null}
          <button type="button" className={button} disabled={pending || (delegated && !row.hasOwnGrant)} onClick={sync}>
            {row.active || row.proposed ? 'Újraellenőrzés' : 'Eszközlista lekérése'}
          </button>
          <button type="button" className={button} disabled={pending} onClick={archive}>
            Archiválás
          </button>
        </div>
      </div>
      {!row.domainAllowed ? (
        <p className="text-sm text-coral-deep">
          A platform-adminisztrátor visszavonta ennek a szolgáltatónak az engedélyét — a hívások le vannak tiltva.
        </p>
      ) : null}
      {delegated && !row.hasOwnGrant && !row.active && !row.proposed ? (
        <p className="text-sm text-ink-soft">
          Saját fiókos módban az eszközlista lekéréséhez egyszer lépj be a saját fiókoddal. A munkatársaid a saját
          fiókjukkal lépnek be; ahol ez még nem történt meg, az AI munkatárs belépési linket ad.
        </p>
      ) : null}
      {changeNote ? <p className="text-sm text-amber-200">{changeNote}</p> : null}
      {row.proposed ? (
        <ToolReview
          key={row.proposed.versionId}
          connectorId={row.id}
          versionId={row.proposed.versionId}
          tools={row.proposed.tools}
          isActive={false}
          onDone={(text) => reload(text)}
        />
      ) : row.active?.versionId ? (
        <details>
          <summary className="cursor-pointer text-sm text-ink-soft">Eszközök és besorolásuk</summary>
          <div className="mt-2">
            <ToolReview
              key={row.active.versionId}
              connectorId={row.id}
              versionId={row.active.versionId}
              tools={row.active.tools}
              isActive
              onDone={(text) => reload(text)}
            />
          </div>
        </details>
      ) : null}
      <Message value={message} />
    </div>
  )
}

function CreateForm({ allowedHosts, onCreated }: { allowedHosts: string[]; onCreated: (text: string) => void }) {
  const [form, setForm] = useState({
    name: '',
    serverUrl: '',
    authMode: 'service' as 'service' | 'user_delegated',
    token: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
  })
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))

  function submit() {
    setMessage(null)
    startTransition(async () => {
      const res = await createMcpConnector(form)
      if (!res.success) return setMessage({ tone: 'err', text: res.error })
      onCreated(
        res.data.toolCount !== null
          ? `A szerver ${res.data.toolCount} eszközt kínál. Nézd át és hagyd jóvá őket lent.`
          : 'Kapcsolat létrehozva. Lépj be a saját fiókoddal, majd kérd le az eszközlistát.',
      )
      setForm((current) => ({ ...current, name: '', serverUrl: '', token: '', clientSecret: '' }))
    })
  }

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <p className="font-medium">Új MCP-szerver csatolása</p>
      <input className={input} placeholder="Név, pl. Projektkezelő" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      <input
        className={input}
        placeholder="Szerver címe, pl. https://mcp.example.com/mcp"
        value={form.serverUrl}
        onChange={(e) => set({ serverUrl: e.target.value })}
      />
      <p className="text-xs text-ink-soft">
        Engedélyezett szolgáltatók: {allowedHosts.length ? allowedHosts.join(', ') : 'még egy sincs — kérd a platform-adminisztrátort.'}
      </p>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 text-ink-soft">Kinek a nevében fusson?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={form.authMode === 'service'} onChange={() => set({ authMode: 'service' })} />
          Közös céges fiókkal — egy token, mindenki ugyanazt látja
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={form.authMode === 'user_delegated'} onChange={() => set({ authMode: 'user_delegated' })} />
          Mindenki a saját fiókjával — mindenki csak azt látja, amihez neki joga van
        </label>
      </fieldset>
      {form.authMode === 'service' ? (
        <input
          className={input}
          type="password"
          autoComplete="off"
          placeholder="Hozzáférési token (ha a szerver kér)"
          value={form.token}
          onChange={(e) => set({ token: e.target.value })}
        />
      ) : (
        <div className="space-y-2">
          <input
            className={input}
            placeholder="Alkalmazás-azonosító (client ID) a szolgáltatótól"
            value={form.clientId}
            onChange={(e) => set({ clientId: e.target.value })}
          />
          <input
            className={input}
            type="password"
            autoComplete="off"
            placeholder="Alkalmazás-titok (csak ha a szolgáltató adott)"
            value={form.clientSecret}
            onChange={(e) => set({ clientSecret: e.target.value })}
          />
          <input
            className={input}
            placeholder="Jogosultságok (scope-ok), szóközzel — üresen a szerver ajánlását használjuk"
            value={form.scopes}
            onChange={(e) => set({ scopes: e.target.value })}
          />
        </div>
      )}
      <button type="button" className={primary} disabled={pending || !form.name.trim() || !form.serverUrl.trim()} onClick={submit}>
        {pending ? 'Ellenőrzés…' : 'Ellenőrzés és mentés'}
      </button>
      <Message value={message} />
    </div>
  )
}

/** #395: külső MCP-szerverek csatolása kódírás nélkül. */
export function McpConnectorsPanel({
  canManage,
  initial,
  initialError,
}: {
  canManage: boolean
  initial: McpConnectorsData | null
  initialError?: string
}) {
  const [data, setData] = useState(initial)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    initialError ? { tone: 'err', text: initialError } : null,
  )

  const reload = useCallback(async (text?: string) => {
    const res = await listMcpConnectors()
    if (res.success) setData(res.data as McpConnectorsData)
    else setMessage({ tone: 'err', text: res.error })
    if (text) setMessage({ tone: 'ok', text })
  }, [])

  return (
    <Card title="Külső MCP-szerverek">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Az MCP egy szabványos csatlakozó, amivel sok szolgáltatás (pl. projektkezelők, jegykezelők, dokumentumtárak)
          a saját eszközeit kínálja az AI-nak. Itt kódírás nélkül csatolhatod: megadod a címét, átnézed és jóváhagyod az
          eszközeit, majd egy AI munkatárshoz rendeled a Kapcsolatok között. A belépési adat nálunk marad, minden hívás
          naplózódik.
        </p>
        <Message value={message} />
        {data && data.connectors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-soft">
            Még nincs csatolt MCP-szerver. Példák: egy projektkezelő MCP-címe (pl. <code>https://mcp.atlassian.com/v1/mcp</code>)
            vagy egy dokumentumkereső szolgáltatás. A szolgáltatót előbb a platform-adminisztrátornak kell engedélyeznie.
          </p>
        ) : null}
        {data?.connectors.map((row) => (
          <ConnectorCard key={row.id} row={row} reload={(text) => void reload(text)} />
        ))}
        {canManage && data ? <CreateForm allowedHosts={data.allowedHosts} onCreated={(text) => void reload(text)} /> : null}
      </div>
    </Card>
  )
}
