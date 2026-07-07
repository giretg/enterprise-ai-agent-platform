'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  askWiki,
  generateReport,
  getSandboxAppPreviewUrl,
  listDocumentsForAgent,
  listReportTemplatesAction,
  processDocument,
  processDocumentForWiki,
  promoteToTicket,
  uploadDocument,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import type { AgentSandboxKind } from '@/lib/agent-kind'

export type AgentSandboxAppSummary = {
  appId: string
  name: string
  description?: string
  status: string
  activeVersion?: number
  createdByLabel: string
  createdFromTicketId?: string
  updatedAt: string
}

const SAMPLE_QUESTION = 'Mi az MVP célja, és milyen gatewayeken kell átmennie az agent műveleteinek?'
const SAMPLE_INVOICE = `Beszállító: Ostoros Office Kft.
Számlaszám: SZ-2026-0142
Dátum: 2026-06-12
Nettó összeg: 120000
ÁFA: 32400
Bruttó összeg: 152400
Tétel: irodai szolgáltatás`

type KbDocument = { id: string; filename: string; status: string; createdAt: Date | string }

type ReportTemplateOption = { id: string; name: string; description: string }

type AgentSummary = {
  id: string
  name: string
  roleInstruction: string
}

export function AgentSandboxWorkspace({
  agent,
  kind,
  apps,
}: {
  agent: AgentSummary
  kind: AgentSandboxKind
  apps: AgentSandboxAppSummary[]
}) {
  if (kind === 'wiki') return <WikiSandbox agent={agent} apps={apps} />
  if (kind === 'bookkeeper') return <BookkeeperSandbox agent={agent} apps={apps} />

  return (
    <div className="space-y-6">
      <SandboxHeader
        eyebrow="Sandbox"
        title={`${agent.name} munkatér`}
        description="Ehhez az agenthez még nincs dedikált sandbox felület bekötve. A Control Plane-ben a konfiguráció, ticketek, audit és tanítás ettől függetlenül elérhető."
      />
      <AgentSandboxApps apps={apps} />
      <Card title="Következő lépés">
        <p className="text-sm leading-relaxed text-ink-soft">
          A platform már agentenként route-ol a sandboxban. Ehhez az agenthez egy egyedi munkafelületet
          kell felvenni, amely a saját runtime-ját vagy eszközeit hívja.
        </p>
        <Link
          href={`/control-plane/agents/${agent.id}`}
          className="mt-3 inline-block rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral hover:bg-coral/30"
        >
          Agent konfiguráció megnyitása
        </Link>
      </Card>
    </div>
  )
}

function appStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'blocked') return 'danger'
  if (status === 'archived') return 'neutral'
  return 'warning'
}

/**
 * Az agent által (chatben vagy ticketen át) létrehozott App Registry appok —
 * ugyanaz az adat, mint a Control Plane → App Registry, csak agentre szűrve.
 * A "Megnyitás" mindig friss, rövid életű preview linket kér (nem a chatben
 * korábban kapott, azóta lejárt tokent használja újra).
 */
function AgentSandboxApps({ apps }: { apps: AgentSandboxAppSummary[] }) {
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleOpen = (appId: string) => {
    setError(null)
    setOpeningId(appId)
    getSandboxAppPreviewUrl({ appId })
      .then((res) => {
        if (!res.success) {
          setError(res.error)
          return
        }
        window.open(res.data.previewUrl, '_blank', 'noopener,noreferrer')
      })
      .finally(() => setOpeningId(null))
  }

  if (apps.length === 0) return null

  return (
    <Card title={`Sandbox appok (${apps.length})`}>
      <p className="mb-3 text-sm text-ink-soft">
        Ezeket az önálló, böngészőben megnyitható riportokat/mini-appokat az agent hozta létre. Ugyanez a
        lista bővebben a{' '}
        <Link href="/control-plane/apps" className="text-coral hover:underline">
          App Registry-ben
        </Link>{' '}
        is elérhető.
      </p>
      {error && (
        <p className="mb-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {apps.map((app) => (
          <li
            key={app.appId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{app.name}</span>
                <Badge tone={appStatusTone(app.status)}>{app.status}</Badge>
                {app.activeVersion !== undefined && (
                  <span className="text-xs text-ink-faint">v{app.activeVersion}</span>
                )}
              </div>
              {app.description && (
                <p className="mt-0.5 truncate text-xs text-ink-faint">{app.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleOpen(app.appId)}
              disabled={openingId === app.appId}
              className="shrink-0 rounded-full bg-sage/20 px-4 py-1.5 text-xs font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
            >
              {openingId === app.appId ? 'Megnyitás…' : 'Megnyitás →'}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function SandboxHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="animate-rise">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">{eyebrow}</p>
      <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">{title}</h1>
      <p className="mt-2 max-w-xl text-ink-soft">{description}</p>
    </div>
  )
}

function WikiSandbox({ agent, apps }: { agent: AgentSummary; apps: AgentSandboxAppSummary[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploadPending, startUpload] = useTransition()
  const [question, setQuestion] = useState(SAMPLE_QUESTION)
  const [message, setMessage] = useState<string | null>(null)
  const [lastAnswer, setLastAnswer] = useState<{
    conversationId: string
    answer: string
    confidence: string
  } | null>(null)
  const [promotePending, setPromotePending] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [kbDocs, setKbDocs] = useState<KbDocument[]>([])
  const [textInput, setTextInput] = useState('')
  const [reportTemplates, setReportTemplates] = useState<ReportTemplateOption[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [reportPending, setReportPending] = useState(false)
  const [reportMessage, setReportMessage] = useState<string | null>(null)
  const [reportTicketId, setReportTicketId] = useState<string | null>(null)

  useEffect(() => {
    refreshDocs(agent.id)
  }, [agent.id])

  useEffect(() => {
    listReportTemplatesAction().then((res) => {
      if (res.success) {
        const templates = res.data as ReportTemplateOption[]
        setReportTemplates(templates)
        setSelectedTemplate((prev) => prev || templates[0]?.id || '')
      }
    })
  }, [])

  const generateReportFlow = () => {
    if (!selectedTemplate) return
    setReportMessage(null)
    setReportTicketId(null)
    setReportPending(true)
    generateReport({ agentId: agent.id, templateId: selectedTemplate })
      .then((res) => {
        if (!res.success) {
          setReportMessage(res.error)
          return
        }
        const ticketId = (res.data as { ticketId: string }).ticketId
        setReportTicketId(ticketId)
        setReportMessage('Riport-ticket létrehozva — a dispatcher a tudásbázisból generálja.')
      })
      .finally(() => setReportPending(false))
  }

  function refreshDocs(id: string) {
    listDocumentsForAgent({ agentId: id }).then((res) => {
      if (res.success) setKbDocs(res.data as KbDocument[])
    })
  }

  const handleUpload = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setUploadMessage(null)

    const form = e.currentTarget
    const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')
    const file = fileInput?.files?.[0]

    startUpload(async () => {
      const fd = new FormData()
      if (textInput.trim()) {
        fd.append('text', textInput)
      } else if (file) {
        fd.append('file', file)
      } else {
        setUploadMessage('Nincs feltöltendő fájl vagy szöveg.')
        return
      }

      const uploadRes = await uploadDocument(fd)
      if (!uploadRes.success) {
        setUploadMessage(uploadRes.error)
        return
      }

      const processRes = await processDocumentForWiki({
        documentId: (uploadRes.data as { id: string }).id,
        agentId: agent.id,
      })
      if (!processRes.success) {
        setUploadMessage(processRes.error)
        return
      }

      setUploadMessage(`Feltöltve és hozzáadva a tudásbázishoz: ${file?.name ?? 'szöveg'}`)
      setTextInput('')
      if (fileInput) fileInput.value = ''
      refreshDocs(agent.id)
    })
  }

  const runFlow = () => {
    setMessage(null)
    setLastAnswer(null)
    startTransition(async () => {
      const answerRes = await askWiki({
        agentId: agent.id,
        question,
      })
      if (!answerRes.success) {
        setMessage(answerRes.error)
        return
      }

      const data = answerRes.data as {
        conversationId: string
        answer: { answer: string; confidence: string }
      }

      setLastAnswer({
        conversationId: data.conversationId,
        answer: data.answer.answer,
        confidence: data.answer.confidence,
      })
      setMessage('Válasz kész — ticket nélkül, beszélgetésben.')
    })
  }

  const sendForApproval = () => {
    if (!lastAnswer) return
    setPromotePending(true)
    promoteToTicket({ conversationId: lastAnswer.conversationId, reason: 'approval' })
      .then((res) => {
        if (!res.success) {
          setMessage(res.error)
          return
        }
        const ticketId = (res.data as { ticketId: string }).ticketId
        router.push(`/sandbox/proposals/${ticketId}`)
      })
      .finally(() => setPromotePending(false))
  }

  return (
    <div className="space-y-6">
      <SandboxHeader
        eyebrow="Wiki sandbox"
        title={`${agent.name} tudásbázis`}
        description="Tölts fel dokumentumokat ehhez az agenthez, majd kérdezz rájuk. A válasz beszélgetésben jön — ticket csak jóváhagyásra küldéskor."
      />

      <AgentSandboxApps apps={apps} />

      <Card title="Tudásbázis feltöltés">
        <form onSubmit={handleUpload} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Fájl (.txt, .md, .csv, .xlsx, .docx, .pdf)</label>
            <input
              type="file"
              accept=".txt,.md,.csv,.json,.xlsx,.xlsm,.docx,.pdf"
              className="w-full text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-sage/20 file:px-4 file:py-1.5 file:text-xs file:font-semibold file:text-sage"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">
              Vagy illessz be szöveget közvetlenül
            </label>
            <textarea
              className="w-full rounded-xl border border-line bg-night-2 p-3 font-mono text-sm text-ink focus:border-coral/50 focus:outline-none"
              rows={4}
              placeholder="Ide illeszt be szöveget..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={uploadPending}
            className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            {uploadPending ? 'Feltöltés...' : '+ Hozzáadás a tudásbázishoz'}
          </button>
          {uploadMessage && <p className="text-sm text-ink-soft">{uploadMessage}</p>}
        </form>

        {kbDocs.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-widest text-ink-faint">
              Tudásbázisban ({kbDocs.length} dokumentum)
            </p>
            <ul className="space-y-1">
              {kbDocs.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2 text-sm text-ink-soft">
                  <span className="h-1.5 w-1.5 rounded-full bg-sage" />
                  {doc.filename}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Wiki-kérdés">
        <textarea
          className="mb-4 w-full rounded-xl border border-line bg-night-2 p-4 font-mono text-sm text-ink focus:border-coral/50 focus:outline-none"
          rows={6}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="button"
          disabled={pending}
          onClick={runFlow}
          className="rounded-full bg-sage px-6 py-3 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {pending ? 'Válasz készül...' : 'Kérdés indítása'}
        </button>
        {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
        {lastAnswer && (
          <div className="mt-4 space-y-3 rounded-xl border border-line bg-night-2 p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">Agent válasz</p>
            <p className="text-sm leading-relaxed text-ink">{lastAnswer.answer}</p>
            <p className="text-xs text-ink-soft">Bizalom: {lastAnswer.confidence}</p>
            <button
              type="button"
              disabled={promotePending}
              onClick={sendForApproval}
              className="rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
            >
              {promotePending ? 'Küldés...' : 'Jóváhagyásra küldés (ticket)'}
            </button>
          </div>
        )}
      </Card>

      <Card title="Riport generálása">
        <p className="mb-3 text-sm text-ink-soft">
          Előre definiált sablonból riport-ticket készül. Az agent a tudásbázisból (kb_search), a két
          átjárón át, citáltan állítja elő — a riport a boardon és az auditban jelenik meg.
        </p>
        <div className="space-y-3">
          <select
            className="w-full rounded-xl border border-line bg-night-2 p-3 text-sm text-ink focus:border-coral/50 focus:outline-none"
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
          >
            {reportTemplates.length === 0 && <option value="">Nincs elérhető sablon</option>}
            {reportTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {selectedTemplate && (
            <p className="text-xs text-ink-faint">
              {reportTemplates.find((t) => t.id === selectedTemplate)?.description}
            </p>
          )}
          <button
            type="button"
            disabled={reportPending || !selectedTemplate}
            onClick={generateReportFlow}
            className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            {reportPending ? 'Riport indítása...' : 'Riport generálása'}
          </button>
          {reportMessage && <p className="text-sm text-ink-soft">{reportMessage}</p>}
          {reportTicketId && (
            <Link
              href={`/sandbox/proposals/${reportTicketId}`}
              className="inline-block text-sm text-coral hover:underline"
            >
              Riport-ticket megnyitása →
            </Link>
          )}
        </div>
      </Card>

      <Card title="Board">
        <p className="text-sm text-ink-soft">
          Az alap kérdés→válasz beszélgetésben fut ticket nélkül. Ha jóváhagyásra küldöd, abból ticket
          keletkezik a boardon.
        </p>
        <Link href="/control-plane/board" className="mt-3 inline-block text-sm text-coral hover:underline">
          Board megnyitása
        </Link>
      </Card>
    </div>
  )
}

function BookkeeperSandbox({ agent, apps }: { agent: AgentSummary; apps: AgentSandboxAppSummary[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [invoiceText, setInvoiceText] = useState(SAMPLE_INVOICE)

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setMessage(null)

    const form = e.currentTarget
    const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')
    const file = fileInput?.files?.[0]

    startTransition(async () => {
      const fd = new FormData()
      if (invoiceText.trim()) {
        fd.append('text', invoiceText)
      } else if (file) {
        fd.append('file', file)
      } else {
        setMessage('Nincs feldolgozható számla vagy szöveg.')
        return
      }

      const uploadRes = await uploadDocument(fd)
      if (!uploadRes.success) {
        setMessage(uploadRes.error)
        return
      }

      const processRes = await processDocument({
        documentId: (uploadRes.data as { id: string }).id,
        agentId: agent.id,
      })
      if (!processRes.success) {
        setMessage(processRes.error)
        return
      }

      setMessage(`Könyvelési ticket létrejött: ${processRes.data.ticketId}`)
      router.push(`/sandbox/proposals/${processRes.data.ticketId}`)
    })
  }

  return (
    <div className="space-y-6">
      <SandboxHeader
        eyebrow="Könyvelő sandbox"
        title={`${agent.name} számlafeldolgozás`}
        description="Tölts fel számlaszöveget vagy fájlt. Az agent mezőket nyer ki, könyvelési javaslatot készít, majd jóváhagyási ticketet hoz létre."
      />

      <AgentSandboxApps apps={apps} />

      <Card title="Számla feldolgozás">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Számlafájl (.txt, .md, .csv)</label>
            <input
              type="file"
              accept=".txt,.md,.csv"
              className="w-full text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-honey/20 file:px-4 file:py-1.5 file:text-xs file:font-semibold file:text-honey"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">
              Vagy illeszd be a számla szövegét
            </label>
            <textarea
              className="w-full rounded-xl border border-line bg-night-2 p-4 font-mono text-sm text-ink focus:border-coral/50 focus:outline-none"
              rows={9}
              value={invoiceText}
              onChange={(e) => setInvoiceText(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-honey px-6 py-3 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(176,125,36,0.7)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {pending ? 'Feldolgozás...' : 'Számla feldolgozása'}
          </button>
          {message && <p className="text-sm text-ink-soft">{message}</p>}
        </form>
      </Card>

      <Card title="Jóváhagyás">
        <p className="text-sm text-ink-soft">
          A könyvelési javaslat nem zárul automatikusan: a ticket emberi jóváhagyásra kerül a Control
          Plane boardon.
        </p>
        <Link href="/control-plane/board" className="mt-3 inline-block text-sm text-coral hover:underline">
          Board megnyitása
        </Link>
      </Card>
    </div>
  )
}
