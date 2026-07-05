'use client'

import { useRouter } from 'next/navigation'
import type { ProcessStatus } from '@prisma/client'
import { PROCESS_STATUS_CLASS, PROCESS_STATUS_LABELS } from '@/lib/process-labels'

/**
 * Playbook-folyamat badge ticketekhez: egyedi azonosító + a Folyamat állapotát tükröző szín.
 * Kattintásra a Folyamat részletek oldalra navigál. `stopPropagation`, mert a board kártyák
 * maguk is linkek/kattinthatók — a badge-nek nem szabad azt is kiváltania.
 */
export function ProcessBadge({
  processInstanceId,
  processType,
  status,
  className = '',
}: {
  processInstanceId: string
  processType: string
  status: ProcessStatus
  className?: string
}) {
  const router = useRouter()

  const navigate = () => router.push(`/control-plane/processes/${processInstanceId}`)

  return (
    <span
      role="link"
      tabIndex={0}
      title={`${processType} · ${PROCESS_STATUS_LABELS[status] ?? status} · ${processInstanceId}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        navigate()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        navigate()
      }}
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold transition hover:brightness-110 ${
        PROCESS_STATUS_CLASS[status] ?? 'bg-ink/8 text-ink-soft'
      } ${className}`}
    >
      ⚙ #{processInstanceId.slice(0, 8)}
    </span>
  )
}
