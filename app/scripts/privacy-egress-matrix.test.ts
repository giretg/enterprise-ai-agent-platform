/**
 * APG-19 — egress-mátrix csatornánként (spec §10.2).
 *
 * Futtatás: npm run test:privacy-egress-matrix
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allowsEgressResolve,
  DEFAULT_PRIVACY_EGRESS_MATRIX,
  parsePrivacyEgressMatrixLayer,
  resolvePrivacyEgressMatrix,
} from '../src/domain/privacy/privacy-egress-matrix'
import {
  createEgressDisplayLookup,
  resolveDisplayText,
  resolveEgressText,
} from '../src/domain/privacy/resolve-display-text'
import type { SurrogateEngine } from '../src/domain/privacy/surrogate-engine'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const COMPANY = '[[COMPANY_1]]'
const PERSON = '[[PERSON_1]]'
const EMAIL = '[[EMAIL_1]]'
const TENANT = '11111111-1111-1111-1111-111111111111'
const CONV = '22222222-2222-2222-2222-222222222222'
const USER = '33333333-3333-3333-3333-333333333333'

const DISPLAY: Record<string, string> = {
  [COMPANY]: 'SPAR',
  [PERSON]: 'Kovács Anna',
  [EMAIL]: 'anna@example.hu',
}

function stubEngine(): SurrogateEngine {
  return {
    async peekRef() {
      return { ok: true, record: {} }
    },
    peekDisplayValue(_tenantId: string, _scope: unknown, surrogate: string) {
      return DISPLAY[surrogate]
    },
    async resolveDisplayValue(_tenantId: string, _scope: unknown, surrogate: string) {
      return DISPLAY[surrogate]
    },
  } as unknown as SurrogateEngine
}

async function resolveForSurface(
  surface: Parameters<typeof createEgressDisplayLookup>[0]['surface'],
  text: string,
  matrix = resolvePrivacyEgressMatrix(),
) {
  const lookup = createEgressDisplayLookup({
    surface,
    engine: stubEngine(),
    tenantId: TENANT,
    scope: { type: 'conversation', id: CONV },
    requesterUserId: USER,
    matrix,
  })
  return resolveDisplayText(text, lookup)
}

async function main() {
  console.log('APG-19 egress-mátrix (csatornánként)\n')

  await test('alapértelmezett mátrix: web_ui teljes, debug_log soha', () => {
    const matrix = resolvePrivacyEgressMatrix()
    assert.equal(DEFAULT_PRIVACY_EGRESS_MATRIX.web_ui, 'full')
    assert.equal(DEFAULT_PRIVACY_EGRESS_MATRIX.debug_log, 'none')
    assert.equal(allowsEgressResolve(matrix, 'web_ui', 'person'), true)
    assert.equal(allowsEgressResolve(matrix, 'debug_log', 'company'), false)
  })

  await test('external_channel: csak company oldódik fel', async () => {
    const src = `${COMPANY} és ${PERSON}, e-mail: ${EMAIL}`
    const out = await resolveForSurface('external_channel', src)
    assert.match(out, /SPAR/)
    assert.match(out, /\[\[PERSON_1\]\]/)
    assert.match(out, /\[\[EMAIL_1\]\]/)
    assert.doesNotMatch(out, /Kovács Anna/)
    assert.doesNotMatch(out, /anna@example.hu/)
  })

  await test('web_ui: minden entitástípus feloldódik', async () => {
    const src = `${COMPANY}, ${PERSON}, ${EMAIL}`
    const out = await resolveForSurface('web_ui', src)
    assert.match(out, /SPAR/)
    assert.match(out, /Kovács Anna/)
    assert.match(out, /anna@example.hu/)
  })

  await test('platform_email: semmi nem oldódik fel', async () => {
    const src = `${COMPANY} és ${PERSON}`
    const out = await resolveForSurface('platform_email', src)
    assert.equal(out, src)
  })

  await test('export_report: alapból csak company (policy szerint)', async () => {
    const src = `${COMPANY} / ${PERSON}`
    const out = await resolveForSurface('export_report', src)
    assert.match(out, /SPAR/)
    assert.match(out, /\[\[PERSON_1\]\]/)
  })

  await test('debug_log / audit_log / model_calls: soha nem oldódik fel', async () => {
    const src = `${COMPANY} / ${PERSON}`
    for (const surface of ['debug_log', 'audit_log', 'model_calls'] as const) {
      const out = await resolveForSurface(surface, src)
      assert.equal(out, src, `${surface} feloldott`)
    }
  })

  await test('tenant overlay szigorít: external_channel company tiltása', async () => {
    const matrix = resolvePrivacyEgressMatrix({
      tenant: { external_channel: { company: false } },
    })
    const out = await resolveForSurface('external_channel', COMPANY, matrix)
    assert.equal(out, COMPANY)
  })

  await test('tenant overlay parse: csak false értékek', () => {
    const layer = parsePrivacyEgressMatrixLayer({
      external_channel: { company: false, person: true, bogus: false },
      not_a_surface: { company: false },
    })
    assert.deepEqual(layer, { external_channel: { company: false } })
  })

  await test('resolveEgressText export audit callback', async () => {
    const matrix = resolvePrivacyEgressMatrix()
    const lookup = createEgressDisplayLookup({
      surface: 'export_report',
      engine: stubEngine(),
      tenantId: TENANT,
      scope: { type: 'conversation', id: CONV },
      requesterUserId: USER,
      matrix,
    })
    const auditEvents: Array<{ categories: string[] }> = []
    await resolveEgressText(`${COMPANY} / ${PERSON}`, lookup, {
      surface: 'export_report',
      onResolved: async (event) => {
        auditEvents.push(event)
      },
    })
    assert.equal(auditEvents.length, 1)
    assert.deepEqual(auditEvents[0]!.categories.sort(), ['company'])
  })

  await test('APG-19: a produkciós kimenetek a közös resolveEgressTextForSurface nyelőt hívják', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const chat = readFileSync(join(root, 'src/domain/agent/agent-chat-runtime.ts'), 'utf8')
    const display = readFileSync(join(root, 'src/domain/privacy/resolve-display-text.ts'), 'utf8')
    const wiring = readFileSync(join(root, 'src/domain/index.ts'), 'utf8')
    assert.match(chat, /resolveEgressTextForSurface\(/)
    assert.match(display, /surface: 'web_ui'/)
    assert.match(display, /surface: 'external_channel'/)
    assert.match(wiring, /resolveChannelOutboundText\(/)
    assert.equal(
      /function resolvePlatformEmailEgressText|export async function resolvePlatformEmailEgressText/.test(display),
      false,
      'ne legyen külön, hívatlan e-mail wrapper — a platform e-mail transport még nincs; a nyelő resolveEgressTextForSurface',
    )
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} hiba.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
