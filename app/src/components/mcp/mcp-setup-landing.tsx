'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/shell'
import {
  MCP_SETUP_SEEN_COOKIE,
  type McpClientSetup,
} from '@/lib/mcp-client-setup'

function markSetupSeen() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${MCP_SETUP_SEEN_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
    >
      {copied ? 'Másolva ✓' : label}
    </button>
  )
}

function CodeBlock({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card-2/60">
      <div className="flex items-center justify-end border-b border-line px-3 py-2">
        <CopyButton value={value} label={copyLabel} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-ink">
        {value}
      </pre>
    </div>
  )
}

export function McpSetupLanding({
  setup,
  continueHref,
}: {
  setup: McpClientSetup
  continueHref: string
}) {
  useEffect(() => {
    markSetupSeen()
  }, [])

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Első lépések</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Kösd be az AI-eszközödet</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          A platform nem egy külön chat. Codexből, Cursorból, Grok Buildből vagy Claude Code-ból
          éred el a céges munkatársakat — egyszer telepíted az MCP-t, utána ugyanott dolgozol,
          ahol eddig.
        </p>
      </header>

      <Card title="1. Telepítsd az MCP-t">
        <p className="text-sm text-ink-soft">
          A szervezeted címe:{' '}
          <span className="font-mono text-[12px] text-ink">{setup.mcpUrl}</span>
        </p>
        <div className="mt-2">
          <CopyButton value={setup.mcpUrl} label="URL másolása" />
        </div>

        <div className="mt-6 space-y-5">
          <section>
            <h3 className="font-semibold text-ink">Codex — egy parancs</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Másold be a terminálba. A második fele megnyitja a belépőt: ugyanazzal a fiókkal
              lépj be, amivel itt vagy.
            </p>
            <div className="mt-3">
              <CodeBlock value={setup.codexCommand} copyLabel="Parancs másolása" />
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-ink">Cursor — egy kattintás</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Megnyitja a Cursort, és felajánlja a szerver telepítését. Utána a Clerk-belépő
              ugyanaz, mint a weben.
            </p>
            <a
              href={setup.cursorInstallHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coral-deep"
            >
              Telepítés Cursorba
              <span aria-hidden>→</span>
            </a>
            <p className="mt-2 text-xs text-ink-faint">
              Ha a gomb nem nyitná meg a Cursort, másold az URL-t:{" "}
              <span className="break-all font-mono text-[11px] text-ink-soft">{setup.mcpUrl}</span>
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-ink">Grok Build CLI</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Másold be a terminálba. Az első csatlakozáskor a böngészőben ugyanazzal a fiókkal
              lépj be, amivel itt vagy (<span className="font-mono text-ink">/mcps</span> →
              szerver → <span className="font-mono text-ink">i</span> is megnyitja).
            </p>
            <div className="mt-3">
              <CodeBlock value={setup.grokCommand} copyLabel="Parancs másolása" />
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-ink">Claude Code</h3>
            <div className="mt-3">
              <CodeBlock value={setup.claudeCommand} copyLabel="Parancs másolása" />
            </div>
          </section>
        </div>
      </Card>

      <Card title="2. Kezdd el Codexből">
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-ink-soft">
          <li>
            Nyisd meg a Codexet (CLI: <span className="font-mono text-ink">codex</span>, vagy a
            desktop app).
          </li>
          <li>
            Írd be: <span className="font-mono text-ink">/mcp</span> — látnod kell a{' '}
            <span className="font-mono text-ink">{setup.serverName}</span> szervert és a
            toolokat.
          </li>
          <li>
            Próbáld ki: <em>„Ki vagyok, és milyen munkatársaim vannak?”</em> — a Codex a{' '}
            <span className="font-mono text-ink">platform.whoami</span> és{' '}
            <span className="font-mono text-ink">platform.agents.list</span> toolokkal válaszol.
          </li>
          <li>
            Egy munkatársat helyi mappába: <em>„Csekkolj ki egy agentet.”</em> — ez a{' '}
            <span className="font-mono text-ink">platform.agent.checkout</span>.
          </li>
        </ol>
        <p className="mt-4 text-sm text-ink-faint">
          A ChatGPT desktop és a Codex IDE-bővítmény ugyanazt a konfigurációt használja, mint a
          CLI. Ha a login már lefutott, ott is megjelenik.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={continueHref}
          onClick={markSetupSeen}
          className="inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-coral-deep"
        >
          Tovább a munkatársakhoz
          <span aria-hidden>→</span>
        </Link>
        <p className="text-sm text-ink-faint">Ezt az oldalt a fejlécből bármikor vissza tudod nyitni.</p>
      </div>
    </div>
  )
}
