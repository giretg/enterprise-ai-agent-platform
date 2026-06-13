'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { listAgents, processDocument, uploadDocument } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

const SAMPLE_INVOICE = `SZÁMLA
Szállító: AgroParts Kft.
Számlaszám: AP-2026-0042
Dátum: 2026-06-10
Nettó összeg: 125 000 Ft
ÁFA (27%): 33 750 Ft
Bruttó: 158 750 Ft
Tétel: Traktorkerék abroncs 420/85R28 — 2 db`

export default function WorkspacePage() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [text, setText] = useState(SAMPLE_INVOICE)
  const [message, setMessage] = useState<string | null>(null)

  const runFlow = () => {
    setMessage(null)
    startTransition(async () => {
      const agentsRes = await listAgents()
      if (!agentsRes.success) {
        setMessage(agentsRes.error)
        return
      }
      const agent = agentsRes.data.find((a) => a.name === 'Könyvelő Agent') ?? agentsRes.data[0]
      if (!agent) {
        setMessage('Nincs agent — npm run db:seed')
        return
      }

      const formData = new FormData()
      formData.set('text', text)
      const uploadRes = await uploadDocument(formData)
      if (!uploadRes.success) {
        setMessage(uploadRes.error)
        return
      }

      const processRes = await processDocument({
        documentId: uploadRes.data.id,
        agentId: agent.id,
      })
      if (!processRes.success) {
        setMessage(processRes.error)
        return
      }

      setMessage(`Ticket létrejött: ${processRes.data.ticketId}`)
      router.push(`/sandbox/proposals/${processRes.data.ticketId}`)
    })
  }

  return (
    <div className="space-y-6">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">A présház</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Add ide Borinak az első számlát
        </h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          Illeszd be a számla szövegét, a könyvelő munkatárs pedig pillanatok alatt elkészíti
          a könyvelési javaslatot — amit aztán a Pincében nyugodtan átnézhetsz.
        </p>
      </div>

      <Card title="Dokumentum (szöveg)">
        <textarea
          className="mb-4 w-full rounded-xl border border-line bg-night-2 p-4 font-mono text-sm text-ink focus:border-coral/50 focus:outline-none"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          disabled={pending}
          onClick={runFlow}
          className="rounded-full bg-sage px-6 py-3 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {pending ? 'Feldolgozás…' : 'Feldolgozás indítása'}
        </button>
        {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
      </Card>

      <Card title="Mintafájl">
        <p className="text-sm text-ink-soft">
          A fenti minta számla az AgroParts szabály tesztelésére szolgál. A javaslat ticketként
          kerül a Control Plane-re.
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
