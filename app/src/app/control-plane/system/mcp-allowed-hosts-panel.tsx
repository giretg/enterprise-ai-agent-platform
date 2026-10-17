'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setMcpHostAllowed } from '@/app/actions/mcp-connectors'

/** #395 D8: mely külső MCP-szolgáltatókhoz köthetnek a cégek connectort. */
export function McpAllowedHostsPanel({ initial, canEdit }: { initial: string[]; canEdit: boolean }) {
  const [hosts, setHosts] = useState(initial)
  const [host, setHost] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function change(target: string, allowed: boolean) {
    if (!allowed && !window.confirm(`Visszavonod: ${target}? Az erre épülő kapcsolatok azonnal leállnak.`)) return
    setError(null)
    startTransition(async () => {
      const res = await setMcpHostAllowed({ host: target, allowed })
      if (res.success) {
        setHosts(res.data.hosts)
        setHost('')
      } else setError(res.error)
    })
  }

  return (
    <Card title="Engedélyezett MCP-szolgáltatók">
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          A cégek csak az itt felsorolt domainekre csatolhatnak külső MCP-szervert. Egy új szolgáltató új adatkimeneti
          cél — engedélyezés előtt nézd meg, ki üzemelteti. Ha a szolgáltató bejelentkezése más domainen fut (pl.
          auth.example.com), azt is vedd fel. A visszavonás azonnal leállítja a ráépülő kapcsolatokat.
        </p>
        {hosts.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs engedélyezett szolgáltató.</p>
        ) : (
          <ul className="space-y-1">
            {hosts.map((item) => (
              <li key={item} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-sm">
                <code>{item}</code>
                {canEdit ? (
                  <button type="button" className="text-xs text-coral-deep" disabled={pending} onClick={() => change(item, false)}>
                    Visszavonás
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <div className="flex gap-2">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="pl. mcp.example.com"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            />
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={pending || !host.trim()}
              onClick={() => change(host, true)}
            >
              Engedélyezés
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Szerkeszteni csak superadmin tud.</p>
        )}
        {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
      </div>
    </Card>
  )
}
