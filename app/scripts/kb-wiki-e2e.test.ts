/**
 * #947 LLM Wiki 6/6 — végponttól végpontig: lelet-forgatókönyv és privát tudásbázis.
 *
 * Valódi Postgres (migrált séma) + az éles service-gráf (`gateway-services`) + a valódi MCP
 * HTTP-kezelő (`handleMcpRequest`); csak az OAuth-token ellenőrzése stub. Kliens modell nincs:
 * egy determinisztikus „szimulált agent" hívja az MCP-eszközöket, ahogy a wiki-gondnok skill előírja.
 *
 * 1. Privát tudásbázis „Egészség-napló" sablonnal (Control Plane), agent-kötés közvetlen írással.
 * 2. 30 szintetikus lelet-PDF egy kötegben a tálcára; a duplikátum `duplicateOf`-ot kap.
 * 3. Munkamenetek (külön MCP-session): foglalás → olvasás (szkennelt oldal: `pageImages`) →
 *    `kb_wiki_write` (forrás-oldal + `labs/*` patch + `timeline.md`) → lezárás. A 2. munkamenet
 *    megszakad; a foglalás lejárta után a tétel újra `pending`, a 3. munkamenet befejezi.
 * 4. Mind a 29 egyedi tétel `processed`, egyik sem kétszer; a laborparaméter-oldalakon a mérések
 *    dátum szerint rendezve, forrással és oldalszámmal; `index.md` és `log.md` teljes.
 * 5. Privát izoláció: másik felhasználó ugyanazzal az agenttel semmit nem lát (`not_found`);
 *    a tenant admin Control Plane-actionjei tartalmat nem adnak; az audit tartalommentes.
 * 6. Ticket-út: a régi Ticket megszűnt, a feladat-átadás ma `platform.handoff` — „Dolgozd fel
 *    a tálcát" handoff ugyanazon az úton fut, a válasz-handoffban a tételek és oldalak listája.
 * 7. Végleges törlés → semmi nem marad (DB-sorok + nyers PDF-bájtok).
 * 8. Model Gateway / külső hálózat hívása nem történt (D3).
 *
 * Futtatás: DATABASE_URL=… npm run test:kb-wiki-e2e (CI: migrations job). Csak eldobható DB-n.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a tool-válaszok szabad alakú JSON-ok */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { handleMcpRequest, productionMcpDeps, type McpRuntimeDeps } from '../src/auth/mcp-server'
import { services } from '../src/domain/gateway-services'
import { WikiConsoleError } from '../src/domain/knowledge-base/wiki-console-service'
import { healthWikiUploads, pageLines, type HealthWikiUpload, type ReportSpec } from './fixtures/health-wiki/fixtures'

const ORIGIN = 'https://platform.test'
const KB_TOOLS = ['kb_search', 'kb_list_index', 'kb_get_page', 'kb_get_document', 'kb_ingest', 'kb_wiki_write']

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

// ---------------------------------------------------------------------------
// MCP-kliens: valódi JSON-RPC a HTTP-kezelőn át, felhasználónként és munkamenetenként.

type ToolResult = { isError: boolean; json: any; images: Array<{ data: string; mimeType: string }>; texts: string[] }

const mcpDeps: McpRuntimeDeps = {
  ...productionMcpDeps(),
  isClerkConfigured: () => true,
  resolveOrigin: () => ORIGIN,
  verifyOAuthToken: async (token) => (token.startsWith('e2e:') ? { clerkUserId: token.slice(4) } : null),
}

let rpcId = 0
class McpSession {
  constructor(
    readonly label: string,
    private readonly externalAuthId: string,
    private readonly tenantSlug: string,
    readonly sessionId = `${label}-${randomUUID()}`,
  ) {}

  async rpc(method: string, params: Record<string, unknown>) {
    const res = await handleMcpRequest(
      new Request(`${ORIGIN}/api/mcp/${this.tenantSlug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer e2e:${this.externalAuthId}`,
          'mcp-session-id': this.sessionId,
          'user-agent': 'kb-wiki-e2e/1.0',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      }),
      this.tenantSlug,
      mcpDeps,
    )
    const text = await res.text()
    assert.equal(res.status, 200, `${method} → HTTP ${res.status}: ${text.slice(0, 300)}`)
    const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)!
      : text
    const parsed = JSON.parse(data)
    if (parsed.error) throw new Error(`${method}: ${JSON.stringify(parsed.error)}`)
    return parsed.result
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.rpc('tools/call', { name, arguments: args })
    const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    const texts = content.filter((block) => block.type === 'text').map((block) => block.text!)
    let json: any = null
    try {
      json = texts.length ? JSON.parse(texts[0]) : null
    } catch {
      json = texts[0]
    }
    return {
      isError: !!result.isError,
      json,
      texts,
      images: content.filter((block) => block.type === 'image').map((block) => ({ data: block.data!, mimeType: block.mimeType! })),
    }
  }

  async ok(name: string, args: Record<string, unknown>) {
    const result = await this.call(name, args)
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.json)}`)
    return result.json
  }
}

// ---------------------------------------------------------------------------
// Szimulált wiki-gondnok agent (a `llm-wiki-maintainer` skill lépései, modell nélkül).

const slugify = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

type LabRead = { name: string; value: string; unit: string; ref: string; flag: string; page: number }
type ReportRead = {
  documentId: string
  kindLabel: string
  kind: 'labor' | 'vizit' | 'zarojelentes'
  date: string
  provider: string
  clinician: string
  labs: LabRead[]
  facts: Array<{ text: string; page: number }>
  scannedPages: number[]
}

const KIND_BY_TITLE: Array<[RegExp, ReportRead['kind']]> = [
  [/^Laboratóriumi lelet/, 'labor'],
  [/^Ambuláns vizit-összefoglaló/, 'vizit'],
  [/^Zárójelentés/, 'zarojelentes'],
]

/** Egy oldal szövegének értelmezése (szöveges oldalnál a kinyert szöveg, szkennél a kép „olvasata"). */
function readPage(report: Partial<ReportRead> & { labs: LabRead[]; facts: ReportRead['facts'] }, text: string, page: number) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const kind = KIND_BY_TITLE.find(([pattern]) => pattern.test(line))
    if (kind) {
      report.kind = kind[1]
      report.kindLabel = line.split(' - ')[0]
      continue
    }
    const date = /^Lelet kelte: (\d{4}-\d{2}-\d{2})$/.exec(line)
    if (date) report.date = date[1]
    else if (line.startsWith('Intézmény: ')) report.provider = line.slice(11)
    else if (line.startsWith('Orvos: ')) report.clinician = line.slice(7)
    else if (/^(Diagnózis|Gyógyszer|Vélemény|Felvétel|Panaszok|Mellkasröntgen|Javaslat|Állapot távozáskor): /.test(line)) {
      report.facts.push({ text: line, page })
    } else {
      const cells = line.split(' | ')
      if (cells.length === 5 && cells[0] !== 'Paraméter' && /^[\d.]+$/.test(cells[1])) {
        report.labs.push({ name: cells[0], value: cells[1], unit: cells[2], ref: cells[3], flag: cells[4] === '-' ? '' : cells[4], page })
      }
    }
  }
}

/** A kinyert szöveg oldalakra bontása (a PDF-kinyerés „Oldal N" blokkjai mentén). */
function splitPages(text: string, pageCount: number): string[] {
  const pages: string[] = []
  const parts = text.split(/^#+\s*Oldal (\d+)\s*$/m)
  for (let i = 1; i < parts.length; i += 2) pages[Number(parts[i]) - 1] = parts[i + 1] ?? ''
  if (!pages.length) pages[0] = text
  return Array.from({ length: pageCount }, (_, i) => pages[i] ?? '')
}

const TABLE_HEADER = '| dátum | érték | egység | ref. tartomány | jelzés (H/L) | forrás |\n|---|---|---|---|---|---|'
const tableRowDate = (line: string) => /^\| (\d{4}-\d{2}-\d{2}) \|/.exec(line)?.[1] ?? null

type SessionStats = { processed: string[]; pages: Set<string>; interrupted: string | null; imagePages: Array<[string, number]> }

class WikiAgentSim {
  readonly stats: SessionStats = { processed: [], pages: new Set(), interrupted: null, imagePages: [] }

  constructor(
    private readonly mcp: McpSession,
    private readonly definitionId: string,
    private readonly wikiId: string,
    /** A multimodális modell olvasata: csak a ténylegesen megkapott PNG-oldalra ad szöveget. */
    private readonly vision: (documentId: string, page: number, png: Buffer) => string,
  ) {}

  private args(extra: Record<string, unknown>) {
    return { definitionId: this.definitionId, ...extra }
  }

  /** Munkamenet eleje: szabályok + index (a briefing szerint). */
  async start() {
    const rules = await this.mcp.ok('kb_get_page', this.args({ wikiId: this.wikiId, path: 'WIKI.md' }))
    assert.match(rules.text, /Egészség-napló/)
    assert.match(rules.text, /replaceSection/)
    await this.mcp.ok('kb_get_page', this.args({ wikiId: this.wikiId, path: 'index.md' }))
  }

  async listInbox() {
    return this.mcp.ok('kb_list_index', this.args({ wikiId: this.wikiId, inbox: true, limit: 200 }))
  }

  /** „Dolgozd fel / folytasd a tálcát": legfeljebb `max` tétel, `interruptAfter` után megszakad. */
  async processInbox(input: { max: number; interruptAfter?: number }) {
    for (let done = 0; done < input.max; ) {
      const inbox = await this.listInbox()
      const next = inbox.items.find((item: any) => item.status === 'pending')
      if (!next) return
      if (input.interruptAfter !== undefined && done === input.interruptAfter) {
        // A munkamenet kerete elfogy: foglal, elolvas, de írás előtt megszakad.
        await this.read(next.documentId)
        this.stats.interrupted = next.documentId
        return
      }
      await this.processOne(next.documentId)
      done++
    }
  }

  private async read(documentId: string): Promise<ReportRead> {
    const doc = await this.mcp.ok('kb_get_document', this.args({ documentId, claimForWiki: true }))
    const quality = (doc.pages ?? []) as Array<{ page: number; textQuality: string }>
    const pageCount = Math.max(1, quality.length)
    const texts = splitPages(String(doc.text ?? ''), pageCount)
    const unreadable = quality.filter((page) => page.textQuality !== 'ok').map((page) => page.page)
    if (unreadable.length) {
      assert.match(doc.nextStep ?? '', /pageImages/)
      const images = await this.mcp.call('kb_get_document', this.args({ documentId, pageImages: true, pages: unreadable.join(',') }))
      assert.equal(images.isError, false, JSON.stringify(images.json))
      assert.equal(images.images.length, unreadable.length)
      images.images.forEach((image, i) => {
        const png = Buffer.from(image.data, 'base64')
        assert.equal(image.mimeType, 'image/png')
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        texts[unreadable[i] - 1] = this.vision(documentId, unreadable[i], png)
        this.stats.imagePages.push([documentId, unreadable[i]])
      })
    }
    const report = { documentId, labs: [], facts: [], scannedPages: unreadable } as unknown as ReportRead
    texts.forEach((text, i) => readPage(report, text, i + 1))
    assert.ok(report.date && report.provider && report.kind, `nem olvasható lelet: ${documentId}`)
    return report
  }

  private async page(path: string) {
    const result = await this.mcp.ok('kb_get_page', this.args({ wikiId: this.wikiId, path }))
    return result.found ? result : null
  }

  async processOne(documentId: string) {
    const report = await this.read(documentId)
    const sourcePath = `sources/${report.date}-${slugify(report.provider)}-${report.kind}.md`
    const cite = (page: number) => `[[${sourcePath.replace(/\.md$/, '')}]] ${documentId} o.${page}`
    const pages: any[] = []

    pages.push({
      path: sourcePath,
      action: 'upsert',
      type: 'source',
      title: `${report.kindLabel} — ${report.date}`,
      summary: `${report.kindLabel}, ${report.provider}, ${report.date}`,
      category: 'Források',
      frontmatter: { source_date: report.date, sources: [{ documentId, page: 1 }] },
      body: [
        '## Tények',
        '',
        `- Intézmény: [[providers/${slugify(report.provider)}]]`,
        `- Orvos: ${report.clinician}`,
        ...(report.labs.length
          ? ['', '| paraméter | érték | egység | ref. tartomány | jelzés | oldal |', '|---|---|---|---|---|---|',
            ...report.labs.map((lab) => `| [[labs/${slugify(lab.name)}]] | ${lab.value} | ${lab.unit} | ${lab.ref} | ${lab.flag || '-'} | ${lab.page} |`)]
          : []),
        ...report.facts.map((fact) => `- ${fact.text} (o.${fact.page})`),
        '',
        '## Értelmezés',
        '',
        report.labs.some((lab) => lab.flag)
          ? `- Referencián kívül: ${report.labs.filter((lab) => lab.flag).map((lab) => `${lab.name} (${lab.flag})`).join(', ')}. Ez nem orvosi diagnózis.`
          : '- Nincs referencián kívüli érték a leletben.',
        ...(report.scannedPages.length ? [`- ⚠️ Beszkennelt oldal(ak) (${report.scannedPages.join(', ')}): az értékek képről olvasva.`] : []),
      ].join('\n'),
    })

    const provider = `providers/${slugify(report.provider)}.md`
    pages.push((await this.page(provider))
      ? { path: provider, action: 'patch', patch: [{ op: 'addSource', source: { documentId, page: 1 } }] }
      : { path: provider, action: 'upsert', type: 'entity', title: report.provider, summary: `Intézmény (${report.clinician})`, category: 'Intézmények',
        frontmatter: { sources: [{ documentId, page: 1 }] }, body: `## Tények\n\n- Orvos: ${report.clinician}` })

    for (const lab of report.labs) {
      const path = `labs/${slugify(lab.name)}.md`
      const row = `| ${report.date} | ${lab.value} | ${lab.unit} | ${lab.ref} | ${lab.flag || '-'} | ${cite(lab.page)} |`
      const existing = await this.page(path)
      if (!existing) {
        pages.push({
          path, action: 'upsert', type: 'entity', title: lab.name, summary: `Laborparaméter (${lab.unit}, ref. ${lab.ref})`, category: 'Laborértékek',
          frontmatter: { sources: [{ documentId, page: lab.page }] },
          body: `## Tények\n\n- Mértékegység: ${lab.unit}\n- Referenciatartomány: ${lab.ref}\n\n## Mérések\n\n${TABLE_HEADER}\n${row}`,
        })
        continue
      }
      const rows = String(existing.text).split('\n').filter((line) => tableRowDate(line))
      const latest = rows.map(tableRowDate).sort().at(-1)!
      const source = { op: 'addSource', source: { documentId, page: lab.page } }
      pages.push(report.date >= latest
        ? { path, action: 'patch', patch: [{ op: 'appendToSection', section: 'Mérések', text: row }, source] }
        // Régebbi mérés: az appendToSection nem rendez, ezért a táblázat cseréje (WIKI.md szabály).
        : { path, action: 'patch', patch: [{ op: 'replaceSection', section: 'Mérések', text: `${TABLE_HEADER}\n${[...rows, row].sort().join('\n')}` }, source] })
    }

    const diagnosis = report.facts.find((fact) => fact.text.startsWith('Diagnózis: '))
    if (diagnosis) {
      const name = diagnosis.text.slice(11).replace(/\s*\(.*\)$/, '')
      const path = `conditions/${slugify(name)}.md`
      const line = `- ${report.date}: ${report.kindLabel} ([[${sourcePath.replace(/\.md$/, '')}]])`
      pages.push((await this.page(path))
        ? { path, action: 'patch', patch: [{ op: 'appendToSection', section: 'Kapcsolódó leletek', text: line }, { op: 'addSource', source: { documentId, page: diagnosis.page } }] }
        : { path, action: 'upsert', type: 'entity', title: name, summary: `Diagnózis, első megjelenés ${report.date}`, category: 'Diagnózisok',
          frontmatter: { sources: [{ documentId, page: diagnosis.page }] },
          body: `## Tények\n\n- ${diagnosis.text}\n- Első megjelenés: ${report.date}\n\n## Kapcsolódó leletek\n\n${line}\n\n## Értelmezés\n\n- Az agent összefoglalója, nem orvosi diagnózis.` })
    }
    const medication = report.facts.find((fact) => fact.text.startsWith('Gyógyszer: ') && !fact.text.endsWith('változatlan'))
    if (medication) {
      const name = medication.text.slice(11).split(' ')[0]
      const path = `medications/${slugify(name)}.md`
      const line = `- ${report.date}: ${medication.text.slice(11)} — ${report.clinician} ([[${sourcePath.replace(/\.md$/, '')}]])`
      pages.push((await this.page(path))
        ? { path, action: 'patch', patch: [{ op: 'appendToSection', section: 'Felírások', text: line }, { op: 'addSource', source: { documentId, page: medication.page } }] }
        : { path, action: 'upsert', type: 'entity', title: name, summary: `Gyógyszer, első felírás ${report.date}`, category: 'Gyógyszerek',
          frontmatter: { sources: [{ documentId, page: medication.page }] }, body: `## Felírások\n\n${line}` })
    }

    // timeline.md: évenként, leletenként egy sor, dátum szerint — teljes újraírás baseVersion-nel.
    const timeline = await this.page('timeline.md')
    const entries = new Set<string>(timeline ? String(timeline.text).split('\n').filter((line) => /^- \d{4}-\d{2}-\d{2} — /.test(line)) : [])
    entries.add(`- ${report.date} — ${report.kindLabel}, ${report.provider} ([[${sourcePath.replace(/\.md$/, '')}]])`)
    const sorted = [...entries].sort()
    const years = [...new Set(sorted.map((line) => line.slice(2, 6)))]
    const sources = [...(timeline?.sources ?? []).map((ref: any) => ({ documentId: ref.documentId })), { documentId }]
    pages.push({
      path: 'timeline.md', action: 'upsert', type: 'analysis', title: 'Idővonal', summary: 'Évenként minden lelet egy sorban', category: 'Áttekintés',
      frontmatter: { sources: sources.filter((ref, i) => sources.findIndex((other) => other.documentId === ref.documentId) === i) },
      body: years.map((year) => `## ${year}\n\n${sorted.filter((line) => line.slice(2, 6) === year).join('\n')}`).join('\n\n'),
      ...(timeline ? { baseVersion: timeline.baseVersion } : {}),
    })

    // MCP-n hirdetett alak: JSON-szöveg és vesszős lista.
    const write = await this.mcp.ok('kb_wiki_write', this.args({
      wikiId: this.wikiId,
      pages: JSON.stringify(pages),
      sourceDocumentIds: documentId,
      inboxItemId: documentId,
      logEntry: { op: 'ingest', title: `${report.kindLabel} ${report.date}` },
    }))
    assert.equal(write.status, 'applied', JSON.stringify(write))
    assert.equal(write.inboxStatus, 'processed')
    this.stats.processed.push(documentId)
    for (const page of pages) this.stats.pages.add(page.path)
  }
}

// ---------------------------------------------------------------------------

async function seedUser(tenantId: string, name: string, role: 'admin' | 'operator') {
  const externalAuthId = `test_${randomUUID()}`
  const user = await prisma.user.create({ data: { externalAuthId, email: `${randomUUID()}@example.test`, name, status: 'active' } })
  await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'active' } })
  return { ...user, externalAuthId, role }
}

async function seedAgent(tenantId: string, name: string, description: string, tools: string[]) {
  const agent = await prisma.agent.create({
    data: { tenantId, name, description, status: 'active', roleInstruction: `${name}. A válasz nem orvosi diagnózis; a leletből származó tényt és az értelmezést válaszd el.` },
  })
  if (tools.length) await prisma.capability.createMany({ data: tools.map((toolName) => ({ agentId: agent.id, toolName, allowed: true })) })
  return agent
}

async function main() {
  console.log('=== #947 LLM Wiki végponttól végpontig (Postgres + MCP HTTP) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  console.info = () => {}
  // D3: szerveroldali modell (Model Gateway) vagy bármilyen külső hívás nem történhet.
  let fetchCalls = 0
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls++
    throw new Error(`network disabled in e2e: ${String(input)}`)
  }) as typeof fetch

  const uploads = await healthWikiUploads()
  const tenant = await prisma.tenant.create({ data: { slug: `wiki947-${randomUUID().slice(0, 8)}`, displayName: 'Wiki e2e' } })
  const owner = await seedUser(tenant.id, 'Minta Beteg', 'operator')
  const other = await seedUser(tenant.id, 'Másik Kolléga', 'operator')
  const admin = await seedUser(tenant.id, 'Tenant Admin', 'admin')
  const agent = await seedAgent(tenant.id, 'Egészség-agent', 'Saját leletek feldolgozása egészség-wikibe', KB_TOOLS)
  const front = await seedAgent(tenant.id, 'Asszisztens', 'Feladatok továbbítása a megfelelő munkatársnak', [])
  for (const user of [owner, other]) {
    for (const target of [agent, front]) {
      await prisma.resourceGrant.create({
        data: { tenantId: tenant.id, userId: user.id, resourceType: 'agent', resourceId: target.id, accessLevel: 'operate', grantedById: admin.id },
      })
    }
  }
  const actor = (user: typeof owner) => ({ userId: user.id, tenantId: tenant.id, role: user.role })
  const session = (label: string, user: typeof owner) => new McpSession(label, user.externalAuthId, tenant.slug)

  const specByDocument = new Map<string, ReportSpec>()
  const uploadByDocument = new Map<string, HealthWikiUpload>()
  const vision = (documentId: string, page: number, png: Buffer) => {
    const spec = specByDocument.get(documentId)!
    assert.ok(spec.scannedPages.includes(page), 'képet csak szkennelt oldalra kérünk')
    assert.ok(png.byteLength > 1000)
    return pageLines(spec, page - 1).join('\n')
  }

  let connectorId = ''
  let wikiId = ''
  let definitionId = ''
  const batchId = randomUUID()
  const documentIds: string[] = []
  const unique = uploads.filter((upload) => !upload.duplicate)
  const sims: WikiAgentSim[] = []

  try {
    await check('1. privát tudásbázis „Egészség-napló" sablonnal, közvetlen írású agent-kötés, publikálás', async () => {
      connectorId = (await services.wikiConsole.createKnowledgeBase(actor(owner), {
        displayName: 'Egészség-napló', private: true, template: 'health-journal', kbLanguage: 'hu',
      })).connectorId
      await services.wikiConsole.setAgentWikiLink(actor(owner), {
        agentId: agent.id, connectorId, wikiAccess: 'write', wikiWriteMode: 'direct', wikiCollectFocus: 'Saját leleteim és laborértékeim',
      })
      const links = await services.wikiConsole.listAgentWikiLinks(actor(owner), agent.id)
      const link = links.find((row) => row.connectorId === connectorId)!
      assert.deepEqual([link.kind, link.access, link.writeMode], ['private', 'write', 'direct'])
      definitionId = (await services.agentDefinitions.publishAgentDefinition({ agentId: agent.id, tenantId: tenant.id, publishedById: owner.id })).definitionId
      await services.agentDefinitions.publishAgentDefinition({ agentId: front.id, tenantId: tenant.id, publishedById: owner.id })
      const overview = await services.wikiConsole.getOverview(actor(owner), connectorId)
      assert.equal(overview.private, true)
      assert.ok(overview.wikiId)
      wikiId = overview.wikiId!
    })

    await check('2. 30 PDF egy kötegben a tálcára; a duplikátum nem lesz új tétel', async () => {
      const results = []
      for (const [batchSeq, upload] of uploads.entries()) {
        results.push(await services.wikiConsole.uploadToInbox(actor(owner), {
          connectorId, batchId, batchSeq, filename: upload.filename, mimeType: 'application/pdf', buffer: upload.bytes,
        }))
      }
      results.forEach((result, i) => {
        if (uploads[i].duplicate) return
        assert.equal(result.status, 'queued')
        const documentId = (result as { documentId: string }).documentId
        documentIds.push(documentId)
        specByDocument.set(documentId, uploads[i].spec)
        uploadByDocument.set(documentId, uploads[i])
      })
      const dupIndex = uploads.findIndex((upload) => upload.duplicate)
      const original = uploads.findIndex((upload) => !upload.duplicate && upload.bytes.equals(uploads[dupIndex].bytes))
      assert.deepEqual(results[dupIndex], { status: 'duplicate', existingDocumentId: (results[original] as { documentId: string }).documentId })
      assert.equal(documentIds.length, 29)
      const inbox = await services.wikiConsole.listInbox(actor(owner), connectorId)
      assert.deepEqual(inbox.totals, { pending: 29, inProgress: 0, processed: 0, skipped: 0 })
      assert.equal(inbox.batches[0].total, 29)
    })

    await check('3a. 1. munkamenet: briefing, MCP-duplikátum `duplicateOf`, 10 lelet feldolgozása', async () => {
      const mcp = session('s1', owner)
      const definition = await mcp.ok('platform.agent.get_definition', { agentId: agent.id })
      assert.match(definition.briefing, /AGENT WIKI/)
      assert.ok(definition.briefing.includes(wikiId), 'a tulajdonos briefingje mutatja a wikit')
      assert.match(definition.briefing, /29/)
      assert.ok(definition.snapshot.skills.some((skill: any) => skill.name === 'llm-wiki-maintainer'))

      const dup = uploads.find((upload) => upload.duplicate)!
      const again = await mcp.ok('kb_ingest', {
        definitionId, wikiId, processingMode: 'wiki', filename: dup.filename, contentBase64: dup.bytes.toString('base64'),
      })
      assert.equal(again.status, 'duplicate')
      assert.equal(again.duplicateOf.wikiStatus, 'pending')
      assert.ok(documentIds.includes(again.duplicateOf.documentId))

      const sim = new WikiAgentSim(mcp, definitionId, wikiId, vision)
      sims.push(sim)
      await sim.start()
      await sim.processInbox({ max: 10 })
      assert.equal(sim.stats.processed.length, 10)
      const inbox = await sim.listInbox()
      assert.deepEqual(inbox.summary.batches.map((b: any) => [b.processed, b.pending]), [[10, 19]])
    })

    let interrupted = ''
    await check('3b. 2. munkamenet: 8 lelet, majd megszakítás foglalás után; lejárat → újra pending', async () => {
      const mcp = session('s2', owner)
      const sim = new WikiAgentSim(mcp, definitionId, wikiId, vision)
      sims.push(sim)
      await sim.start()
      await sim.processInbox({ max: 20, interruptAfter: 8 })
      assert.equal(sim.stats.processed.length, 8)
      interrupted = sim.stats.interrupted!
      assert.ok(interrupted)
      const claimed = (await sim.listInbox()).items.find((item: any) => item.documentId === interrupted)
      assert.equal(claimed.status, 'in_progress')
      assert.equal(claimed.claimedBy.agentId, agent.id)
      const ttl = Date.parse(claimed.claimExpiresAt) - Date.now()
      assert.ok(ttl > 115 * 60_000 && ttl <= 120 * 60_000, `2 órás foglalás: ${ttl}`)
      // Időeltolás: a 2 órás foglalás lejárt.
      await prisma.$executeRaw`UPDATE documents SET wiki_claim_expires_at = now() - interval '1 minute' WHERE id = ${interrupted}::uuid`
      const released = (await sim.listInbox()).items.find((item: any) => item.documentId === interrupted)
      assert.equal(released.status, 'pending')
    })

    await check('3c. 3. munkamenet „folytasd": a megszakított tételt is befejezi, 4 tétel marad', async () => {
      const mcp = session('s3', owner)
      const sim = new WikiAgentSim(mcp, definitionId, wikiId, vision)
      sims.push(sim)
      await sim.start()
      await sim.processInbox({ max: 7 })
      assert.equal(sim.stats.processed.length, 7)
      assert.ok(sim.stats.processed.includes(interrupted), 'a megszakított tétel a 3. munkamenetben kész')
      const inbox = await sim.listInbox()
      assert.deepEqual(inbox.summary.batches.map((b: any) => [b.processed, b.pending, b.inProgress]), [[25, 4, 0]])
    })

    let ticketId = ''
    let reportHandoffId = ''
    await check('6. ticket-út: „Dolgozd fel a tálcát" handoff → feldolgozás → válasz a tételek és oldalak listájával', async () => {
      const requester = session('ticket-front', owner)
      const frontDefinition = await requester.ok('platform.agent.get_definition', { agentId: front.id })
      const created = await requester.ok('platform.handoff', {
        definitionId: frontDefinition.definitionId,
        projectKey: 'egeszseg',
        toAgentId: agent.id,
        title: 'Dolgozd fel a tálcát',
        summary: 'Kérlek, dolgozd fel az Egészség-napló tálcáján váró leleteket, és küldd vissza, mi készült el.',
        idempotencyKey: `ticket-${randomUUID()}`,
      })
      ticketId = created.handoffId

      const mcp = session('ticket-agent', owner)
      const definition = await mcp.ok('platform.agent.get_definition', { agentId: agent.id })
      const task = definition.handoffs.entries.find((entry: any) => entry.id === ticketId)
      assert.equal(task.title, 'Dolgozd fel a tálcát')
      await mcp.ok('platform.handoff_ack', { definitionId, handoffId: ticketId, decision: 'accepted' })
      const sim = new WikiAgentSim(mcp, definitionId, wikiId, vision)
      sims.push(sim)
      await sim.start()
      await sim.processInbox({ max: 100 })
      assert.equal(sim.stats.processed.length, 4)
      const filenames = sim.stats.processed.map((id) => uploadByDocument.get(id)!.filename)
      const report = await mcp.ok('platform.handoff', {
        definitionId,
        projectKey: 'egeszseg',
        toUserId: owner.id,
        title: 'Tálca feldolgozva',
        summary: [
          `Feldolgozott tételek (${filenames.length}): ${filenames.join(', ')}`,
          `Létrejött / módosult oldalak (${sim.stats.pages.size}): ${[...sim.stats.pages].sort().join(', ')}`,
          'A tálca üres.',
        ].join('\n'),
        idempotencyKey: `ticket-report-${ticketId}`,
      })
      reportHandoffId = report.handoffId
      await mcp.ok('platform.handoff_ack', { definitionId, handoffId: ticketId, decision: 'done' })

      const ticket = await prisma.handoff.findUniqueOrThrow({ where: { id: ticketId } })
      assert.equal(ticket.status, 'done')
      const reply = await prisma.handoff.findUniqueOrThrow({ where: { id: reportHandoffId } })
      assert.equal(reply.toUserId, owner.id)
      for (const name of filenames) assert.ok(reply.summary.includes(name), name)
      for (const path of sim.stats.pages) assert.ok(reply.summary.includes(path), path)
      assert.ok((await services.projectWork.handoffs.listOpenForUser(tenant.id, owner.id)).some((row) => row.id === reportHandoffId))
    })

    await check('4. mind a 29 egyedi tétel processed, egyik sem kétszer; szkennelt oldalak képként olvasva', async () => {
      const docs = await prisma.document.findMany({ where: { connectorId } })
      assert.equal(docs.length, 29)
      assert.ok(docs.every((doc) => doc.wikiStatus === 'processed'))
      assert.equal(new Set(docs.map((doc) => doc.wikiProcessedByChangeSetId)).size, 29)
      const processed = sims.flatMap((sim) => sim.stats.processed)
      assert.equal(processed.length, 29)
      assert.equal(new Set(processed).size, 29, 'egyik tétel sem dolgozódott fel kétszer')
      const sourcePages = await prisma.wikiPage.findMany({ where: { connectorId, path: { startsWith: 'sources/' } } })
      assert.equal(sourcePages.length, 29)
      assert.ok(sourcePages.every((page) => page.version === 1), 'forrás-oldal nem íródott újra')
      const scanned = unique.flatMap((upload) => upload.spec.scannedPages.map((page) => `${[...specByDocument].find(([, spec]) => spec === upload.spec)![0]}:${page}`))
      const read = sims.flatMap((sim) => sim.stats.imagePages.map(([doc, page]) => `${doc}:${page}`))
      assert.ok(scanned.length >= 10)
      assert.deepEqual([...new Set(read)].sort(), scanned.sort())
    })

    await check('4. laborparaméter-oldal: minden mérés dátum szerint rendezve, lelettel és oldalszámmal', async () => {
      const mcp = session('verify', owner)
      const specs = unique.map((upload) => upload.spec).filter((spec) => spec.kind === 'labor')
      const documentOf = (spec: ReportSpec) => [...specByDocument].find(([, other]) => other === spec)![0]
      // Az LDL minden leletben az 1. oldalon; a másik paraméter néha a 2. oldalon (kétoldalas lelet).
      const pageTwo = specs.flatMap((spec) => spec.pages[1]?.labs ?? []).map((lab) => lab.param.slug)
      const second = pageTwo.find((slug) => specs.filter((spec) => spec.pages.some((page) => page.labs.some((lab) => lab.param.slug === slug))).length >= 3)!
      for (const slug of ['ldl-koleszterin', second]) {
        const expected = specs
          .flatMap((spec) => spec.pages.flatMap((page, i) => page.labs.filter((lab) => lab.param.slug === slug).map((lab) => ({ spec, lab, page: i + 1 }))))
          .sort((a, b) => a.spec.date.localeCompare(b.spec.date))
        const param = expected[0].lab.param
        const page = await mcp.ok('kb_get_page', { definitionId, wikiId, path: `labs/${slugify(param.name)}.md` })
        const rows = String(page.text).split('\n').filter((line) => tableRowDate(line))
        assert.equal(rows.length, expected.length, `${slug}: ${rows.length} sor`)
        rows.forEach((row, i) => {
          const { spec, lab, page: pdfPage } = expected[i]
          assert.ok(row.startsWith(`| ${spec.date} | ${lab.value.toFixed(param.decimals)} | ${param.unit} | ${param.ref} |`), row)
          assert.ok(row.includes(`${documentOf(spec)} o.${pdfPage}`), `forrás + oldalszám: ${row}`)
        })
        assert.deepEqual(rows.map(tableRowDate), [...rows.map(tableRowDate)].sort(), 'dátum szerint rendezett')
        assert.equal(new Set(page.sources.map((ref: any) => ref.documentId)).size, expected.length)
        if (slug === second) assert.ok(expected.some((row) => row.page === 2), 'van 2. oldali mérés')
      }
    })

    await check('4. index.md és log.md teljes; kérdés a wikiből (index → oldal → eredeti lelet)', async () => {
      const mcp = session('query', owner)
      const published = await prisma.wikiPage.findMany({ where: { connectorId, status: 'published' } })
      const index = await mcp.ok('kb_get_page', { definitionId, wikiId, path: 'index.md' })
      assert.match(index.text, new RegExp(`${published.length} pages`))
      for (const page of published) assert.ok(index.text.includes(`[[${page.path.replace(/\.md$/, '')}]]`), page.path)
      const log = await mcp.ok('kb_get_page', { definitionId, wikiId, path: 'log.md' })
      const ingests = String(log.text).split('\n').filter((line) => /^## \[\d{4}-\d{2}-\d{2}\] ingest \| /.test(line))
      assert.equal(ingests.length, 29)
      for (const spec of unique.map((upload) => upload.spec)) assert.ok(log.text.includes(` ${spec.date}`), spec.date)

      // „Hogyan alakult az LDL 2022 óta?" — index-first navigáció, majd az eredeti lelet.
      assert.ok(index.text.includes('[[labs/ldl-koleszterin]]'))
      const hits = await mcp.ok('kb_search', { definitionId, wikiId, query: 'LDL-koleszterin', k: 20 })
      // A wiki-oldalak kereshetők (a rangsorban a nyers leletek is ott vannak; a válasz index-first).
      assert.ok(hits.hits.some((hit: any) => hit.kind === 'wiki_page' && hit.path.startsWith('sources/')), JSON.stringify(hits).slice(0, 400))
      const ldl = await mcp.ok('kb_get_page', { definitionId, wikiId, path: 'labs/ldl-koleszterin.md' })
      const cited = /([0-9a-f-]{36}) o\.1 \|$/.exec(String(ldl.text).split('\n').filter((line) => tableRowDate(line)).at(-1)!)![1]
      const original = await mcp.ok('kb_get_document', { definitionId, documentId: cited })
      assert.equal(original.documentId, cited)
      const overview = await services.wikiConsole.getOverview(actor(owner), connectorId)
      assert.deepEqual(overview.inbox, { pending: 0, inProgress: 0, processed: 29, skipped: 0 })
    })

    await check('5. privát izoláció: másik felhasználó ugyanazzal az agenttel semmit nem lát', async () => {
      const mcp = session('other', other)
      const definition = await mcp.ok('platform.agent.get_definition', { agentId: agent.id })
      const asText = JSON.stringify(definition)
      for (const leak of [wikiId, connectorId, 'Egészség-napló']) assert.ok(!asText.includes(leak), `get_definition: ${leak}`)
      // Wiki-azonosító nélkül: a másik felhasználónak ennek az agentnek nincs is tudásbázisa.
      for (const [tool, args] of [['kb_list_index', {}], ['kb_search', { query: 'LDL-koleszterin' }]] as const) {
        const result = await mcp.call(tool, { definitionId, ...args })
        assert.equal(result.json.code, 'missing_knowledge_base_connector_read', `${tool}: ${JSON.stringify(result.json)}`)
      }
      assert.deepEqual(await mcp.ok('kb_list_index', { definitionId, inbox: true }), {
        items: [], summary: { wikis: [], batches: [] }, nextStep: 'The inbox is empty.',
      })
      const notFound = async (tool: string, args: Record<string, unknown>) => {
        const result = await mcp.call(tool, { definitionId, ...args })
        assert.equal(result.isError, true, `${tool}: ${JSON.stringify(result.json)}`)
        assert.equal(result.json.code, 'not_found', `${tool}: ${JSON.stringify(result.json)}`)
      }
      await notFound('kb_get_page', { wikiId, path: 'labs/ldl-koleszterin.md' })
      await notFound('kb_get_page', { wikiId, path: 'index.md' })
      await notFound('kb_list_index', { wikiId, inbox: true })
      await notFound('kb_get_document', { documentId: documentIds[0] })
      await notFound('kb_get_document', { documentId: documentIds[0], pageImages: true })
      await notFound('kb_wiki_write', { wikiId, pages: JSON.stringify([{ path: 'labs/x.md', action: 'upsert', type: 'entity', title: 'x', summary: 'x', body: 'x' }]) })
    })

    await check('5. tenant admin: a Control Plane csak metaadatot ad, tartalmat nem', async () => {
      const list = await services.wikiConsole.listKnowledgeBases(actor(admin))
      const row = list.find((item) => item.connectorId === connectorId)!
      assert.equal(row.metadataOnly, true)
      assert.ok(!('name' in row) && !JSON.stringify(row).includes('Egészség-napló'))
      assert.equal(row.sourceCount, 29)
      const denied = async (label: string, fn: () => Promise<unknown>) => {
        await assert.rejects(fn, (error: unknown) => error instanceof WikiConsoleError && error.code === 'not_found', label)
      }
      await denied('getOverview', () => services.wikiConsole.getOverview(actor(admin), connectorId))
      await denied('getPage', () => services.wikiConsole.getPage(actor(admin), connectorId, 'labs/ldl-koleszterin.md'))
      await denied('getSource', () => services.wikiConsole.getSource(actor(admin), connectorId, documentIds[0]))
      await denied('listInbox', () => services.wikiConsole.listInbox(actor(admin), connectorId))
      await denied('exportZip', () => services.wikiConsole.exportZip(actor(admin), connectorId))
      await denied('purgePrivate', () => services.wikiConsole.purgePrivate(actor(admin), connectorId))
      await denied('uploadToInbox', () => services.wikiConsole.uploadToInbox(actor(admin), {
        connectorId, batchId, batchSeq: 99, filename: 'x.pdf', buffer: Buffer.from('%PDF-x'),
      }))
      const links = await services.wikiConsole.listAgentWikiLinks(actor(admin), agent.id)
      assert.ok(!links.some((link) => link.connectorId === connectorId))
      // Admin az MCP-n, ugyanazzal az agenttel: a privát wiki nem létezik.
      const mcp = session('admin', admin)
      const page = await mcp.call('kb_get_page', { definitionId, wikiId, path: 'timeline.md' })
      assert.equal(page.json.code, 'not_found')
      // A tulajdonos exportja működik (D13).
      const zip = await services.wikiConsole.exportZip(actor(owner), connectorId)
      assert.ok(zip.bytes.byteLength > 10_000)
    })

    await check('5. az audit-sorokban nincs oldalcím, path, fájlnév vagy tudásbázis-név', async () => {
      const rows = await prisma.auditLog.findMany({ where: { tenantId: tenant.id } })
      assert.ok(rows.some((row) => row.action === 'kb.wiki.changeset.applied' && row.actorType === 'agent'))
      assert.ok(rows.some((row) => row.action === 'kb.wiki.inbox.claimed'))
      const json = JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
      const titles = (await prisma.wikiPage.findMany({ where: { connectorId }, select: { title: true, path: true } }))
      const leaks = [
        'Egészség-napló', 'Saját leleteim',
        ...uploads.map((upload) => upload.filename),
        ...titles.flatMap((page) => [page.path, page.title]),
        'labs/', 'sources/', 'timeline.md', 'LDL-koleszterin',
      ]
      for (const leak of leaks) assert.ok(!json.includes(leak), `audit-szivárgás: ${leak}`)
    })

    await check('9. #978 előzmények az MCP-n: változáslista, asOf, visszaállítás mindig jóváhagyással, címke, megőrzés, kitakarás', async () => {
      const mcp = session('history', owner)
      // A régi (#947) képesség-lista elég: a kb_wiki_changes / kb_wiki_revert a meglévő wiki-jogra épül.
      const first = await mcp.ok('kb_wiki_changes', { definitionId, wikiId })
      assert.ok(first.latestSeq >= 29, JSON.stringify(first).slice(0, 300))
      assert.equal(first.changes.length, 10, 'cursor nélkül az utolsó 10')
      assert.ok(first.changes.every((row: any) => row.seq && Array.isArray(row.pages) && row.author.kind === 'agent'))
      assert.ok(!JSON.stringify(first).includes('| dátum |'), 'D4: oldal-szöveg nélkül')
      const second = await mcp.ok('kb_wiki_changes', { definitionId, wikiId })
      assert.deepEqual(second.changes, [])
      const briefing = await services.wiki.listWikis({ tenantId: tenant.id, userId: owner.id, agentId: agent.id, snapshot: (await prisma.agentDefinitionVersion.findUniqueOrThrow({ where: { id: definitionId } })).snapshot as never })
      assert.equal(briefing.find((row: any) => row.wikiId === wikiId)?.changes, undefined)

      // Időutazás: a 10. alkalmazás utáni index kevesebb oldalt mutat, mint a mostani.
      const early = await mcp.ok('kb_get_page', { definitionId, wikiId, path: 'index.md', asOf: '10' })
      const now = await mcp.ok('kb_get_page', { definitionId, wikiId, path: 'index.md' })
      assert.equal(early.asOf.seq, 10)
      assert.ok(early.pageCount < now.pageCount, `${early.pageCount} < ${now.pageCount}`)

      // Visszaállítás: közvetlen írási mód mellett is jóváhagyásra vár (D2, AC4).
      const latest = first.latestSeq
      const lastChange = await prisma.wikiChangeSet.findFirstOrThrow({ where: { wikiId, seq: latest } })
      const timelineBefore = await prisma.wikiPage.findFirstOrThrow({ where: { connectorId, path: 'timeline.md' } })
      const revert = await mcp.call('kb_wiki_revert', { definitionId, wikiId, changeSeq: String(latest), note: 'teszt' })
      assert.equal(revert.isError, false, JSON.stringify(revert.json))
      assert.equal(revert.json.status, 'awaiting_approval', JSON.stringify(revert.json))
      const operation = await prisma.gatewayOperation.findUniqueOrThrow({ where: { id: revert.json.operationId } })
      assert.equal(operation.toolName, 'kb_wiki_write')
      assert.equal((await prisma.wikiPage.findFirstOrThrow({ where: { connectorId, path: 'timeline.md' } })).contentHash, timelineBefore.contentHash)
      const approved = await services.gatewayOperations.approve({
        tenantId: tenant.id,
        operationId: operation.id,
        actor: { tenantId: tenant.id, userId: owner.id, role: owner.role, assumed: false },
      })
      assert.equal(approved.ok, true, JSON.stringify(approved))
      assert.equal((await prisma.wikiChangeSet.findUniqueOrThrow({ where: { id: lastChange.id } })).status, 'reverted')
      const after = await mcp.ok('kb_wiki_changes', { definitionId, wikiId })
      assert.equal(after.changes.length, 1)
      assert.equal(after.changes[0].reverts, latest)

      // Konzol: idővonal, címke, megőrzés, kitakarás (tulajdonos; admin nem látja).
      const history = await services.wikiHistory.getPageHistory(actor(owner), connectorId, 'timeline.md')
      assert.ok(history.revisions.length >= 2)
      await assert.rejects(services.wikiHistory.getPageHistory(actor(admin), connectorId, 'timeline.md'), (error: unknown) => error instanceof WikiConsoleError && error.code === 'not_found')
      await services.wikiHistory.createTag(actor(owner), connectorId, { seq: 10, name: 'Korai állapot' })
      await services.wikiHistory.updateRetention(actor(owner), connectorId, { retentionFullDays: 30, retentionDeleteDays: 90 })
      const swept = await services.wikiHistory.sweepRetention()
      assert.ok(swept.wikis >= 1)
      assert.ok(history.revisions.length > 0)
      // GDPR: egy egyedi kifejezés a wikiben → teljes törlés; a nyers PDF-ek érintetlenek.
      const SECRET = 'Titkos Kód 4711'
      await mcp.ok('kb_wiki_write', {
        definitionId,
        wikiId,
        pages: JSON.stringify([{
          path: 'notes/titok.md', action: 'upsert', type: 'concept', title: 'Titok', summary: 'Egy titok',
          frontmatter: { sources: [{ documentId: documentIds[0] }] }, body: `Megjegyzés: ${SECRET}.`,
        }]),
        logEntry: { op: 'note', title: `Jegyzet: ${SECRET}` },
      })
      const rawFiles = await prisma.documentSourceFile.count({ where: { documentId: { in: documentIds } } })
      const preview = await services.wikiHistory.previewErasure(actor(owner), connectorId, { kind: 'text', phrase: SECRET, mode: 'erase' })
      assert.ok(preview.counts.page === 1 && preview.counts.revision === 1 && preview.counts.log === 1, JSON.stringify(preview.counts))
      const erased = await services.wikiHistory.executeErasure(actor(owner), connectorId, {
        scope: { kind: 'text', phrase: SECRET, mode: 'erase' }, reason: 'teszt kérelem', confirmName: 'Egészség-napló',
      })
      assert.equal(erased.ok, true)
      const titok = await prisma.wikiPage.findFirstOrThrow({ where: { connectorId, path: 'notes/titok.md' } })
      assert.ok(!titok.body.includes(SECRET) && titok.body.includes('[törölve]'))
      const revisions = await prisma.wikiPageRevision.findMany({ where: { pageId: titok.id }, orderBy: { version: 'asc' } })
      assert.ok(revisions[0].erasedAt && revisions[0].body === '')
      const leftovers = JSON.stringify(await prisma.wikiLogEntry.findMany({ where: { wikiId } }))
      assert.ok(!leftovers.includes(SECRET))
      assert.equal(await prisma.documentSourceFile.count({ where: { documentId: { in: documentIds } } }), rawFiles)
      const auditJson = JSON.stringify(
        await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: 'kb.wiki.erasure.executed' } }),
        (_key, value) => (typeof value === 'bigint' ? String(value) : value),
      )
      assert.ok(auditJson.length > 2 && !auditJson.includes(SECRET) && !auditJson.includes('teszt kérelem'), 'privát KB: indoklás és kifejezés sem kerül az auditba')
    })

    await check('7. végleges törlés: semmilyen tartalom nem marad (DB + nyers PDF-bájtok)', async () => {
      const wikiRow = await prisma.agentWiki.findFirstOrThrow({ where: { connectorId } })
      const pageIds = (await prisma.wikiPage.findMany({ where: { connectorId }, select: { id: true } })).map((row) => row.id)
      assert.ok((await prisma.documentSourceFile.count({ where: { documentId: { in: documentIds } } })) === 29)
      assert.ok(await prisma.wikiPageRevision.count({ where: { pageId: { in: pageIds } } }) > pageIds.length)
      await services.wikiConsole.purgePrivate(actor(owner), connectorId)
      const remaining = {
        connector: await prisma.connector.count({ where: { id: connectorId } }),
        documents: await prisma.document.count({ where: { id: { in: documentIds } } }),
        rawFiles: await prisma.documentSourceFile.count({ where: { documentId: { in: documentIds } } }),
        artifacts: await prisma.knowledgeArtifact.count({ where: { connectorId } }),
        chunks: await prisma.knowledgeChunk.count({ where: { connectorId } }),
        wiki: await prisma.agentWiki.count({ where: { connectorId } }),
        pages: await prisma.wikiPage.count({ where: { connectorId } }),
        revisions: await prisma.wikiPageRevision.count({ where: { pageId: { in: pageIds } } }),
        changeSets: await prisma.wikiChangeSet.count({ where: { connectorId } }),
        log: await prisma.wikiLogEntry.count({ where: { wikiId: wikiRow.id } }),
        agentLinks: await prisma.agentConnector.count({ where: { connectorId } }),
        // #978: címkék, agent-cursorok és törlési naplók is a wikivel együtt mennek.
        tags: await prisma.wikiTag.count({ where: { wikiId: wikiRow.id } }),
        cursors: await prisma.wikiReadCursor.count({ where: { wikiId: wikiRow.id } }),
        erasures: await prisma.wikiErasure.count({ where: { wikiId: wikiRow.id } }),
      }
      for (const [table, count] of Object.entries(remaining)) assert.equal(count, 0, `${table} maradt: ${count}`)
      const leftovers = await prisma.document.findMany({ where: { tenantId: tenant.id }, select: { contentHash: true } })
      const hashes = new Set(unique.map((upload) => createHash('sha256').update(upload.bytes).digest('hex')))
      assert.ok(!leftovers.some((doc) => doc.contentHash && hashes.has(doc.contentHash)))
      const mcp = session('after-purge', owner)
      const gone = await mcp.call('kb_get_page', { definitionId, wikiId, path: 'index.md' })
      assert.equal(gone.isError, true)
    })

    await check('8. D3: Model Gateway / külső hálózat hívása nem történt', async () => {
      assert.equal(fetchCalls, 0)
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, modelUsed: { not: null } } }), 0)
    })
  } finally {
    // Takarítás (az audit-lánc append-only, az marad).
    await prisma.handoff.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.gatewayOperation.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.document.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.connector.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.resourceGrant.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.agent.deleteMany({ where: { tenantId: tenant.id } }).catch(() => undefined)
    await prisma.$disconnect()
  }

  if (failures > 0) {
    console.log(`\n❌ ${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\n✅ minden teszt zöld')
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
