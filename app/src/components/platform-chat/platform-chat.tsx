'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
import {
  ChatApiError,
  createWorkerClient,
  fetchChatSession,
  type ChatAgent,
  type ChatAttachment,
  type ChatConversation,
  type ChatMessageView,
  type ConversationView,
  type WorkerClient,
} from './worker-client'

/** §6.4: a korlátok a feltöltés előtt látszanak és érvényesülnek. */
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_FILES = 5
const ACCEPT = '.csv,.xlsx,.pdf,.txt,.md,.png,.jpg,.jpeg'
const COLD_START_MS = 1500

type Live = {
  turnId: string
  /** Az utolsó feldolgozott esemény: jóváhagyás után innen folytatjuk (nincs dupla szöveg). */
  lastId: number
  text: string
  status: string
  approval: { message: string; link?: string } | null
  error: string | null
}

const SESSION_ERRORS: Record<string, string> = {
  platform_chat_disabled: 'A beszélgetés a platformon ennél a cégnél most ki van kapcsolva.',
  key_missing: 'A beszélgetéshez céges modell-kulcs kell.',
  not_configured: 'A beszélgetés szolgáltatás még nincs beállítva. Szólj a rendszergazdának.',
  unauthenticated: 'A munkamenet lejárt. Frissítsd az oldalt.',
}

function toolStatus(name: string): string {
  const label = getToolUiLabel(name).label
  // §6.1: nincs tool-név a felületen — ismeretlen eszköznél általános szöveg.
  return label === name ? 'Dolgozom a kérésen…' : `${label}…`
}

function suggestions(agent: ChatAgent): string[] {
  const topic = agent.description?.split(/[.!?\n]/)[0]?.trim()
  return [
    'Miben tudsz nekem segíteni?',
    topic ? `Mutasd meg egy példán, hogyan segítesz ebben: ${topic.slice(0, 80)}` : 'Mutasd be röviden, mivel foglalkozol!',
    'Milyen információra van szükséged tőlem az induláshoz?',
  ]
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink [&_a]:text-coral-deep [&_a]:underline [&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1 [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-ink/5 [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line/70 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line/70 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function MessageBubble({ message }: { message: Pick<ChatMessageView, 'role' | 'content' | 'attachments'> }) {
  const mine = message.role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${mine ? 'bg-coral/15' : 'border border-line/60 bg-panel'}`}>
        {mine ? <p className="whitespace-pre-wrap text-sm text-ink">{message.content}</p> : <Markdown text={message.content} />}
        {message.attachments.length ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <li key={a.id} className="rounded-md bg-ink/5 px-2 py-0.5 text-xs text-ink-soft">📎 {a.name}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

export function PlatformChat({ isAdmin, keyMissingForAdmin }: { isAdmin: boolean; keyMissingForAdmin: boolean }) {
  const [client, setClient] = useState<WorkerClient | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [agents, setAgents] = useState<ChatAgent[] | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ConversationView | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<ChatAttachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [adminMode, setAdminMode] = useState(false)
  const streamAbort = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  const agent = useMemo(() => agents?.find((a) => a.agentId === agentId) ?? null, [agents, agentId])

  useEffect(() => {
    let cancelled = false
    fetchChatSession()
      .then(async (session) => {
        const c = createWorkerClient(session)
        const list = await c.agents()
        if (cancelled) return
        setClient(c)
        setAgents(list.agents)
        setAgentId(list.agents[0]?.agentId ?? null)
      })
      .catch((e) => {
        if (cancelled) return
        const code = e instanceof ChatApiError ? e.code : 'request_failed'
        setFatal(SESSION_ERRORS[code] ?? 'Most nem sikerült elindítani a beszélgetést. Próbáld újra egy perc múlva.')
      })
    return () => {
      cancelled = true
      streamAbort.current?.abort()
    }
  }, [])

  const loadConversations = useCallback(
    async (c: WorkerClient, forAgent: string | null, q: string) => {
      if (adminMode) {
        setConversations((await c.adminConversations({ q })).conversations)
        return
      }
      if (!forAgent) return
      setConversations((await c.conversations({ agentId: forAgent, q })).conversations)
    },
    [adminMode],
  )

  const follow = useCallback(
    async (c: WorkerClient, conversationId: string, turnId: string, after = 0) => {
      streamAbort.current?.abort()
      const abort = new AbortController()
      streamAbort.current = abort
      setLive((prev) => (prev?.turnId === turnId ? prev : { turnId, lastId: 0, text: '', status: 'Gondolkodom…', approval: null, error: null }))
      const coldStart = setTimeout(() => setLive((p) => (p && !p.text && p.turnId === turnId ? { ...p, status: 'Ébresztem a munkatársat…' } : p)), COLD_START_MS)
      try {
        await c.stream(
          turnId,
          (e) => {
            clearTimeout(coldStart)
            setLive((prev) => {
              if (!prev || prev.turnId !== turnId) return prev
              const p = { ...prev, lastId: Math.max(prev.lastId, e.id) }
              if (e.type === 'delta') return { ...p, text: p.text + String(e.data.text ?? ''), status: '' }
              if (e.type === 'status') return { ...p, status: e.data.phase === 'thinking' ? (p.text ? '' : 'Gondolkodom…') : p.status }
              if (e.type === 'tool') {
                return { ...p, text: p.text && !p.text.endsWith('\n\n') ? `${p.text}\n\n` : p.text, status: e.data.phase === 'start' ? toolStatus(String(e.data.name ?? '')) : 'Gondolkodom…' }
              }
              if (e.type === 'approval') {
                if (e.data.phase === 'requested') return { ...p, status: '', approval: { message: String(e.data.message ?? ''), link: e.data.link as string | undefined } }
                return { ...p, approval: null, status: 'Gondolkodom…' }
              }
              if (e.type === 'error') return { ...p, status: '', error: String(e.data.message ?? 'Most nem sikerült válaszolni.') }
              return p
            })
          },
          abort.signal,
          after,
        )
      } catch (error) {
        if (!abort.signal.aborted) setLive((p) => (p ? { ...p, status: '', error: 'Megszakadt a kapcsolat. Frissítsd az oldalt — a válasz a háttérben elkészül.' } : p))
        void error
      } finally {
        clearTimeout(coldStart)
      }
      if (abort.signal.aborted) return
      const fresh = await c.conversation(conversationId)
      setView(fresh)
      setLive((p) => (p && (p.approval || p.error) ? p : null))
    },
    [],
  )

  const open = useCallback(
    async (c: WorkerClient, conversationId: string) => {
      streamAbort.current?.abort()
      setLive(null)
      setNotice(null)
      const v = adminMode ? await c.adminConversation(conversationId) : await c.conversation(conversationId)
      setView(v)
      if (v.activeTurn?.pendingApproval) {
        setLive({ turnId: v.activeTurn.id, lastId: 0, text: '', status: '', approval: { message: v.activeTurn.pendingApproval.message }, error: null })
      } else if (v.activeTurn) {
        // §2/5: visszatéréskor a beszélgetés ott folytatódik, ahol tart.
        void follow(c, conversationId, v.activeTurn.id)
      } else if (v.lastError) {
        setLive({ turnId: v.lastError.turnId, lastId: 0, text: '', status: '', approval: null, error: v.lastError.message ?? 'Most nem sikerült válaszolni.' })
      }
    },
    [adminMode, follow],
  )

  useEffect(() => {
    if (!client) return
    let cancelled = false
    const forAgent = agentId
    const t = setTimeout(async () => {
      try {
        await loadConversations(client, forAgent, query)
      } catch {
        if (!cancelled) setNotice('A korábbi beszélgetéseket most nem sikerült betölteni.')
      }
    }, query ? 300 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [client, agentId, query, loadConversations])

  useEffect(() => {
    if (!client || adminMode || !agentId) return
    // Kattintás → az utolsó beszélgetés folytatása, ha van (§2/3).
    void (async () => {
      const list = (await client.conversations({ agentId })).conversations
      if (list[0]) await open(client, list[0].id)
      else {
        setView(null)
        setLive(null)
      }
    })().catch(() => setNotice('A beszélgetést most nem sikerült megnyitni.'))
  }, [client, agentId, adminMode, open])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [view?.messages.length, live?.text, live?.approval])

  async function ensureConversation(c: WorkerClient): Promise<string> {
    if (view && !adminMode) return view.conversation.id
    const created = await c.createConversation(agentId!)
    setConversations((list) => [created.conversation, ...list])
    setView({ conversation: created.conversation, messages: [], activeTurn: null, lastError: null })
    return created.conversation.id
  }

  async function send(text = draft) {
    if (!client || !agentId || busy) return
    const content = text.trim()
    if (!content && files.length === 0) return
    setBusy(true)
    setNotice(null)
    try {
      const id = await ensureConversation(client)
      const { turnId } = await client.send(id, content, files.map((f) => f.id))
      setView((v) => (v ? { ...v, messages: [...v.messages, { id: `local-${turnId}`, role: 'user', content, attachments: files, createdAt: new Date().toISOString() }] } : v))
      setDraft('')
      setFiles([])
      setLive({ turnId, lastId: 0, text: '', status: 'Gondolkodom…', approval: null, error: null })
      void follow(client, id, turnId)
      void loadConversations(client, agentId, query)
    } catch (e) {
      setNotice(e instanceof ChatApiError && e.status === 409 ? 'Még dolgozik az előző kérésen. Várj, vagy állítsd le.' : 'Az üzenetet most nem sikerült elküldeni. Próbáld újra.')
    } finally {
      setBusy(false)
    }
  }

  async function attach(list: FileList | null) {
    if (!client || !list?.length) return
    const picked = [...list]
    if (files.length + picked.length > MAX_FILES) return setNotice(`Egy üzenethez legfeljebb ${MAX_FILES} fájl csatolható.`)
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES)
    if (tooBig) return setNotice(`A(z) ${tooBig.name} túl nagy: fájlonként legfeljebb 20 MB csatolható.`)
    setBusy(true)
    try {
      const id = await ensureConversation(client)
      for (const file of picked) {
        const { attachment } = await client.upload(id, file)
        setFiles((f) => [...f, attachment])
      }
    } catch (e) {
      setNotice(e instanceof ChatApiError && e.status === 415 ? 'Ezt a fájltípust nem lehet csatolni (CSV, XLSX, PDF, TXT, MD, PNG, JPG).' : 'A fájlt most nem sikerült feltölteni.')
    } finally {
      setBusy(false)
    }
  }

  async function decide(decision: 'approve' | 'reject') {
    if (!client || !live || !view) return
    try {
      const { outcome } = await client.approve(live.turnId, decision)
      setLive({ ...live, approval: null, status: outcome === 'expired' ? '' : 'Gondolkodom…' })
      void follow(client, view.conversation.id, live.turnId, live.lastId)
    } catch {
      setNotice('A döntést most nem sikerült elküldeni. Próbáld újra.')
    }
  }

  async function stop() {
    if (!client || !live) return
    await client.cancel(live.turnId).catch(() => {})
    streamAbort.current?.abort()
    setLive(null)
    if (view) setView(await client.conversation(view.conversation.id))
  }

  async function rename(c: ChatConversation, title: string) {
    if (!client || !title.trim()) return setRenaming(null)
    await client.rename(c.id, title.trim()).catch(() => setNotice('Az átnevezés most nem sikerült.'))
    setRenaming(null)
    setConversations((list) => list.map((x) => (x.id === c.id ? { ...x, title: title.trim() } : x)))
    setView((v) => (v && v.conversation.id === c.id ? { ...v, conversation: { ...v.conversation, title: title.trim() } } : v))
  }

  async function remove(c: ChatConversation) {
    if (!client || !window.confirm(`Törlöd a(z) „${c.title}” beszélgetést? Ez nem vonható vissza.`)) return
    await client.remove(c.id).catch(() => setNotice('A törlés most nem sikerült.'))
    setConversations((list) => list.filter((x) => x.id !== c.id))
    if (view?.conversation.id === c.id) {
      setView(null)
      setLive(null)
    }
  }

  // --- Üres állapotok (§2) ---
  if (fatal) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-line bg-panel p-6 text-sm">
        <p className="text-ink">{fatal}</p>
        {keyMissingForAdmin ? (
          <Link href="/control-plane/settings?section=openrouter" className="mt-3 inline-block rounded-lg bg-coral px-3 py-1.5 font-medium text-white">
            Kulcs beállítása
          </Link>
        ) : isAdmin ? (
          <Link href="/control-plane/settings?section=platform-chat" className="mt-3 inline-block text-coral-deep underline">
            Beállítások → Beszélgetés a platformon
          </Link>
        ) : null}
      </div>
    )
  }
  if (!agents) return <p className="text-sm text-ink-soft">Betöltés…</p>
  if (agents.length === 0) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-line bg-panel p-6 text-sm text-ink">
        Még nincs olyan munkatárs, akivel itt beszélgethetnél. Kérd meg az adminisztrátort, hogy engedélyezzen egyet.
      </div>
    )
  }

  const readOnly = adminMode
  const working = !!live && !live.approval && !live.error

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] flex-col gap-3 lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-3 lg:w-72">
        {/* Mobilon lenyíló lista (§6.2) */}
        <select
          className="rounded-lg border border-line bg-panel px-3 py-2 text-sm lg:hidden"
          value={agentId ?? ''}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={adminMode}
        >
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>{a.name}</option>
          ))}
        </select>
        <ul className="hidden space-y-1 lg:block">
          {agents.map((a) => (
            <li key={a.agentId}>
              <button
                type="button"
                disabled={adminMode}
                onClick={() => setAgentId(a.agentId)}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition ${a.agentId === agentId && !adminMode ? 'bg-coral/15' : 'hover:bg-night/30'}`}
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-coral/20 text-sm font-semibold text-coral-deep">
                  {a.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                  {a.description ? <span className="block truncate text-xs text-ink-soft">{a.description}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line/60 bg-panel/40 p-2">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Keresés a beszélgetésekben"
              className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm"
            />
            {!adminMode ? (
              <button
                type="button"
                title="Új beszélgetés"
                onClick={() => {
                  setView(null)
                  setLive(null)
                }}
                className="rounded-lg border border-line px-2 py-1.5 text-sm hover:border-coral/50"
              >
                +
              </button>
            ) : null}
          </div>
          <ul className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {conversations.length === 0 ? <li className="px-2 py-1 text-xs text-ink-faint">{query ? 'Nincs találat.' : 'Még nincs korábbi beszélgetés.'}</li> : null}
            {conversations.map((c) => (
              <li key={c.id} className={`group flex items-center gap-1 rounded-lg px-2 py-1 ${view?.conversation.id === c.id ? 'bg-coral/10' : 'hover:bg-night/20'}`}>
                {renaming === c.id ? (
                  <input
                    autoFocus
                    defaultValue={c.title}
                    onBlur={(e) => void rename(c, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(c, e.currentTarget.value)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="min-w-0 flex-1 rounded border border-line bg-panel px-1 text-sm"
                  />
                ) : (
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-sm text-ink" onClick={() => client && void open(client, c.id)}>
                    {adminMode ? `${c.agentName}: ` : ''}
                    {c.title}
                  </button>
                )}
                {!adminMode ? (
                  <span className="hidden shrink-0 gap-1 group-hover:flex">
                    <button type="button" title="Átnevezés" className="text-xs text-ink-faint hover:text-ink" onClick={() => setRenaming(c.id)}>✎</button>
                    <button type="button" title="Törlés" className="text-xs text-ink-faint hover:text-coral-deep" onClick={() => void remove(c)}>✕</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {isAdmin && client?.adminInsight ? (
            <button
              type="button"
              onClick={() => {
                setAdminMode((m) => !m)
                setView(null)
                setLive(null)
              }}
              className="mt-2 rounded-lg border border-line px-2 py-1.5 text-xs text-ink-soft hover:border-coral/50"
              title="A munkatársak platform-chat beszélgetései, csak olvasásra. Minden megnyitás naplózott."
            >
              {adminMode ? '← Vissza a saját beszélgetéseimhez' : 'Munkatársak beszélgetései (admin)'}
            </button>
          ) : null}
        </div>
      </aside>

      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-line/60 bg-panel/30">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 px-4 py-2">
          <p className="truncate text-sm font-medium text-ink">
            {adminMode ? 'Megtekintés (csak olvasás)' : agent?.name}
            {view ? <span className="ml-2 font-normal text-ink-soft">· {view.conversation.title}</span> : null}
          </p>
          {client?.adminInsight ? (
            <p className="rounded-full bg-honey/15 px-2.5 py-0.5 text-xs text-ink-soft" title="A cég adminisztrátora a platform üzemeltetőjének engedélyével olvashatja a platform-chat beszélgetéseket. Minden megnyitás naplózott.">
              Az adminisztrátor megtekintheti a beszélgetéseidet.
            </p>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!view?.messages.length && !live && agent && !adminMode ? (
            <div className="mx-auto max-w-lg space-y-2 pt-8 text-center">
              <p className="text-sm text-ink-soft">Kezdj egy kérdéssel — például:</p>
              {suggestions(agent).map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} className="block w-full rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm text-ink hover:border-coral/50">
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          {view?.messages.map((m) => <MessageBubble key={m.id} message={m} />)}
          {live ? (
            <div className="space-y-2">
              {live.text ? <MessageBubble message={{ role: 'assistant', content: live.text, attachments: [] }} /> : null}
              {live.status ? <p className="animate-pulse text-xs text-ink-soft">{live.status}</p> : null}
              {live.approval ? (
                <div className="max-w-[85%] rounded-xl border border-coral/40 bg-coral/5 p-3 text-sm">
                  <p className="font-medium text-ink">A munkatárs ezt szeretné elvégezni:</p>
                  <p className="mt-1 whitespace-pre-wrap text-ink">{live.approval.message}</p>
                  {readOnly ? null : (
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void decide('approve')} className="rounded-lg bg-coral px-3 py-1.5 font-medium text-white">Jóváhagyom</button>
                      <button type="button" onClick={() => void decide('reject')} className="rounded-lg border border-line bg-panel px-3 py-1.5 font-medium text-ink">Elvetem</button>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-ink-faint">
                    15 percen belül dönthetsz itt; utána a kérés a{' '}
                    <Link href="/control-plane/operations" className="underline">jóváhagyási listára</Link> kerül.
                  </p>
                </div>
              ) : null}
              {live.error ? (
                <div className="max-w-[85%] rounded-xl border border-coral/35 bg-coral/10 p-3 text-sm text-coral-deep">
                  <p>{live.error}</p>
                  {!readOnly ? (
                    <button
                      type="button"
                      className="mt-2 rounded-lg border border-coral/40 px-3 py-1 text-xs font-medium"
                      onClick={() => {
                        const last = [...(view?.messages ?? [])].reverse().find((m) => m.role === 'user')
                        setLive(null)
                        if (last) void send(last.content)
                      }}
                    >
                      Újra
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={bottom} />
        </div>

        {readOnly ? null : (
          <footer className="border-t border-line/50 p-3">
            {notice ? <p className="mb-2 text-xs text-coral-deep">{notice}</p> : null}
            {files.length ? (
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-1 rounded-md bg-ink/5 px-2 py-0.5 text-xs text-ink-soft">
                    📎 {f.name}
                    <button type="button" className="hover:text-coral-deep" onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>✕</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-end gap-2">
              <label className="cursor-pointer rounded-lg border border-line px-2.5 py-2 text-sm text-ink-soft hover:border-coral/50" title="Fájl csatolása: CSV, XLSX, PDF, TXT, MD, PNG, JPG — fájlonként legfeljebb 20 MB, üzenetenként 5 fájl.">
                📎
                <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => {
                  void attach(e.target.files)
                  e.target.value = ''
                }} />
              </label>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                placeholder={agent ? `Üzenet neki: ${agent.name}` : 'Üzenet'}
                className="min-w-0 flex-1 resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
              {working ? (
                <button type="button" onClick={() => void stop()} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:border-coral/50">Leállítás</button>
              ) : (
                <button type="button" disabled={busy || (!draft.trim() && !files.length)} onClick={() => void send()} className="rounded-lg bg-coral px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Küldés</button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">Csatolható: CSV, XLSX, PDF, TXT, MD, PNG, JPG — fájlonként 20 MB, üzenetenként 5 fájl.</p>
          </footer>
        )}
      </section>
    </div>
  )
}
