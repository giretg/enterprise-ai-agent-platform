'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { pickPlatformChatAgentId } from '@/lib/platform-chat-href'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
import { takePendingPrompt } from './pending-prompt'
import {
  ChatApiError,
  createWorkerClient,
  fetchChatSession,
  type ChatAgent,
  type ChatAttachment,
  type ChatConversation,
  type ChatFile,
  type ChatMessageView,
  type ConversationView,
  type WorkerClient,
} from './worker-client'

/** §6.4: a korlátok a feltöltés előtt látszanak és érvényesülnek. */
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_FILES = 5
const ACCEPT = '.csv,.xlsx,.pdf,.docx,.pptx,.json,.txt,.md,.png,.jpg,.jpeg'
const COLD_START_MS = 1500
const FILE_HINT = 'CSV, XLSX, PDF, DOCX, PPTX, JSON, TXT, MD, PNG, JPG — fájlonként legfeljebb 20 MB, üzenetenként 5 fájl.'
const SIDEBAR_KEY = 'platform-chat:sidebar'
const DESKTOP_QUERY = '(min-width: 1024px)'

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

function toolStatus(name: string, detail?: unknown): string {
  const { label, progress } = getToolUiLabel(name)
  // §6.1: nincs tool-név a felületen — ismeretlen eszköznél általános szöveg.
  if (label === name) return 'Dolgozom a kérésen…'
  // #1021: pl. „Megnyitom az oldalt: mnb.hu…” — a részletet (domain) a worker adja.
  const suffix = typeof detail === 'string' && detail ? `: ${detail.slice(0, 80)}` : ''
  return `${(progress ?? label).replace(/…$/, '')}${suffix}…`
}

function suggestions(agent: ChatAgent): string[] {
  const topic = agent.description?.split(/[.!?\n]/)[0]?.trim()
  return [
    'Miben tudsz nekem segíteni?',
    topic ? `Mutasd meg egy példán, hogyan segítesz ebben: ${topic.slice(0, 80)}` : 'Mutasd be röviden, mivel foglalkozol!',
    'Milyen információra van szükséged tőlem az induláshoz?',
  ]
}

/** Előzmények csoportosítása az utolsó aktivitás szerint (a lista már időrendben jön). */
function historyGroup(iso: string, now: Date): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = Date.parse(iso)
  const day = 86_400_000
  if (t >= startOfToday) return 'Ma'
  if (t >= startOfToday - day) return 'Tegnap'
  if (t >= startOfToday - 7 * day) return 'Előző 7 nap'
  if (t >= startOfToday - 30 * day) return 'Előző 30 nap'
  return 'Régebbi'
}

const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  newChat: 'M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
  clip: 'M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6L14.5 7',
  send: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  stop: 'M7 7h10v10H7z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5 10 17l9-10',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  chevron: 'm6 9.5 6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  down: 'M12 5v14M5.5 12.5 12 19l6.5-6.5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  download: 'M12 4v11M7 10.5 12 15.5l5-5M5 19.5h14',
  cloud: 'M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 18.5M12 15V10M9.5 12.5 12 10l2.5 2.5',
} as const

function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  )
}

function AgentAvatar({ name, size = 'sm' }: { name: string; size?: 'xs' | 'sm' | 'lg' }) {
  const cls = size === 'lg' ? 'h-14 w-14 text-xl' : size === 'xs' ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs'
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full bg-coral/15 font-semibold text-coral-deep ${cls}`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-[15px] leading-7 text-ink [&_a]:text-coral-deep [&_a]:underline [&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-ink/5 [&_pre]:p-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:border-line/70 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line/70 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function ActionButton({ label, icon, onClick }: { label: string; icon: keyof typeof ICONS; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-lg p-1.5 text-ink-faint transition hover:bg-ink/5 hover:text-ink">
      <Icon name={icon} />
    </button>
  )
}

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  if (!attachments.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <li key={a.id} className="flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink-soft">
          <Icon name="clip" className="h-3.5 w-3.5" /> {a.name}
        </li>
      ))}
    </ul>
  )
}

const FILE_BADGES: Record<string, string> = {
  xlsx: 'bg-emerald-600',
  csv: 'bg-emerald-700',
  docx: 'bg-sky-700',
  pdf: 'bg-rose-600',
  md: 'bg-ink-soft',
}

function fileSize(bytes: number | null): string | null {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} bájt`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} MB`
}

function expiryText(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * #1024: a munkatárs által készített letölthető fájl. Lejárt fájlnál nincs letöltés, csak a teendő;
 * a „Mentés a Drive-ra” a szokásos jóváhagyással megy, és csak Drive-hozzáféréssel látszik.
 */
function FileCards({ files, onSaveToDrive }: { files: ChatFile[]; onSaveToDrive?: (file: ChatFile) => void }) {
  if (!files.length) return null
  const now = new Date()
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {files.map((file) => {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
        const expired = file.expiresAt ? Date.parse(file.expiresAt) <= now.getTime() : false
        const size = fileSize(file.size)
        return (
          <li key={file.url} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-3 py-2.5 sm:flex-nowrap">
            <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold uppercase text-white ${FILE_BADGES[ext] ?? 'bg-ink-soft'}`}>
              {ext.slice(0, 4) || 'fájl'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-ink-soft">
                {expired
                  ? 'A fájl lejárt — kérd meg a munkatársat, hogy készítse el újra.'
                  : [size, file.expiresAt ? `${expiryText(file.expiresAt)}-ig tölthető le, csak te éred el` : null].filter(Boolean).join(' · ')}
              </p>
            </div>
            {!expired ? (
              <div className="flex shrink-0 gap-1.5">
                {file.canSaveToDrive && onSaveToDrive ? (
                  <button
                    type="button"
                    onClick={() => onSaveToDrive(file)}
                    title="A munkatárs feltölti a fájlt a Google Drive-ra. Előtte jóváhagyást kér tőled."
                    className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-ink/5"
                  >
                    <Icon name="cloud" className="h-3.5 w-3.5" /> Mentés a Drive-ra
                  </button>
                ) : null}
                <a
                  href={file.url}
                  download={file.name}
                  className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:bg-ink/85"
                >
                  <Icon name="download" className="h-3.5 w-3.5" /> Letöltés
                </a>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Grok-szerű üzenet: a saját üzenet jobbra buborékban, a munkatárs válasza buborék nélkül, teljes szélességben. */
function Message({
  message,
  streaming = false,
  copied,
  onCopy,
  onEdit,
  onSaveToDrive,
}: {
  message: Pick<ChatMessageView, 'id' | 'role' | 'content' | 'attachments' | 'files'>
  streaming?: boolean
  copied: boolean
  onCopy?: () => void
  onEdit?: () => void
  onSaveToDrive?: (file: ChatFile) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end">
        <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-ink/[0.06] px-4 py-2.5">
          {message.content ? <p className="whitespace-pre-wrap text-[15px] leading-7 text-ink">{message.content}</p> : null}
          <AttachmentList attachments={message.attachments} />
        </div>
        <div className="mt-1 flex gap-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          {onCopy ? <ActionButton label={copied ? 'Kimásolva' : 'Másolás'} icon={copied ? 'check' : 'copy'} onClick={onCopy} /> : null}
          {onEdit ? <ActionButton label="Szerkesztés és újraküldés" icon="edit" onClick={onEdit} /> : null}
        </div>
      </div>
    )
  }
  return (
    <div className="group">
      <Markdown text={message.content} />
      {streaming ? <span aria-hidden className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-ink/40 align-middle" /> : null}
      <AttachmentList attachments={message.attachments} />
      <FileCards files={message.files ?? []} onSaveToDrive={onSaveToDrive} />
      {!streaming && onCopy ? (
        <div className="mt-1 flex gap-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <ActionButton label={copied ? 'Kimásolva' : 'Válasz másolása'} icon={copied ? 'check' : 'copy'} onClick={onCopy} />
        </div>
      ) : null}
    </div>
  )
}

export function PlatformChat({
  isAdmin,
  keyMissingForAdmin,
  initialAgentId = null,
}: {
  isAdmin: boolean
  keyMissingForAdmin: boolean
  /** A kártya / adatlap `?agent=` paramétere — ha a listában van, őt választjuk. */
  initialAgentId?: string | null
}) {
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
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [adminMode, setAdminMode] = useState(false)
  // Asztali nézetben megjegyezzük, hogy az oldalsáv nyitva vagy csukva volt (betöltés alatt még nem látszik).
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return typeof window === 'undefined' || localStorage.getItem(SIDEBAR_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const streamAbort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const atBottomRef = useRef(true)
  const refreshListRef = useRef<() => void>(() => {})
  const booted = useRef(false)
  const pendingPrompt = useRef<{ agentId: string; text: string } | null>(null)

  const agent = useMemo(() => agents?.find((a) => a.agentId === agentId) ?? null, [agents, agentId])

  useEffect(() => {
    let cancelled = false
    fetchChatSession()
      .then(async (session) => {
        const c = createWorkerClient(session)
        const list = await c.agents()
        if (cancelled) return
        // Az Áttekintés oldalról hozott kérdés: ezzel a munkatárssal indul, és azonnal elmegy.
        const pending = takePendingPrompt()
        pendingPrompt.current = pending && list.agents.some((a) => a.agentId === pending.agentId) ? pending : null
        setClient(c)
        setAgents(list.agents)
        setAgentId(pendingPrompt.current?.agentId ?? pickPlatformChatAgentId(list.agents, initialAgentId))
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
  }, [initialAgentId])

  const loadConversations = useCallback(
    async (c: WorkerClient, q: string) => {
      // Grok-szerű egységes előzmény: minden munkatárssal folytatott beszélgetés egy listában.
      const list = adminMode ? await c.adminConversations({ q }) : await c.conversations({ q })
      setConversations(list.conversations)
    },
    [adminMode],
  )

  useEffect(() => {
    refreshListRef.current = () => {
      if (client) void loadConversations(client, query).catch(() => {})
    }
  }, [client, query, loadConversations])

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
                return { ...p, text: p.text && !p.text.endsWith('\n\n') ? `${p.text}\n\n` : p.text, status: e.data.phase === 'start' ? toolStatus(String(e.data.name ?? ''), e.data.detail) : 'Gondolkodom…' }
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
      // Az első válasz után a beszélgetés címet kap — frissül az előzménylista.
      refreshListRef.current()
    },
    [],
  )

  const open = useCallback(
    async (c: WorkerClient, conversationId: string) => {
      streamAbort.current?.abort()
      setLive(null)
      setNotice(null)
      setDrawerOpen(false)
      const v = adminMode ? await c.adminConversation(conversationId) : await c.conversation(conversationId)
      setView(v)
      if (!adminMode) setAgentId(v.conversation.agentId)
      atBottomRef.current = true
      setAtBottom(true)
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
    const t = setTimeout(async () => {
      try {
        await loadConversations(client, query)
      } catch {
        if (!cancelled) setNotice('A korábbi beszélgetéseket most nem sikerült betölteni.')
      }
    }, query ? 300 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [client, query, loadConversations])

  // Követjük, hogy a felhasználó az alján van-e: csak akkor görgetünk magunktól, ha igen.
  function onScroll() {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom()
  }, [view?.messages.length, view?.conversation.id, live?.text, live?.status, live?.approval, live?.error, scrollToBottom])

  // A szövegmező a tartalommal együtt nő (max. ~8 sor), mint a chat-appokban.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => textarea.current?.focus())
  }, [])

  function newChat(forAgent?: string) {
    streamAbort.current?.abort()
    setView(null)
    setLive(null)
    setNotice(null)
    setFiles([])
    setAdminMode(false)
    setDrawerOpen(false)
    setPickerOpen(false)
    if (forAgent) setAgentId(forAgent)
    atBottomRef.current = true
    setAtBottom(true)
    focusComposer()
  }

  function toggleSidebar() {
    if (window.matchMedia(DESKTOP_QUERY).matches) {
      setSidebarOpen((o) => {
        try {
          localStorage.setItem(SIDEBAR_KEY, o ? 'closed' : 'open')
        } catch {
          // nincs tároló
        }
        return !o
      })
    } else {
      setDrawerOpen(true)
    }
  }

  // Billentyűparancsok: Ctrl/⌘+Shift+O új beszélgetés, Ctrl/⌘+K keresés, Esc bezárja a lenyílókat.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        newChat()
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (window.matchMedia(DESKTOP_QUERY).matches) setSidebarOpen(true)
        else setDrawerOpen(true)
        requestAnimationFrame(() => searchInput.current?.focus())
      } else if (e.key === 'Escape') {
        setDrawerOpen(false)
        setPickerOpen(false)
        setMenuFor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // newChat csak állapot-settereket hív — a legutóbbi példány mindig jó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function ensureConversation(c: WorkerClient, forAgent: string): Promise<string> {
    if (view && !adminMode) return view.conversation.id
    const created = await c.createConversation(forAgent)
    setConversations((list) => [created.conversation, ...list])
    setView({ conversation: created.conversation, messages: [], activeTurn: null, lastError: null })
    return created.conversation.id
  }

  async function send(text = draft, forAgent = agentId) {
    if (!client || !forAgent || busy) return
    const content = text.trim()
    if (!content && files.length === 0) return
    setBusy(true)
    setNotice(null)
    try {
      const id = await ensureConversation(client, forAgent)
      const { turnId } = await client.send(id, content, files.map((f) => f.id))
      setView((v) => (v ? { ...v, messages: [...v.messages, { id: `local-${turnId}`, role: 'user', content, attachments: files, createdAt: new Date().toISOString() }] } : v))
      setDraft('')
      setFiles([])
      atBottomRef.current = true
      setAtBottom(true)
      setLive({ turnId, lastId: 0, text: '', status: 'Gondolkodom…', approval: null, error: null })
      void follow(client, id, turnId)
      refreshListRef.current()
    } catch (e) {
      setNotice(e instanceof ChatApiError && e.status === 409 ? 'Még dolgozik az előző kérésen. Várj, vagy állítsd le.' : 'Az üzenetet most nem sikerült elküldeni. Próbáld újra.')
    } finally {
      setBusy(false)
    }
  }

  // Első betöltés: az Áttekintés oldalról hozott kérdés azonnal elmegy; a kártya gombja (`?agent=`)
  // az adott munkatárssal folytatott utolsó beszélgetést nyitja (§2/3); egyébként üres új beszélgetés.
  useEffect(() => {
    if (!client || !agents || booted.current) return
    booted.current = true
    const pending = pendingPrompt.current
    if (pending) {
      pendingPrompt.current = null
      void send(pending.text, pending.agentId)
      return
    }
    if (initialAgentId && agents.some((a) => a.agentId === initialAgentId)) {
      void (async () => {
        const list = (await client.conversations({ agentId: initialAgentId })).conversations
        if (list[0]) await open(client, list[0].id)
        else focusComposer()
      })().catch(() => setNotice('A beszélgetést most nem sikerült megnyitni.'))
      return
    }
    focusComposer()
    // Egyszeri indítás — a `send` / `open` a pillanatnyi állapottal fut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, agents])

  async function attach(list: FileList | File[] | null) {
    if (!client || !agentId || !list?.length) return
    const picked = [...list]
    if (files.length + picked.length > MAX_FILES) return setNotice(`Egy üzenethez legfeljebb ${MAX_FILES} fájl csatolható.`)
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES)
    if (tooBig) return setNotice(`A(z) ${tooBig.name} túl nagy: fájlonként legfeljebb 20 MB csatolható.`)
    setBusy(true)
    setNotice(null)
    try {
      const id = await ensureConversation(client, agentId)
      for (const file of picked) {
        const { attachment } = await client.upload(id, file)
        setFiles((f) => [...f, attachment])
      }
    } catch (e) {
      setNotice(e instanceof ChatApiError && e.status === 415 ? 'Ezt a fájltípust nem lehet csatolni (CSV, XLSX, PDF, DOCX, PPTX, JSON, TXT, MD, PNG, JPG).' : 'A fájlt most nem sikerült feltölteni.')
    } finally {
      setBusy(false)
      focusComposer()
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
    setMenuFor(null)
    if (!client || !window.confirm(`Törlöd a(z) „${c.title}” beszélgetést? Ez nem vonható vissza.`)) return
    await client.remove(c.id).catch(() => setNotice('A törlés most nem sikerült.'))
    setConversations((list) => list.filter((x) => x.id !== c.id))
    if (view?.conversation.id === c.id) newChat()
  }

  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(id)
      setTimeout(() => setCopied((cur) => (cur === id ? null : cur)), 1500)
    })
  }

  function pickAgent(id: string) {
    setPickerOpen(false)
    if (id === agentId && !view) return focusComposer()
    // Egy beszélgetés egy munkatárshoz tartozik: másik munkatárs = új beszélgetés (a megkezdett szöveg marad).
    newChat(id)
  }

  // --- Üres állapotok (§2) ---
  if (fatal) {
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-line bg-panel p-6 text-sm">
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
  if (!agents) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="animate-pulse text-sm text-ink-soft">Betöltés…</p>
      </div>
    )
  }
  if (agents.length === 0) {
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-line bg-panel p-6 text-sm text-ink">
        Még nincs olyan munkatárs, akivel itt beszélgethetnél. Kérd meg az adminisztrátort, hogy engedélyezzen egyet.
      </div>
    )
  }

  const readOnly = adminMode
  const working = !!live && !live.approval && !live.error
  const empty = !view?.messages.length && !live
  const now = new Date()

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => newChat()}
          title="Új beszélgetés (Ctrl+Shift+O)"
          className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-ink transition hover:bg-ink/5"
        >
          <Icon name="newChat" />
          Új beszélgetés
        </button>
        <button type="button" aria-label="Oldalsáv bezárása" title="Oldalsáv bezárása" onClick={() => (drawerOpen ? setDrawerOpen(false) : toggleSidebar())} className="rounded-xl p-2 text-ink-soft hover:bg-ink/5 hover:text-ink">
          <Icon name={drawerOpen ? 'close' : 'sidebar'} />
        </button>
      </div>

      <label className="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-sm focus-within:border-coral/50">
        <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
        <input
          ref={searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Keresés"
          title="Keresés a beszélgetésekben (Ctrl+K)"
          aria-label="Keresés a beszélgetésekben"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-faint sm:text-sm"
        />
        {query ? (
          <button type="button" aria-label="Keresés törlése" onClick={() => setQuery('')} className="text-ink-faint hover:text-ink">
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>

      {!adminMode && !query ? (
        <div>
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Munkatársak</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto">
            {agents.map((a) => (
              <li key={a.agentId}>
                <button
                  type="button"
                  onClick={() => pickAgent(a.agentId)}
                  title={a.description ?? `Új beszélgetés vele: ${a.name}`}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm transition ${a.agentId === agentId && !view ? 'bg-coral/10 text-ink' : 'text-ink hover:bg-ink/5'}`}
                >
                  <AgentAvatar name={a.name} size="xs" />
                  <span className="truncate">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <nav aria-label="Korábbi beszélgetések" className="min-h-0 flex-1 overflow-y-auto">
        {adminMode ? <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-honey">Munkatársak beszélgetései · csak olvasás</p> : null}
        {conversations.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-faint">{query ? 'Nincs találat.' : 'Még nincs korábbi beszélgetés.'}</p>
        ) : null}
        {conversations.map((c, i) => {
          const group = historyGroup(c.lastActivityAt, now)
          const showGroup = i === 0 || historyGroup(conversations[i - 1].lastActivityAt, now) !== group
          const active = view?.conversation.id === c.id
          return (
            <div key={c.id}>
              {showGroup ? <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{group}</p> : null}
              <div className={`group relative flex items-center rounded-xl ${active ? 'bg-ink/[0.07]' : 'hover:bg-ink/5'}`}>
                {renaming === c.id ? (
                  <input
                    autoFocus
                    defaultValue={c.title}
                    aria-label="Beszélgetés új neve"
                    onBlur={(e) => void rename(c, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(c, e.currentTarget.value)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="m-1 min-w-0 flex-1 rounded-lg border border-coral/50 bg-card px-2 py-1 text-base outline-none sm:text-sm"
                  />
                ) : (
                  <button type="button" className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => client && void open(client, c.id)}>
                    <span className="block truncate text-sm text-ink">{c.title}</span>
                    <span className="block truncate text-[11px] text-ink-faint">{c.agentName}</span>
                  </button>
                )}
                {!adminMode && renaming !== c.id ? (
                  <button
                    type="button"
                    aria-label={`Műveletek: ${c.title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === c.id}
                    onClick={() => setMenuFor((m) => (m === c.id ? null : c.id))}
                    className={`mr-1 shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-ink/5 hover:text-ink ${menuFor === c.id || active ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100'}`}
                  >
                    <Icon name="more" />
                  </button>
                ) : null}
                {menuFor === c.id ? (
                  <div role="menu" className="absolute right-1 top-full z-30 mt-1 w-40 rounded-xl border border-line bg-card p-1 shadow-lg">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuFor(null)
                        setRenaming(c.id)
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink hover:bg-ink/5"
                    >
                      <Icon name="edit" /> Átnevezés
                    </button>
                    <button type="button" role="menuitem" onClick={() => void remove(c)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-rose hover:bg-rose/10">
                      <Icon name="trash" /> Törlés
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </nav>

      {isAdmin && client?.adminInsight ? (
        <button
          type="button"
          onClick={() => {
            const next = !adminMode
            newChat()
            setAdminMode(next)
          }}
          className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-left text-xs text-ink-soft hover:border-coral/50"
          title="A munkatársak platform-chat beszélgetései, csak olvasásra. Minden megnyitás naplózott."
        >
          <Icon name="eye" />
          {adminMode ? 'Vissza a saját beszélgetéseimhez' : 'Munkatársak beszélgetései (admin)'}
        </button>
      ) : null}
    </div>
  )

  const composer = (
    <div
      className={`rounded-[1.75rem] border bg-card shadow-[0_4px_24px_-12px_rgba(0,0,0,0.18)] transition focus-within:border-coral/50 ${dragging ? 'border-coral' : 'border-line'}`}
    >
      {files.length ? (
        <ul className="flex flex-wrap gap-1.5 px-3 pt-3">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-1.5 rounded-xl border border-line bg-night px-2.5 py-1.5 text-xs text-ink-soft">
              <Icon name="clip" className="h-3.5 w-3.5" />
              <span className="max-w-[12rem] truncate">{f.name}</span>
              <button type="button" aria-label={`${f.name} eltávolítása`} className="hover:text-coral-deep" onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textarea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!working) void send()
          }
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault()
            void attach(e.clipboardData.files)
          }
        }}
        rows={1}
        aria-label="Üzenet"
        placeholder={agent ? `Kérdezd ${agent.name} munkatársat…` : 'Írd ide a kérdésed…'}
        className="block max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base leading-6 text-ink outline-none placeholder:text-ink-faint sm:px-5"
      />
      <div className="flex items-center gap-1.5 px-2 pb-2 pt-1 sm:px-3">
        <label
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-soft transition hover:bg-ink/5 hover:text-ink"
          title={`Fájl csatolása (vagy húzd ide / illeszd be): ${FILE_HINT}`}
        >
          <Icon name="clip" className="h-[18px] w-[18px]" />
          <span className="sr-only">Fájl csatolása</span>
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              void attach(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            title="Kivel beszélgetsz? Másik munkatárs választása új beszélgetést indít."
            className="flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-sm text-ink transition hover:bg-ink/5"
          >
            {agent ? <AgentAvatar name={agent.name} size="xs" /> : null}
            <span className="truncate">{agent?.name ?? 'Munkatárs'}</span>
            <Icon name="chevron" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          </button>
          {pickerOpen ? (
            <>
              <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setPickerOpen(false)} />
              <ul
                role="listbox"
                aria-label="Munkatárs választása"
                className={`absolute left-0 z-40 max-h-72 w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-line bg-card p-1.5 shadow-xl ${empty ? 'top-full mt-2' : 'bottom-full mb-2'}`}
              >
                {agents.map((a) => (
                  <li key={a.agentId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={a.agentId === agentId}
                      onClick={() => pickAgent(a.agentId)}
                      className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${a.agentId === agentId ? 'bg-coral/10' : 'hover:bg-ink/5'}`}
                    >
                      <AgentAvatar name={a.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                        {a.description ? <span className="line-clamp-2 text-xs text-ink-soft">{a.description}</span> : null}
                      </span>
                      {a.agentId === agentId ? <Icon name="check" className="mt-1 h-4 w-4 shrink-0 text-coral" /> : null}
                    </button>
                  </li>
                ))}
                {view?.messages.length ? <li className="px-2.5 pb-1 pt-2 text-[11px] text-ink-faint">Másik munkatárs választása új beszélgetést indít.</li> : null}
              </ul>
            </>
          ) : null}
        </div>
        <span className="flex-1" />
        {working ? (
          <button
            type="button"
            onClick={() => void stop()}
            aria-label="Leállítás"
            title="Leállítás"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-night transition hover:bg-ink/85"
          >
            <Icon name="stop" className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || (!draft.trim() && !files.length)}
            onClick={() => void send()}
            aria-label="Küldés"
            title="Küldés (Enter) · új sor: Shift+Enter"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral text-white transition hover:bg-coral-deep disabled:bg-ink/10 disabled:text-ink-faint"
          >
            <Icon name="send" className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
    </div>
  )

  const noticeLine = notice ? <p role="status" className="mb-2 px-2 text-xs text-coral-deep">{notice}</p> : null
  const footnote = (
    <p className="mt-1.5 hidden text-center text-[11px] text-ink-faint sm:block">
      A munkatárs tévedhet — a fontos adatokat ellenőrizd. Csatolható: {FILE_HINT}
    </p>
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Asztali oldalsáv (összecsukható) */}
      {sidebarOpen ? <aside className="hidden w-72 shrink-0 border-r border-line bg-night-2/60 lg:block">{sidebar}</aside> : null}

      {/* Mobil fiók */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Bezárás" className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[min(20rem,86vw)] bg-night pt-[env(safe-area-inset-top)] shadow-2xl">{sidebar}</aside>
        </div>
      ) : null}

      <section
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (readOnly || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          if (readOnly) return
          e.preventDefault()
          setDragging(false)
          void attach(e.dataTransfer.files)
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 px-2 sm:px-3">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Beszélgetések listája"
            title="Beszélgetések listája"
            className={`rounded-xl p-2 text-ink-soft hover:bg-ink/5 hover:text-ink ${sidebarOpen ? 'lg:hidden' : ''}`}
          >
            <Icon name="sidebar" className="h-5 w-5" />
          </button>
          <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-ink">
            {adminMode ? (view ? `${view.conversation.agentName} · ${view.conversation.title}` : 'Megtekintés (csak olvasás)') : view ? view.conversation.title : ''}
          </p>
          {client?.adminInsight ? (
            <span
              className="flex items-center gap-1 rounded-full bg-honey/15 px-2.5 py-1 text-xs text-ink-soft"
              title="A cég adminisztrátora a platform üzemeltetőjének engedélyével olvashatja a platform-chat beszélgetéseket. Minden megnyitás naplózott."
            >
              <Icon name="eye" className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Az adminisztrátor megtekintheti a beszélgetéseidet.</span>
              <span className="sm:hidden">Admin láthatja</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => newChat()}
            aria-label="Új beszélgetés"
            title="Új beszélgetés (Ctrl+Shift+O)"
            className={`rounded-xl p-2 text-ink-soft hover:bg-ink/5 hover:text-ink ${empty && !adminMode ? 'invisible' : ''}`}
          >
            <Icon name="newChat" className="h-5 w-5" />
          </button>
        </header>

        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-coral bg-coral/5 text-sm font-medium text-coral-deep">
            Engedd el a fájlt a csatoláshoz
          </div>
        ) : null}

        {readOnly && !view ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-soft">Válassz egy beszélgetést a listából. A megnyitás naplózott.</div>
        ) : empty && !readOnly ? (
          // Üres beszélgetés: asztalon középre igazított kérdezőmező (Grok kezdőképernyő), mobilon a mező alul.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-center sm:px-4">
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col sm:flex-none">
              <div className="order-1 flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center sm:flex-none sm:pb-8 sm:pt-0">
                {agent ? <AgentAvatar name={agent.name} size="lg" /> : null}
                <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Miben segíthetek?</h2>
                {agent ? (
                  <p className="max-w-md text-sm text-ink-soft">
                    <span className="font-medium text-ink">{agent.name}</span>
                    {agent.description ? <span className="line-clamp-2"> {agent.description}</span> : null}
                  </p>
                ) : null}
              </div>
              <div className="order-3 sm:order-2">
                {noticeLine}
                {composer}
              </div>
              {agent ? (
                <div className="order-2 -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:order-3 sm:mx-0 sm:mb-0 sm:mt-4 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
                  {suggestions(agent).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="shrink-0 rounded-full border border-line bg-card px-3.5 py-2 text-left text-sm text-ink-soft transition hover:border-coral/50 hover:text-ink sm:max-w-full sm:shrink"
                    >
                      <span className="line-clamp-1">{s}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="order-4">{footnote}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="relative min-h-0 flex-1">
              <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-8 pt-4">
                  {view?.messages.map((m) => (
                    <Message
                      key={m.id}
                      message={m}
                      copied={copied === m.id}
                      onCopy={m.content ? () => copy(m.id, m.content) : undefined}
                      onEdit={
                        m.role === 'user' && !readOnly && m.content
                          ? () => {
                              setDraft(m.content)
                              focusComposer()
                            }
                          : undefined
                      }
                      onSaveToDrive={readOnly || working ? undefined : (file) => void send(`Mentsd el a(z) „${file.name}” fájlt a Google Drive-ra (exportId: ${file.exportId}).`)}
                    />
                  ))}
                  {live ? (
                    <div className="space-y-3">
                      {live.text ? <Message message={{ id: 'live', role: 'assistant', content: live.text, attachments: [] }} streaming={working} copied={false} /> : null}
                      {live.status ? (
                        <p className="flex items-center gap-2 text-sm text-ink-soft">
                          <span aria-hidden className="flex gap-1">
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint" />
                          </span>
                          {live.status}
                        </p>
                      ) : null}
                      {live.approval ? (
                        <div className="rounded-2xl border border-coral/40 bg-coral/5 p-4 text-sm">
                          <p className="font-medium text-ink">A munkatárs ezt szeretné elvégezni:</p>
                          <p className="mt-1 whitespace-pre-wrap text-ink">{live.approval.message}</p>
                          {readOnly ? null : (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button type="button" onClick={() => void decide('approve')} className="rounded-full bg-coral px-4 py-1.5 font-medium text-white hover:bg-coral-deep">Jóváhagyom</button>
                              <button type="button" onClick={() => void decide('reject')} className="rounded-full border border-line bg-card px-4 py-1.5 font-medium text-ink hover:bg-ink/5">Elvetem</button>
                            </div>
                          )}
                          <p className="mt-2 text-xs text-ink-faint">
                            15 percen belül dönthetsz itt; utána a kérés a{' '}
                            <Link href="/control-plane/operations" className="underline">jóváhagyási listára</Link> kerül.
                          </p>
                        </div>
                      ) : null}
                      {live.error ? (
                        <div className="rounded-2xl border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
                          <p>{live.error}</p>
                          {!readOnly ? (
                            <button
                              type="button"
                              className="mt-2 rounded-full border border-coral/40 px-3 py-1 text-xs font-medium hover:bg-coral/10"
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
                </div>
              </div>
              {!atBottom ? (
                <button
                  type="button"
                  aria-label="Ugrás a legújabb üzenethez"
                  onClick={() => {
                    atBottomRef.current = true
                    setAtBottom(true)
                    scrollToBottom(true)
                  }}
                  className="absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-card text-ink-soft shadow-md hover:text-ink"
                >
                  <Icon name="down" />
                </button>
              ) : null}
            </div>
            {readOnly ? null : (
              <footer className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 sm:px-4">
                <div className="mx-auto max-w-3xl">
                  {noticeLine}
                  {composer}
                  {footnote}
                </div>
              </footer>
            )}
          </>
        )}
      </section>
    </div>
  )
}

