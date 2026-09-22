'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { publishAgentDefinitionAction } from '@/app/actions/platform'

/**
 * Akkor jelenik meg, ha a vázlat eltér a közzétett verziótól.
 * Ugyanolyan pill, mint az azonosító-másoló, de figyelmeztet: kattintásra
 * közzéteszi az új verziót, hogy az MCP ne a régit lássa.
 */
export function PublishStaleDraftButton({
  agentId,
  publishedVersion,
}: {
  agentId: string
  publishedVersion: number | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const versionLabel = publishedVersion !== null ? ` (v${publishedVersion})` : ''

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        title={`A vázlat megváltozott a közzétett verzió${versionLabel} óta — az MCP még a régit látja. Kattints, és az új verzió életbe lép.`}
        className="rounded-full border border-amber-600/50 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-amber-700 hover:bg-amber-500/25 disabled:opacity-60"
        onClick={() => {
          start(async () => {
            setError(null)
            const result = await publishAgentDefinitionAction({ agentId })
            if (!result.success) {
              setError(result.error)
              return
            }
            router.refresh()
          })
        }}
      >
        {pending ? 'Közzététel…' : 'Új verzió közzététele'}
      </button>
      {error ? <span className="text-xs text-coral-deep">{error}</span> : null}
    </span>
  )
}
