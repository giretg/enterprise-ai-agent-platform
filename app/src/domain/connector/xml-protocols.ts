/**
 * XML-alapú magyar számlázási API-k adapterei a http_api connector mögött.
 *
 * A modell a szokásos http_api_get / http_api_request eszközzel hív egyszerű,
 * virtuális végpontokat (GET query-paraméterekkel, POST JSON body-val); az adapter
 * ebből építi a valódi kérést:
 *   - `szamlazz_agent`: Számlázz.hu Számla Agent — multipart XML, a kulcs az XML-ben.
 *   - `nav_online_invoice`: NAV Online Számla 3.0 lekérdezések — aláírt XML.
 * A titok itt kerül be a kérésbe, sosem a modell kezébe.
 */
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { HttpApiProtocol } from '@/domain/provisioning/connector-config'
import type { NavSoftware } from '@/lib/nav-online-invoice-software'

export type ProtocolCall = {
  method: string
  path: string
  query?: Record<string, string | number | boolean>
  body?: unknown
}

export type ProtocolOptions = {
  navTaxNumber?: string
  loadNavSoftware?: () => Promise<NavSoftware | null>
  now?: Date
}

export type ProtocolResult = { ok: boolean; body: unknown; errorCode?: string; hint?: string }

export class ProtocolRequestError extends Error {
  constructor(
    message: string,
    readonly code: string = 'invalid_args',
  ) {
    super(message)
    this.name = 'ProtocolRequestError'
  }
}

type Query = NonNullable<ProtocolCall['query']>
type ChildOrder = Record<string, readonly string[]>

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const XML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]!)
}

/** JSON → XML elem. Tömb = ismételt elem; `order` a séma szerinti gyerek-sorrend. */
export function xmlElement(name: string, value: unknown, order: ChildOrder = {}): string {
  if (value === undefined || value === null || value === '') return ''
  if (!XML_NAME.test(name)) throw new ProtocolRequestError(`invalid XML element name: ${name}`)
  if (Array.isArray(value)) return value.map((item) => xmlElement(name, item, order)).join('')
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const rank = order[name]
    if (rank) {
      const pos = (key: string) => (rank.includes(key) ? rank.indexOf(key) : rank.length)
      entries.sort(([a], [b]) => pos(a) - pos(b))
    }
    return `<${name}>${entries.map(([key, item]) => xmlElement(key, item, order)).join('')}</${name}>`
  }
  return `<${name}>${escapeXml(String(value))}</${name}>`
}

function xmlText(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`))
  return match?.[1]?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolRequestError(`${what} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requiredParam(query: Query | undefined, name: string): string {
  const value = query?.[name]
  if (value === undefined || String(value).trim() === '') {
    throw new ProtocolRequestError(`missing query parameter: ${name}`)
  }
  return String(value).trim()
}

function operationKey(call: ProtocolCall): string {
  const path = `/${call.path.split('?')[0]!.replace(/^\/+|\/+$/g, '')}`
  return `${call.method.toUpperCase()} ${path}`
}

// ── Számlázz.hu Számla Agent ─────────────────────────────────────────────────

/** Az xmlszamla / xmlszamlast / xmlszamlakifiz XSD-k kötött elem-sorrendje. */
const SZAMLAZZ_ORDER: ChildOrder = {
  fejlec: [
    'szamlaszam', 'keltDatum', 'teljesitesDatum', 'fizetesiHataridoDatum', 'fizmod', 'penznem',
    'szamlaNyelve', 'megjegyzes', 'arfolyamBank', 'arfolyam', 'rendelesSzam', 'dijbekeroSzamlaszam',
    'elolegszamla', 'vegszamla', 'elolegSzamlaszam', 'helyesbitoszamla', 'helyesbitettSzamlaszam',
    'dijbekero', 'szallitolevel', 'logoExtra', 'szamlaszamElotag', 'fizetendoKorrekcio', 'fizetve',
    'arresAfa', 'eusAfa', 'tipus', 'szamlaSablon', 'simpleItems', 'elonezetpdf',
  ],
  elado: ['bank', 'bankszamlaszam', 'emailReplyto', 'emailTargy', 'emailSzoveg', 'alairoNeve'],
  vevo: [
    'nev', 'orszag', 'irsz', 'telepules', 'cim', 'email', 'sendEmail', 'adoalany', 'adoszam',
    'csoportazonosito', 'adoszamEU', 'postazasiNev', 'postazasiOrszag', 'postazasiIrsz',
    'postazasiTelepules', 'postazasiCim', 'vevoFokonyv', 'azonosito', 'alairoNeve', 'telefonszam',
    'megjegyzes',
  ],
  tetel: [
    'megnevezes', 'azonosito', 'mennyiseg', 'mennyisegiEgyseg', 'nettoEgysegar', 'afakulcs',
    'arresAfaAlap', 'nettoErtek', 'afaErtek', 'bruttoErtek', 'megjegyzes', 'tetelFokonyv', 'torloKod',
  ],
  kifizetes: ['datum', 'jogcim', 'osszeg', 'leiras'],
}

type SzamlazzAction = {
  field: string
  root: string
  build: (key: string, call: ProtocolCall) => Record<string, unknown>
}

function szamlazzSettings(key: string, body: Record<string, unknown>) {
  const requested = typeof body.beallitasok === 'object' && body.beallitasok !== null
    ? (body.beallitasok as Record<string, unknown>)
    : {}
  // A modell csak az e-számla jelzőt és a külső azonosítót adhatja meg; a hitelesítést
  // és a válaszformát (XML, PDF nélkül) az adapter rögzíti.
  return {
    szamlaagentkulcs: key,
    eszamla: requested.eszamla ?? true,
    szamlaLetoltes: false,
    valaszVerzio: 2,
    szamlaKulsoAzon: requested.szamlaKulsoAzon,
  }
}

const SZAMLAZZ_ACTIONS: Record<string, SzamlazzAction> = {
  'GET /invoice': {
    field: 'action-szamla_agent_xml',
    root: 'xmlszamlaxml',
    build: (key, { query }) => {
      if (!query?.szamlaszam && !query?.rendelesSzam && !query?.szamlaKulsoAzon) {
        throw new ProtocolRequestError('szamlaszam, rendelesSzam vagy szamlaKulsoAzon query parameter is required')
      }
      return {
        szamlaagentkulcs: key,
        szamlaszam: query.szamlaszam,
        rendelesSzam: query.rendelesSzam,
        pdf: false,
        szamlaKulsoAzon: query.szamlaKulsoAzon,
      }
    },
  },
  'GET /taxpayer': {
    field: 'action-szamla_agent_taxpayer',
    root: 'xmltaxpayer',
    build: (key, { query }) => ({
      beallitasok: { szamlaagentkulcs: key },
      torzsszam: requiredParam(query, 'torzsszam').replace(/\D/g, '').slice(0, 8),
    }),
  },
  'POST /invoice': {
    field: 'action-xmlagentxmlfile',
    root: 'xmlszamla',
    build: (key, { body }) => {
      const b = asRecord(body, 'body')
      const items = Array.isArray(b.tetelek)
        ? b.tetelek
        : (b.tetelek as { tetel?: unknown } | undefined)?.tetel
      return {
        beallitasok: szamlazzSettings(key, b),
        fejlec: asRecord(b.fejlec, 'fejlec'),
        elado: b.elado ?? {},
        vevo: asRecord(b.vevo, 'vevo'),
        tetelek: { tetel: items },
      }
    },
  },
  'POST /invoice/reverse': {
    field: 'action-szamla_agent_st',
    root: 'xmlszamlast',
    build: (key, { body }) => {
      const b = asRecord(body, 'body')
      return {
        beallitasok: szamlazzSettings(key, b),
        fejlec: { ...asRecord(b.fejlec, 'fejlec'), tipus: 'SS' },
        elado: b.elado,
        vevo: b.vevo,
      }
    },
  },
  'POST /invoice/payment': {
    field: 'action-szamla_agent_kifiz',
    root: 'xmlszamlakifiz',
    build: (key, { body }) => {
      const b = asRecord(body, 'body')
      return {
        beallitasok: {
          szamlaagentkulcs: key,
          szamlaszam: b.szamlaszam,
          additiv: b.additiv ?? true,
        },
        kifizetes: b.kifizetes,
      }
    },
  },
}

function buildSzamlazzRequest(baseUrl: string, call: ProtocolCall, key: string) {
  const action = SZAMLAZZ_ACTIONS[operationKey(call)]
  if (!action) throw new ProtocolRequestError(`unsupported Számlázz.hu operation: ${operationKey(call)}`)
  const children = Object.entries(action.build(key, call))
    .map(([name, value]) => xmlElement(name, value, SZAMLAZZ_ORDER))
    .join('')
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${action.root} xmlns="http://www.szamlazz.hu/${action.root}">${children}</${action.root}>`
  const form = new FormData()
  form.append(action.field, new Blob([xml], { type: 'text/xml' }), 'request.xml')
  return { url: `${baseUrl}/`, init: { method: 'POST', body: form } satisfies RequestInit, xml }
}

function safeDecode(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

async function parseSzamlazzResponse(res: Response): Promise<ProtocolResult> {
  const text = await res.text()
  const errorCode = res.headers.get('szlahu_error_code') ?? xmlText(text, 'hibakod')
  const message = safeDecode(res.headers.get('szlahu_error')) ?? xmlText(text, 'hibauzenet')
  const failed = !res.ok || Boolean(errorCode) || /<sikeres>\s*false/.test(text) || text.startsWith('[ERR]')
  return {
    ok: !failed,
    body: text.replace(/<pdf>[\s\S]*?<\/pdf>/, '<pdf>[kihagyva]</pdf>'),
    ...(errorCode ? { errorCode } : {}),
    ...(failed
      ? { hint: `Számlázz.hu hiba${errorCode ? ` (${errorCode})` : ''}: ${message ?? text.slice(0, 300)}` }
      : {}),
  }
}

// ── NAV Online Számla 3.0 (csak lekérdezés) ─────────────────────────────────

type NavCredentials = { login: string; password: string; signKey: string }

function parseNavCredentials(secret: string): NavCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    parsed = null
  }
  const creds = parsed as Partial<NavCredentials> | null
  if (!creds?.login?.trim() || !creds.password || !creds.signKey?.trim()) {
    throw new ProtocolRequestError(
      'A NAV konnektor titka hiányos: aktiváld újra a technikai felhasználó nevével, jelszavával és XML aláírókulcsával.',
      'nav_credentials_invalid',
    )
  }
  return { login: creds.login.trim(), password: creds.password, signKey: creds.signKey.trim() }
}

function direction(query: Query | undefined): string {
  const value = String(query?.direction ?? 'OUTBOUND').toUpperCase()
  if (value !== 'OUTBOUND' && value !== 'INBOUND') {
    throw new ProtocolRequestError('direction must be OUTBOUND (kimenő) or INBOUND (bejövő)')
  }
  return value
}

const NAV_OPERATIONS: Record<string, { op: string; build: (query: Query | undefined) => Record<string, unknown> }> = {
  'GET /taxpayer': {
    op: 'queryTaxpayer',
    build: (q) => ({ taxNumber: requiredParam(q, 'taxNumber').replace(/\D/g, '').slice(0, 8) }),
  },
  'GET /invoices': {
    op: 'queryInvoiceDigest',
    build: (q) => ({
      page: q?.page ?? 1,
      invoiceDirection: direction(q),
      invoiceQueryParams: {
        mandatoryQueryParams: {
          invoiceIssueDate: { dateFrom: requiredParam(q, 'dateFrom'), dateTo: requiredParam(q, 'dateTo') },
        },
        additionalQueryParams:
          q?.partnerTaxNumber || q?.partnerName
            ? { taxNumber: q.partnerTaxNumber, name: q.partnerName }
            : undefined,
      },
    }),
  },
  'GET /invoice': {
    op: 'queryInvoiceData',
    build: (q) => ({ invoiceNumberQuery: navInvoiceNumberQuery(q) }),
  },
  'GET /invoice/check': {
    op: 'queryInvoiceCheck',
    build: (q) => ({ invoiceNumberQuery: navInvoiceNumberQuery(q) }),
  },
  'GET /invoice/chain': {
    op: 'queryInvoiceChainDigest',
    build: (q) => ({
      page: q?.page ?? 1,
      invoiceChainQuery: {
        invoiceNumber: requiredParam(q, 'invoiceNumber'),
        invoiceDirection: direction(q),
        taxNumber: q?.taxNumber,
      },
    }),
  },
}

function navInvoiceNumberQuery(q: Query | undefined) {
  return {
    invoiceNumber: requiredParam(q, 'invoiceNumber'),
    invoiceDirection: direction(q),
    batchIndex: q?.batchIndex,
    supplierTaxNumber: q?.supplierTaxNumber,
  }
}

const sha = (algorithm: 'sha512' | 'sha3-512', input: string) =>
  createHash(algorithm).update(input, 'utf8').digest('hex').toUpperCase()

async function defaultLoadNavSoftware(): Promise<NavSoftware | null> {
  const { loadNavSoftware } = await import('@/lib/nav-online-invoice-software')
  return loadNavSoftware()
}

async function buildNavRequest(baseUrl: string, call: ProtocolCall, secret: string, opts: ProtocolOptions) {
  const operation = NAV_OPERATIONS[operationKey(call)]
  if (!operation) throw new ProtocolRequestError(`unsupported NAV operation: ${operationKey(call)}`)
  const taxNumber = opts.navTaxNumber?.trim()
  if (!taxNumber) throw new ProtocolRequestError('NAV connector has no taxpayer tax number (nav.taxNumber)')
  const creds = parseNavCredentials(secret)
  const software = await (opts.loadNavSoftware ?? defaultLoadNavSoftware)()
  if (!software) {
    throw new ProtocolRequestError(
      'A NAV Online Számla szoftver-azonosító nincs beállítva: Platform · Beállítások → NAV Online Számla.',
      'nav_software_missing',
    )
  }
  const body = Object.entries(operation.build(call.query))
    .map(([name, value]) => xmlElement(name, value))
    .join('')

  // NAV 3.0 §1.5.2: lekérdezésnél requestSignature = SHA3-512(requestId + UTC yyyyMMddHHmmss + aláírókulcs).
  const requestId = `EXC${randomBytes(12).toString('hex')}`.slice(0, 30)
  const timestamp = (opts.now ?? new Date()).toISOString()
  const signatureTime = timestamp.slice(0, 19).replace(/[-:T]/g, '')
  const root = `${operation.op[0]!.toUpperCase()}${operation.op.slice(1)}Request`
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">` +
    `<common:header><common:requestId>${requestId}</common:requestId><common:timestamp>${timestamp}</common:timestamp>` +
    `<common:requestVersion>3.0</common:requestVersion><common:headerVersion>1.0</common:headerVersion></common:header>` +
    `<common:user><common:login>${escapeXml(creds.login)}</common:login>` +
    `<common:passwordHash cryptoType="SHA-512">${sha('sha512', creds.password)}</common:passwordHash>` +
    `<common:taxNumber>${escapeXml(taxNumber)}</common:taxNumber>` +
    `<common:requestSignature cryptoType="SHA3-512">${sha('sha3-512', requestId + signatureTime + creds.signKey)}</common:requestSignature></common:user>` +
    xmlElement('software', {
      softwareId: software.softwareId,
      softwareName: software.softwareName,
      softwareOperation: 'ONLINE_SERVICE',
      softwareMainVersion: software.softwareMainVersion,
      softwareDevName: software.softwareDevName,
      softwareDevContact: software.softwareDevContact,
      softwareDevCountryCode: software.softwareDevCountryCode,
      softwareDevTaxNumber: software.softwareDevTaxNumber,
    }) +
    `${body}</${root}>`
  return {
    url: `${baseUrl}/${operation.op}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/xml', accept: 'application/xml' },
      body: xml,
    } satisfies RequestInit,
    xml,
  }
}

async function parseNavResponse(res: Response): Promise<ProtocolResult> {
  const text = await res.text()
  const funcCode = xmlText(text, 'funcCode')
  const errorCode = xmlText(text, 'errorCode')
  const ok = res.ok && funcCode !== 'ERROR'
  if (!ok) {
    return {
      ok,
      body: text,
      ...(errorCode ? { errorCode } : {}),
      hint: `NAV hiba${errorCode ? ` (${errorCode})` : ''}: ${xmlText(text, 'message') ?? `HTTP ${res.status}`}`,
    }
  }
  const invoiceData = xmlText(text, 'invoiceData')
  if (!invoiceData) return { ok, body: text }
  const raw = Buffer.from(invoiceData, 'base64')
  const compressed = xmlText(text, 'compressedContentIndicator') === 'true'
  return {
    ok,
    body: {
      response: text.replace(invoiceData, '[dekódolva: invoiceXml]'),
      invoiceXml: (compressed ? gunzipSync(raw) : raw).toString('utf8'),
    },
  }
}

// ── Közös belépési pont ─────────────────────────────────────────────────────

export async function buildProtocolRequest(
  protocol: HttpApiProtocol,
  baseUrl: string,
  call: ProtocolCall,
  secret: string,
  opts: ProtocolOptions = {},
): Promise<{ url: string; init: RequestInit; xml: string }> {
  return protocol === 'szamlazz_agent'
    ? buildSzamlazzRequest(baseUrl, call, secret.trim())
    : buildNavRequest(baseUrl, call, secret, opts)
}

export function parseProtocolResponse(protocol: HttpApiProtocol, res: Response): Promise<ProtocolResult> {
  return protocol === 'szamlazz_agent' ? parseSzamlazzResponse(res) : parseNavResponse(res)
}

/**
 * Aktiválás előtti hitelesítő próba: egy valódi, nem módosító hívás. A Számlázz.hu-nál
 * egy nem létező számla lekérése — a 7-es hibakód (ismeretlen számla) sikeres belépést jelent.
 */
export function protocolProbe(
  protocol: HttpApiProtocol,
  navTaxNumber?: string,
): { call: Required<Omit<ProtocolCall, 'body'>>; acceptErrorCodes: string[] } {
  return protocol === 'szamlazz_agent'
    ? { call: { method: 'GET', path: '/invoice', query: { szamlaszam: 'EXC-PROBE-0' } }, acceptErrorCodes: ['7'] }
    : { call: { method: 'GET', path: '/taxpayer', query: { taxNumber: navTaxNumber ?? '' } }, acceptErrorCodes: [] }
}
