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
      <div>
        <h1 className="font-display text-3xl font-semibold">Könyvelő munkatér</h1>
        <p className="mt-1 text-ink-soft">Szöveg/PDF-text feltöltés → valódi Gemini hívás</p>
      </div>

      <Card title="Dokumentum (szöveg)">
        <textarea
          className="mb-4 w-full rounded-lg border border-line bg-night-2 p-4 font-mono text-sm"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          disabled={pending}
          onClick={runFlow}
          className="rounded-full bg-sage/25 px-6 py-3 text-sm font-semibold text-sage hover:bg-sage/35 disabled:opacity-50"
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
