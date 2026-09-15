'use client'

import { useState } from 'react'

/**
 * Az agent azonosítóját vágólapra másoló gomb a fejléc-kártya actions-sorába.
 * A beágyazott chat (`/embed/agents/<agentId>`) bekötéséhez kell: a CRM-fejlesztő
 * innen veszi az URL-be írandó ID-t, nem a címsorból kell kivadásznia.
 */
export function AgentIdCopyButton({ agentId }: { agentId: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(agentId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="A beágyazott chat URL-jéhez kell: /embed/agents/<agent-azonosító>?app=…&thread=…"
      className="rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
    >
      {copied ? 'Másolva ✓' : 'Agent-azonosító másolása'}
    </button>
  )
}
