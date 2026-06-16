import { createHash } from 'crypto'
import type { SandboxAppWithLatestVersion, SandboxAppRepository, TicketRepository } from '@/repositories/interfaces'
import type { AuditRepository } from '@/repositories/interfaces'

type Actor = {
  userId: string
  tenantId: string | null
}

type SandboxAppView = {
  id: string
  name: string
  version: number
  htmlHash: string
  sourceTicketId: string
  createdAt: Date
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderSources(sources: unknown): string {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '<p class="muted">Nincs megadott forrás.</p>'
  }

  return `<ul>${sources
    .map((source) => {
      if (source && typeof source === 'object') {
        const item = source as Record<string, unknown>
        return `<li><strong>${escapeHtml(item.docId ?? 'source')}</strong><span>${escapeHtml(
          item.sectionRef ?? '',
        )}</span></li>`
      }
      return `<li><strong>${escapeHtml(source)}</strong></li>`
    })
    .join('')}</ul>`
}

function renderWikiReportHtml(params: {
  title: string
  question: string
  answer: string
  rationale: string
  confidence: string
  sources: unknown
}): string {
  const generatedAt = new Date().toISOString()
  return `<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: light; --ink: #18241f; --muted: #596b63; --line: #d8e0da; --sage: #5d8a4f; --paper: #fbfcf9; --wash: #eef4ec; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 860px; margin: 0 auto; padding: 48px 24px 64px; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 28px; }
    .eyebrow { margin: 0 0 10px; color: var(--sage); font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 34px; line-height: 1.08; letter-spacing: 0; }
    h2 { margin: 28px 0 10px; font-size: 16px; letter-spacing: 0; }
    p { line-height: 1.65; }
    .answer { border-left: 4px solid var(--sage); padding: 14px 18px; background: var(--wash); }
    .muted { color: var(--muted); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; color: var(--muted); font-size: 12px; font-weight: 700; }
    ul { padding-left: 20px; }
    li { margin: 9px 0; }
    li span { color: var(--muted); margin-left: 8px; }
    footer { margin-top: 40px; border-top: 1px solid var(--line); padding-top: 16px; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">A0 sandbox riport</p>
      <h1>${escapeHtml(params.title)}</h1>
      <div class="meta">
        <span class="pill">confidence: ${escapeHtml(params.confidence || 'unknown')}</span>
        <span class="pill">${escapeHtml(generatedAt)}</span>
      </div>
    </header>

    <section>
      <h2>Kérdés</h2>
      <p>${escapeHtml(params.question)}</p>
    </section>

    <section>
      <h2>Válasz</h2>
      <p class="answer">${escapeHtml(params.answer)}</p>
    </section>

    <section>
      <h2>Indoklás</h2>
      <p class="muted">${escapeHtml(params.rationale || 'Nincs külön indoklás.')}</p>
    </section>

    <section>
      <h2>Források</h2>
      ${renderSources(params.sources)}
    </section>

    <footer>
      Excellence AI Agent Platform MVP · single-file HTML export · sha256 hash a registryben
    </footer>
  </main>
</body>
</html>`
}

function toView(app: SandboxAppWithLatestVersion): SandboxAppView {
  const latest = app.versions[0]
  if (!latest) throw new Error('Sandbox app has no versions')
  return {
    id: app.id,
    name: app.name,
    version: latest.version,
    htmlHash: latest.htmlHash,
    sourceTicketId: latest.sourceTicketId,
    createdAt: latest.createdAt,
  }
}

export class SandboxAppService {
  constructor(
    private sandboxApps: SandboxAppRepository,
    private tickets: TicketRepository,
    private audit: AuditRepository,
  ) {}

  async createOrVersionWikiReport(ticketId: string, actor: Actor): Promise<SandboxAppView> {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.type !== 'interaction') throw new Error('Only interaction tickets can become A0 reports')

    const payload = ticket.payload as Record<string, unknown>
    if (typeof payload.answer !== 'string' || !payload.answer.trim()) {
      throw new Error('Ticket has no wiki answer payload')
    }

    const title = `Wiki-riport: ${ticket.title.replace(/^Wiki kérdés:\s*/i, '').slice(0, 80)}`
    const htmlContent = renderWikiReportHtml({
      title,
      question: typeof payload.question === 'string' ? payload.question : ticket.title,
      answer: payload.answer,
      rationale: typeof payload.rationale === 'string' ? payload.rationale : '',
      confidence: typeof payload.confidence === 'string' ? payload.confidence : '',
      sources: payload.sources,
    })
    const htmlHash = sha256(htmlContent)
    const existing = await this.sandboxApps.findLatestByTicketId(ticketId)
    const app = existing
      ? await this.sandboxApps.addVersion({
          appId: existing.id,
          htmlContent,
          htmlHash,
          sourceTicketId: ticketId,
          createdBy: actor.userId,
        })
      : await this.sandboxApps.createFromTicket({
          name: title,
          htmlContent,
          htmlHash,
          sourceTicketId: ticketId,
          createdBy: actor.userId,
          tenantId: actor.tenantId,
        })

    await this.audit.append({
      actorType: 'human',
      actorId: actor.userId,
      agentVersion: typeof payload.agentVersion === 'number' ? payload.agentVersion : null,
      action: existing ? 'sandbox_app.version' : 'sandbox_app.create',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: typeof payload.model === 'string' ? payload.model : null,
      inputRef: ticketId,
      outputRef: app.versions[0]?.htmlHash ?? null,
      policyDecision: 'allowed',
      metadata: { version: app.versions[0]?.version ?? 1, level: 'A0' },
    })

    return toView(app)
  }

  async getLatestForTicket(ticketId: string, actor: Actor): Promise<SandboxAppView | null> {
    const app = await this.sandboxApps.findLatestByTicketId(ticketId)
    if (!app) return null
    await this.assertReadable(app, actor, 'sandbox_app.access_denied')
    return toView(app)
  }

  async getRenderableApp(appId: string, actor: Actor, action: 'sandbox_app.preview' | 'sandbox_app.export') {
    const app = await this.sandboxApps.findByIdWithLatestVersion(appId)
    if (!app) throw new Error('Sandbox app not found')
    await this.assertReadable(app, actor, 'sandbox_app.access_denied')
    const latest = app.versions[0]
    if (!latest) throw new Error('Sandbox app has no versions')

    await this.audit.append({
      actorType: 'human',
      actorId: actor.userId,
      agentVersion: null,
      action,
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: latest.sourceTicketId,
      outputRef: latest.htmlHash,
      policyDecision: 'allowed',
      metadata: { version: latest.version, level: app.level },
    })

    return { app, version: latest }
  }

  private async assertReadable(
    app: SandboxAppWithLatestVersion,
    actor: Actor,
    deniedAction: 'sandbox_app.access_denied',
  ) {
    if (app.tenantId === actor.tenantId) return

    await this.audit.append({
      actorType: 'human',
      actorId: actor.userId,
      agentVersion: null,
      action: deniedAction,
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: actor.tenantId,
      outputRef: app.tenantId,
      policyDecision: 'denied',
      metadata: { reason: 'tenant_mismatch' },
    })
    throw new Error('Sandbox app access denied')
  }
}
