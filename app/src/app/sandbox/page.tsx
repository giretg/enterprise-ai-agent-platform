'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  askWiki,
  listAgents,
  listDocumentsForAgent,
  processDocumentForWiki,
  uploadDocument,
} from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

const SAMPLE_QUESTION = 'Mi az MVP célja, és milyen gatewayeken kell átmennie az agent műveleteinek?'

type KbDocument = { id: string; filename: string; status: string; createdAt: Date | string }

export default function WorkspacePage() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploadPending, startUpload] = useTransition()
  const [question, setQuestion] = useState(SAMPLE_QUESTION)
  const [message, setMessage] = useState<string | null>(null)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [kbDocs, setKbDocs] = useState<KbDocument[]>([])
  const [textInput, setTextInput] = useState('')

  useEffect(() => {
    listAgents().then((res) => {
      if (!res.success) return
      const agent = res.data.find((a) => a.name === 'Wiki Agent') ?? res.data[0]
      if (!agent) return
      setAgentId(agent.id)
      refreshDocs(agent.id)
    })
  }, [])

  function refreshDocs(id: string) {
    listDocumentsForAgent({ agentId: id }).then((res) => {
      if (res.success) setKbDocs(res.data as KbDocument[])
    })
  }

  const handleUpload = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!agentId) return
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
        agentId,
      })
      if (!processRes.success) {
        setUploadMessage(processRes.error)
        return
      }

      setUploadMessage(`Feltöltve és hozzáadva a tudásbázishoz: ${file?.name ?? 'szöveg'}`)
      setTextInput('')
      if (fileInput) fileInput.value = ''
      refreshDocs(agentId)
    })
  }

  const runFlow = () => {
    setMessage(null)
    startTransition(async () => {
      if (!agentId) {
        const agentsRes = await listAgents()
        if (!agentsRes.success) {
          setMessage(agentsRes.error)
          return
        }
        const agent = agentsRes.data.find((a) => a.name === 'Wiki Agent') ?? agentsRes.data[0]
        if (!agent) {
          setMessage('Nincs agent — npm run db:seed')
          return
        }
        setAgentId(agent.id)
      }

      const answerRes = await askWiki({
        agentId: agentId!,
        question,
      })
      if (!answerRes.success) {
        setMessage(answerRes.error)
        return
      }

      setMessage(`Ticket létrejött: ${answerRes.data.ticketId}`)
      router.push(`/sandbox/proposals/${answerRes.data.ticketId}`)
    })
  }

  return (
    <div className="space-y-6">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">Sandbox</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Wiki-agent tudásbázis
        </h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          Tölts fel dokumentumokat a tudásbázisba, majd kérdezz rájuk. Az agent citált választ ír
          vissza ticketként.
        </p>
      </div>

      <Card title="Tudásbázis feltöltés">
        <form onSubmit={handleUpload} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">
              Fájl (.txt, .md)
            </label>
            <input
              type="file"
              accept=".txt,.md,.csv"
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
              placeholder="Ide illeszt be szöveget…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={uploadPending || !agentId}
            className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            {uploadPending ? 'Feltöltés…' : '+ Hozzáadás a tudásbázishoz'}
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
          disabled={pending || !agentId}
          onClick={runFlow}
          className="rounded-full bg-sage px-6 py-3 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {pending ? 'Válasz készül…' : 'Kérdés indítása'}
        </button>
        {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
        {!agentId && (
          <p className="mt-2 text-xs text-coral">Nincs wiki agent — futtasd: npm run db:seed</p>
        )}
      </Card>

      <Card title="Board">
        <p className="text-sm text-ink-soft">
          A válasz ticketként jön létre. Magas bizalomnál automatikusan lezárul, egyébként emberi
          jóváhagyásra kerül.
        </p>
        <Link
          href="/control-plane/board"
          className="mt-3 inline-block text-sm text-coral hover:underline"
        >
          → Board megnyitása
        </Link>
      </Card>
    </div>
  )
}
