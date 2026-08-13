'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateAgentAvatar } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'

const MAX_INPUT_BYTES = 8 * 1024 * 1024 // 8 MB nyers fájl felső korlát
const OUTPUT_SIZE = 256 // px, négyzetes portré

// A böngészőben kicsinyítjük az avatárt 256px-es négyzetre és webp/jpeg data
// URL-t készítünk, hogy a DB-be mentett kép garantáltan kicsi maradjon.
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('A kép nem tölthető be'))
      el.src = objectUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('A vászon nem elérhető')

    // Cover-illesztés: a rövidebb oldalra vágunk, hogy ne torzuljon.
    const scale = Math.max(OUTPUT_SIZE / img.width, OUTPUT_SIZE / img.height)
    const drawW = img.width * scale
    const drawH = img.height * scale
    const dx = (OUTPUT_SIZE - drawW) / 2
    const dy = (OUTPUT_SIZE - drawH) / 2
    ctx.drawImage(img, dx, dy, drawW, drawH)

    const webp = canvas.toDataURL('image/webp', 0.85)
    if (webp.startsWith('data:image/webp')) return webp
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function AgentAvatarUpload({
  agentId,
  name,
  status,
  avatarUrl,
  personaNickname,
  bare = false,
}: {
  agentId: string
  name: string
  status: string
  avatarUrl: string | null
  personaNickname?: string | null
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(avatarUrl)

  function save(dataUrl: string) {
    startTransition(async () => {
      setError(null)
      const res = await updateAgentAvatar({ agentId, avatarUrl: dataUrl })
      if (res.success) {
        setPreview(res.data.avatarUrl)
        router.refresh()
      } else {
        setError(res.error)
        setPreview(avatarUrl)
      }
    })
  }

  async function onFile(file: File) {
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError('Csak képfájlt tölthetsz fel')
      return
    }
    if (file.size > MAX_INPUT_BYTES) {
      setError('A kép túl nagy (max. 8 MB)')
      return
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      setPreview(dataUrl)
      save(dataUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A kép feldolgozása nem sikerült')
    }
  }

  const body = (
    <>
      <p className="mb-4 text-xs text-ink-faint">
        Tölts fel portrét az agentnek. A kép automatikusan négyzetre igazodik. Ha
        törlöd, visszaáll a színes emoji-arc.
      </p>
      <div className="flex items-center gap-5">
        <AgentAvatar
          name={name}
          status={status}
          size="lg"
          avatarUrl={preview}
          personaNickname={personaNickname}
        />
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onFile(file)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
            className="rounded-full bg-sky/20 px-5 py-2 text-sm font-semibold text-sky disabled:opacity-50"
          >
            {pending ? 'Mentés...' : preview ? 'Kép cseréje' : 'Kép feltöltése'}
          </button>
          {preview && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPreview(null)
                save('')
              }}
              className="rounded-full border border-line px-5 py-2 text-sm font-semibold text-ink-soft transition-colors hover:text-coral disabled:opacity-50"
            >
              Kép törlése
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-coral">{error}</p>}
    </>
  )

  if (bare) return body
  return <Card title="Avatár">{body}</Card>
}
