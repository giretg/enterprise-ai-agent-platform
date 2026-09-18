'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createPlaybookV2 } from '@/app/actions/playbook'
import { PlaybookAuthorPanel } from '@/components/playbooks/playbook-author-panel'

export type PlaybookListView = {
  id: string
  key: string
  name: string
  processType: string
  status: string
  versionCount: number
  updatedAt: string
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-ink/8 text-ink-soft',
  published: 'bg-sage/15 text-sage',
  archived: 'bg-ink/8 text-ink-soft',
  blocked: 'bg-coral/15 text-coral',
}

export function PlaybookRegistry({
  playbooks,
  canEdit,
}: {
  playbooks: PlaybookListView[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ key: '', name: '', processType: '', description: '' })
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function create() {
    setMessage(null)
    startTransition(async () => {
      const res = await createPlaybookV2(form)
      if (res.success) {
        setOpen(false)
        setForm({ key: '', name: '', processType: '', description: '' })
        router.push(`/control-plane/playbooks/${res.data.id}`)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-4">
      {canEdit && <PlaybookAuthorPanel />}
      {canEdit && (
        <div className="atelier-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Új Playbook</h2>
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm"
            >
              {open ? 'Mégse' : '+ Létrehozás'}
            </button>
          </div>
          {open && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-ink-soft">Kulcs (stabil azonosító)</span>
                <input
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  placeholder="invoice-processing"
                  className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-ink-soft">Folyamattípus</span>
                <input
                  value={form.processType}
                  onChange={(e) => setForm({ ...form, processType: e.target.value })}
                  placeholder="invoice_processing"
                  className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-ink-soft">Név</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Bejövő számla feldolgozás"
                  className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-ink-soft">Leírás (opcionális)</span>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                />
              </label>
              {message && <p className="text-sm text-coral sm:col-span-2">{message.text}</p>}
              <button
                onClick={create}
                disabled={pending}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2 sm:w-fit"
              >
                {pending ? 'Létrehozás…' : 'Playbook létrehozása'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Playbookok</h2>
        <ul className="divide-y divide-ink/8">
          {playbooks.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <Link href={`/control-plane/playbooks/${p.id}`} className="group">
                <span className="font-medium group-hover:text-accent">{p.name}</span>
                <span className="ml-2 font-mono text-xs text-ink-soft">{p.key}</span>
                <span className="ml-2 text-xs text-ink-soft">· {p.versionCount} verzió</span>
              </Link>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-ink-soft">{p.processType}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    STATUS_TONE[p.status] ?? 'bg-ink/8 text-ink-soft'
                  }`}
                >
                  {p.status}
                </span>
              </div>
            </li>
          ))}
          {playbooks.length === 0 && <li className="py-3 text-sm text-ink-soft">Még nincs Playbook.</li>}
        </ul>
      </div>
    </div>
  )
}
