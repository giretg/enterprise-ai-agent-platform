/**
 * Ostoros CRM próba: jó adatot ad-e a CRM ahhoz, hogy a privacy-gateway
 * tokenizálni tudjon (#272).
 *
 * A jelölést a FORRÁS katalógusa adja (`GET /privacy/catalog`); a platform nem
 * találja ki, mit kell tokenizálni. Ha a CRM nem ad katalógust, a próba ezt
 * hibaként jelzi, és csak összehasonlításként méri a referencia-katalógussal.
 *
 * Nem elég, hogy a CRM válaszol: a tokenizáció NÉMÁN kimarad, ha
 *  - a válaszban nincs egyetlen deklarált `tokenize` mező sem (más a mezőnév),
 *  - a `source_id` sablon testvérmezője (`id`) hiányzik vagy üres (spec §5.3),
 *  - a cégnév/PII olyan mezőben jön, amit a katalógus nem jelöl.
 * A szkript mindhármat megméri az ÉLES válaszon, majd lefuttatja a valódi
 * transzformációt in-memory vaulttal, és megmutatja, mi menne a modellhez.
 *
 * Futtatás (ott, ahol a CRM elérhető):
 *   CRM_HOST=crm.pelda.hu CRM_API_KEY=... CRM_ACTING_USER=user@ceg.hu \
 *     npm run probe:crm-privacy
 *
 * Alapból NEM ír ki nyers értéket (csak mezőneveket és igen/nem ítéletet).
 * Nyers minta: `--show-values`.
 */
import { randomUUID } from 'node:crypto'

import {
  OSTOROSBOR_CRM_PRIVACY_FIELDS,
  parsePrivacyCatalogV2,
  privacyCatalogToConnectorConfigPatch,
  reviewPrivacyCatalogDeclarations,
  type ConnectorFieldsPrivacy,
  type PrivacyUnlistedDefault,
} from '../src/domain/privacy/connector-privacy'
import { SurrogateEngine } from '../src/domain/privacy/surrogate-engine'
import { transformStructuredOutput } from '../src/domain/privacy/structured-output-transform'
import type { PrivacyScope } from '../src/domain/privacy/surrogate-vault'
import { describePrivacyTransformFailure } from '../src/domain/privacy/privacy-transform-failure'
import { InMemorySurrogateVault } from './test-in-memory-surrogate-vault'

const SHOW_VALUES = process.argv.includes('--show-values')
const HOST = process.env.CRM_HOST
const API_KEY = process.env.CRM_API_KEY
const ACTING_USER = process.env.CRM_ACTING_USER

/** Kulcsnevek, amelyek tipikusan védendő adatot hordoznak (jelöletlen szivárgás gyanúja). */
const PII_KEY_HINT =
  /(name|email|phone|mobile|contact|iban|account|address|cim|tax|adoszam|szemely|person|company|ceg)/i

const READ_ENDPOINTS = [
  '/accounts?limit=3',
  '/quotes?limit=3',
  '/inquiries?limit=3',
  '/interactions?limit=3',
  '/documents?limit=3',
]

type Finding = { level: 'ok' | 'warn' | 'error'; text: string }

function icon(level: Finding['level']): string {
  return level === 'ok' ? '  ✓' : level === 'warn' ? '  ⚠' : '  ✗'
}

/** A válasz rekordjai: tömb, vagy `rows`/`items`/`data` burkolat, vagy egyetlen objektum. */
function extractRecords(payload: unknown): Record<string, unknown>[] {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []
  for (const key of ['rows', 'items', 'data', 'results', 'accounts']) {
    const nested = payload[key]
    if (Array.isArray(nested)) return nested.filter(isRecord)
  }
  return [payload]
}

function sourceIdPlaceholders(template: string | undefined): string[] {
  if (!template) return []
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
}

function preview(value: unknown): string {
  if (!SHOW_VALUES) return '‹elrejtve›'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

function auditRecords(
  records: Record<string, unknown>[],
  fields: ConnectorFieldsPrivacy,
  unlistedDefault: PrivacyUnlistedDefault,
): Finding[] {
  const findings: Finding[] = []
  const declaredTokenize = Object.entries(fields).filter(([, f]) => f.privacy === 'tokenize')
  const presentKeys = new Set(records.flatMap((r) => Object.keys(r)))

  const hitKeys = declaredTokenize.filter(([key]) => presentKeys.has(key)).map(([key]) => key)
  if (hitKeys.length === 0) {
    findings.push({
      level: 'error',
      text: `egyetlen deklarált tokenize mező sem szerepel a válaszban (várt: ${declaredTokenize
        .map(([k]) => k)
        .join(', ')}; kapott kulcsok: ${[...presentKeys].join(', ') || '‹nincs›'}) — a tokenizáció NÉMÁN kimarad`,
    })
  } else {
    findings.push({ level: 'ok', text: `tokenizálható mező a válaszban: ${hitKeys.join(', ')}` })
  }

  // source_id testvér — enélkül a platform nem cserél, a nyers érték megy ki (spec §5.3).
  for (const [key, field] of declaredTokenize) {
    if (!presentKeys.has(key)) continue
    for (const placeholder of sourceIdPlaceholders(field.source_id)) {
      const missing = records.filter((r) => {
        if (r[key] === undefined || r[key] === null || r[key] === '') return false
        const sibling = r[placeholder]
        return sibling === undefined || sibling === null || sibling === ''
      })
      if (missing.length > 0) {
        findings.push({
          level: 'error',
          text: `${key}: ${missing.length}/${records.length} rekordban hiányzik a source_id testvér (\`${placeholder}\`, sablon: ${field.source_id}) — ENFORCE alatt ez fail-closed hibával megállítja a hívást`,
        })
      } else {
        findings.push({
          level: 'ok',
          text: `${key}: a source_id testvér (\`${placeholder}\`) minden rekordban megvan`,
        })
      }
    }
  }

  // Típusegyezés: numerikus/dátum mezőt sosem tokenizálunk (spec R6).
  for (const [key, field] of Object.entries(fields)) {
    if (!presentKeys.has(key)) continue
    const wrong = records.filter((r) => {
      const value = r[key]
      if (value === undefined || value === null) return false
      if (field.type === 'string') return typeof value !== 'string'
      if (field.type === 'number' || field.type === 'integer') return typeof value !== 'number'
      return false
    })
    if (wrong.length > 0) {
      findings.push({
        level: 'warn',
        text: `${key}: a katalógus \`${field.type}\` típust deklarál, de a CRM mást küld (${wrong.length}/${records.length} rekordban)`,
      })
    }
  }

  // Jelöletlen, PII-gyanús string mezők — ezek nyersen mennének a modellhez.
  const undeclared = [...presentKeys].filter((key) => {
    if (fields[key]) return false
    if (!PII_KEY_HINT.test(key)) return false
    return records.some((r) => typeof r[key] === 'string' && (r[key] as string).trim() !== '')
  })
  if (undeclared.length > 0) {
    const sample = records.find((r) => typeof r[undeclared[0]] === 'string')
    findings.push(
      unlistedDefault === 'block'
        ? {
            level: 'ok',
            text: `jelöletlen, védendőnek látszó mező: ${undeclared.join(', ')} — a katalógus \`unlisted_default: block\` beállítása miatt NEM megy ki a modellhez`,
          }
        : {
            level: 'warn',
            text: `jelöletlen, védendőnek látszó mező: ${undeclared.join(', ')} — nyersen megy a modellhez (pl. ${undeclared[0]}=${preview(sample?.[undeclared[0]])}); \`unlisted_default: block\` deklarálásával kizárható`,
          },
    )
  }

  return findings
}

/** Valódi transzformáció in-memory vaulttal: mi menne ténylegesen a modellhez. */
async function transformProbe(
  records: Record<string, unknown>[],
  fields: ConnectorFieldsPrivacy,
  unlistedDefault: PrivacyUnlistedDefault,
): Promise<Finding[]> {
  const scope: PrivacyScope = { type: 'conversation', id: randomUUID() }
  const engine = new SurrogateEngine(new InMemorySurrogateVault(), {
    async recordUnknownSurrogate() {},
    async recordResolveDenied() {},
  })
  let output: unknown
  let spans: { entityType: string }[]
  try {
    const result = await transformStructuredOutput({
      output: { rows: records },
      fields,
      unlistedDefault,
      engine,
      tenantId: randomUUID(),
      connectorId: randomUUID(),
      scope,
      apply: true,
    })
    output = result.output
    spans = result.spans
  } catch (error) {
    // ENFORCE alatt ez a valóságban a tool-hívás leállása (fail-closed, spec §15).
    return [
      {
        level: 'error',
        text: `ENFORCE alatt ez a válasz MEGÁLLÍTANÁ a tool-hívást — ok: ${describePrivacyTransformFailure(error)}`,
      },
    ]
  }
  const modelText = JSON.stringify(output)

  if (spans.length === 0) {
    return [{ level: 'error', text: 'a transzformáció 0 spant talált — a modell a nyers választ kapná' }]
  }
  const findings: Finding[] = [
    { level: 'ok', text: `${spans.length} span cserélve (${spans.map((s) => s.entityType).join(', ')})` },
  ]
  // Visszaszivárgás-ellenőrzés: a tokenizált mezők nyers értéke nem maradhat a modellcsatornában.
  const leaked = records.flatMap((record) =>
    Object.entries(fields)
      .filter(([key, f]) => f.privacy === 'tokenize' && typeof record[key] === 'string')
      .filter(([key]) => modelText.includes(record[key] as string))
      .map(([key]) => key),
  )
  findings.push(
    leaked.length === 0
      ? { level: 'ok', text: 'a modellcsatornában egyetlen tokenizált nyers érték sem maradt' }
      : { level: 'error', text: `nyers érték maradt a modellcsatornában: ${[...new Set(leaked)].join(', ')}` },
  )
  if (SHOW_VALUES) findings.push({ level: 'ok', text: `modelText: ${modelText.slice(0, 300)}` })
  return findings
}

type SourceCatalog = {
  fields: ConnectorFieldsPrivacy
  unlistedDefault: PrivacyUnlistedDefault
  findings: Finding[]
  fromSource: boolean
}

/** D5 — a `pass`-ra jelölt string mezők élő mintaértékein futó titok-heurisztika. */
function reviewPassDeclarations(
  records: Record<string, unknown>[],
  fields: ConnectorFieldsPrivacy,
): Finding[] {
  return reviewPrivacyCatalogDeclarations({ fields }, records).map((warning) => ({
    level: 'warn' as const,
    text: `${warning.field}: ${warning.reason} — \`pass\` jelölésű mezőben titoknak látszó érték, a katalógusban felülvizsgálandó`,
  }))
}

/**
 * A jelölés kanonikus helye a forrásrendszer (forrás-szerződés §2 / §6.1).
 * A próba ezért a CRM saját katalógusát kéri le; a platform referencia-katalógusa
 * csak akkor lép be, ha a forrás nem nyilatkozik — és akkor is hibaként jelezve,
 * mert így éles úton sem a forrás leírásából jönne a tokenizálandó mezők listája.
 */
async function loadSourceCatalog(baseUrl: string, headers: Record<string, string>): Promise<SourceCatalog> {
  const fallback = (findings: Finding[]): SourceCatalog => ({
    fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
    unlistedDefault: 'pass',
    findings,
    fromSource: false,
  })
  let response: Response
  try {
    response = await fetch(`${baseUrl}/privacy/catalog`, { headers })
  } catch (error) {
    return fallback([
      {
        level: 'error',
        text: `GET /privacy/catalog nem érhető el (${error instanceof Error ? error.message : error}) — a mezőjelölés nem a forrásból jön; a próba a platform referencia-katalógusával mér tovább`,
      },
    ])
  }
  if (!response.ok) {
    return fallback([
      {
        level: 'error',
        text: `GET /privacy/catalog → HTTP ${response.status} — a forrás nem publikál katalógust; a próba a platform referencia-katalógusával mér tovább`,
      },
    ])
  }
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return fallback([{ level: 'error', text: 'GET /privacy/catalog válasza nem JSON' }])
  }
  const catalog = parsePrivacyCatalogV2(raw)
  if (!catalog) {
    return fallback([
      {
        level: 'error',
        text: 'GET /privacy/catalog válasza nem felel meg a katalógus-sémának (entity_types / fields / tokenize szabályok) — a platform nem veheti át a jelölést',
      },
    ])
  }
  const patch = privacyCatalogToConnectorConfigPatch(catalog)
  const findings: Finding[] = [
    {
      level: 'ok',
      text: `katalógus v${patch.catalog_version} a forrásból: ${
        Object.entries(patch.fields).filter(([, f]) => f.privacy === 'tokenize').length
      } tokenize mező, unlisted_default: ${patch.unlisted_default ?? 'pass'}`,
    },
  ]
  return {
    fields: patch.fields,
    unlistedDefault: patch.unlisted_default ?? 'pass',
    findings,
    fromSource: true,
  }
}

async function main() {
  if (!HOST || !API_KEY) {
    console.error(
      'Hiányzó környezet. Futtatás:\n  CRM_HOST=crm.pelda.hu CRM_API_KEY=... CRM_ACTING_USER=user@ceg.hu npm run probe:crm-privacy',
    )
    process.exit(2)
  }
  const scheme = /^http:\/\//.test(HOST) ? 'http' : 'https'
  const baseUrl = `${scheme}://${HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/connector/v1`
  console.log(`Ostoros CRM privacy-próba — ${baseUrl}`)
  console.log(SHOW_VALUES ? '(nyers minták BE)\n' : '(nyers értékek elrejtve; --show-values kapcsolóval láthatók)\n')

  const authHeaders = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
    ...(ACTING_USER ? { 'X-Acting-User': ACTING_USER } : {}),
  }

  let hardFailure = false

  console.log('── GET /privacy/catalog')
  const catalog = await loadSourceCatalog(baseUrl, {
    ...authHeaders,
    'X-Connector-Call-Id': randomUUID(),
  })
  for (const finding of catalog.findings) {
    console.log(`${icon(finding.level)} ${finding.text}`)
    if (finding.level === 'error') hardFailure = true
  }
  console.log()

  for (const endpoint of READ_ENDPOINTS) {
    console.log(`── GET ${endpoint}`)
    let response: Response
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        headers: { ...authHeaders, 'X-Connector-Call-Id': randomUUID() },
      })
    } catch (error) {
      console.log(`${icon('error')} nem érhető el: ${error instanceof Error ? error.message : error}`)
      hardFailure = true
      continue
    }
    if (!response.ok) {
      console.log(`${icon('error')} HTTP ${response.status} — ${(await response.text()).slice(0, 200)}`)
      hardFailure = true
      continue
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      console.log(`${icon('error')} a válasz nem JSON`)
      hardFailure = true
      continue
    }
    const records = extractRecords(payload)
    console.log(`${icon('ok')} HTTP ${response.status}, ${records.length} rekord`)
    if (records.length === 0) {
      console.log(`${icon('warn')} nincs rekord — üres adatbázison a tokenizáció nem mérhető`)
      continue
    }
    const findings = [
      ...auditRecords(records, catalog.fields, catalog.unlistedDefault),
      ...reviewPassDeclarations(records, catalog.fields),
      ...(await transformProbe(records, catalog.fields, catalog.unlistedDefault)),
    ]
    for (const finding of findings) {
      console.log(`${icon(finding.level)} ${finding.text}`)
      if (finding.level === 'error') hardFailure = true
    }
    console.log()
  }

  console.log(
    hardFailure
      ? 'Eredmény: a CRM válasza NEM elég a tokenizációhoz — a fenti ✗ sorok a némán kimaradó okok.'
      : 'Eredmény: a CRM válasza alkalmas a tokenizációra.',
  )
  if (!catalog.fromSource) {
    console.log(
      'Figyelem: a fenti mérés a platform referencia-katalógusával készült, nem a forrás deklarációjából.',
    )
  }
  process.exit(hardFailure ? 1 : 0)
}

void main()
