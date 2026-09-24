'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Card } from '@/components/ui/shell'
import { MCP_SETUP_SEEN_COOKIE, type McpClientSetup } from '@/lib/mcp-client-setup'

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
      className="shrink-0 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
    >
      {copied ? 'Másolva ✓' : label}
    </button>
  )
}

function CodeBlock({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-card-2/60 p-2 sm:flex-row sm:items-center">
      <pre className="min-w-0 flex-1 overflow-x-auto px-2 py-1 font-mono text-xs leading-relaxed text-ink">
        {value}
      </pre>
      <CopyButton value={value} label={copyLabel} />
    </div>
  )
}

function ClientCard({
  name,
  description,
  logo,
  logoBackground,
  children,
}: {
  name: string
  description: string
  logo: string
  logoBackground: string
  children: ReactNode
}) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-line bg-card shadow-sm transition-colors hover:border-coral/35 open:border-coral/40">
      <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${logoBackground}`}>
          <Image src={logo} alt="" width={28} height={28} className="size-7 object-contain" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-ink">{name}</span>
          <span className="block text-sm text-ink-soft">{description}</span>
        </span>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180">
          <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="space-y-3 border-t border-line bg-card-2/35 px-4 py-4 text-sm leading-relaxed text-ink-soft sm:px-5 sm:py-5">
        {children}
      </div>
    </details>
  )
}

export function McpSetupLanding({ setup, continueHref }: { setup: McpClientSetup; continueHref: string }) {
  useEffect(() => {
    markSetupSeen()
  }, [])

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-8">
      <header className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-coral">Első lépések</p>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-tight sm:text-4xl">
          Dolgozz a kedvenc AI-eszközödben
        </h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft">
          Kapcsold össze a platformot Codexszel, Cursorral, Grokkal, Claude-dal vagy Goose-szal.
          Válaszd ki az alkalmazásodat, és kövesd a rövid telepítési lépéseket.
        </p>
      </header>

      <section aria-labelledby="install-title" className="space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-coral">01 / Csatlakozás</p>
          <h2 id="install-title" className="mt-1 font-display text-2xl font-semibold">Telepítsd az MCP-szervert</h2>
          <p className="mt-1 text-sm text-ink-soft">Ugyanazt a szervercímet használhatod mindegyik alkalmazásban.</p>
        </div>

        <div className="atelier-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">A szervezeted MCP-címe</p>
            <p className="mt-1 break-all font-mono text-sm text-ink">{setup.mcpUrl}</p>
          </div>
          <CopyButton value={setup.mcpUrl} label="URL másolása" />
        </div>

        <div className="space-y-3">
          <ClientCard name="Codex" description="Terminálból, egy paranccsal" logo="/mcp-clients/codex.svg" logoBackground="bg-[#e6eee9]">
            <p>Másold be a parancsot a terminálba. Megnyílik a böngészős belépés; ugyanazzal a fiókkal lépj be, amellyel itt vagy.</p>
            <CodeBlock value={setup.codexCommand} copyLabel="Parancs másolása" />
          </ClientCard>

          <ClientCard name="Cursor" description="Telepítés egy kattintással" logo="/mcp-clients/cursor.svg" logoBackground="bg-[#eeece8]">
            <p>A gomb megnyitja a Cursort, és felajánlja a szerver telepítését. Ezután jelentkezz be a böngészőben.</p>
            <a href={setup.cursorInstallHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2.5 font-semibold text-white transition-colors hover:bg-coral-deep">
              Telepítés Cursorba <span aria-hidden="true">→</span>
            </a>
            <p className="text-xs text-ink-faint">Ha a gomb nem működik, a fenti MCP-címet kézzel is felveheted a Cursor beállításaiban.</p>
          </ClientCard>

          <ClientCard name="Grok Build CLI" description="Terminálból, egy paranccsal" logo="/mcp-clients/grok.svg" logoBackground="bg-[#eeebf4]">
            <p>Másold be a parancsot a terminálba. Az első csatlakozáskor a böngészőben lépj be a platformos fiókoddal.</p>
            <CodeBlock value={setup.grokCommand} copyLabel="Parancs másolása" />
            <p className="text-xs text-ink-faint">A Grokban a <span className="font-mono text-ink">/mcps</span> → szerver → <span className="font-mono text-ink">i</span> útvonalon is megnyithatod a belépést.</p>
          </ClientCard>

          <ClientCard name="Claude Desktop" description="Csatlakozó felvétele az alkalmazásban" logo="/mcp-clients/claude.svg" logoBackground="bg-[#f8ede5]">
            <p>Nyisd meg a <span className="font-medium text-ink">Settings → Connectors → Add custom connector</span> menüt. Névnek írd be: <span className="font-mono text-ink">{setup.serverName}</span>, URL-nek pedig másold be:</p>
            <CodeBlock value={setup.mcpUrl} copyLabel="URL másolása" />
            <p>Ezután jelentkezz be ugyanazzal a fiókkal, amellyel itt vagy.</p>
          </ClientCard>

          <ClientCard name="Claude Code" description="Terminálból, egy paranccsal" logo="/mcp-clients/claudecode.svg" logoBackground="bg-[#f8ede5]">
            <p>Másold be a parancsot a terminálba, majd a Claude Code-ban végezd el a felkínált bejelentkezést.</p>
            <CodeBlock value={setup.claudeCommand} copyLabel="Parancs másolása" />
            <p className="text-xs text-ink-faint">Ez a parancs a Claude Code-hoz szól. A Claude Desktophoz a fenti külön útmutatót használd.</p>
          </ClientCard>

          <ClientCard name="Goose Desktop" description="Távoli MCP-bővítmény az alkalmazásban" logo="/mcp-clients/goose.svg" logoBackground="bg-[#e7eff1]">
            <ol className="list-decimal space-y-1 pl-5">
              <li>Nyisd meg a Goose oldalsávját, majd válaszd az <span className="font-medium text-ink">Extensions → Add custom extension</span> menüt.</li>
              <li>Típusnak válaszd a <span className="font-medium text-ink">Streamable HTTP</span> távoli bővítményt.</li>
              <li>Azonosítóként add meg: <span className="font-mono text-ink">{setup.serverName}</span>; névnek: <span className="font-medium text-ink">Excellence AI</span>. A szerver URL-je:</li>
            </ol>
            <CodeBlock value={setup.mcpUrl} copyLabel="URL másolása" />
            <p>Kattints az <span className="font-medium text-ink">Add</span> gombra, majd a megnyíló böngészőben jelentkezz be a platformos fiókoddal.</p>
          </ClientCard>
        </div>
      </section>

      <Card className="p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-coral">02 / Első próba</p>
        <h2 className="mt-1 font-display text-2xl font-semibold">Kezdj el dolgozni</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Nyisd meg az összekapcsolt AI-eszközt, és kérdezd meg: <em className="text-ink">„Ki vagyok, és milyen AI-munkatársaim vannak?”</em>
          {' '}Ha megjelennek a munkatársaid, a kapcsolat működik.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Link href={continueHref} onClick={markSetupSeen} className="inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-coral-deep">
          Tovább a munkatársakhoz <span aria-hidden="true">→</span>
        </Link>
        <p className="text-sm text-ink-faint">Ezt az oldalt a fejlécből bármikor újra megnyithatod.</p>
      </div>
    </div>
  )
}
