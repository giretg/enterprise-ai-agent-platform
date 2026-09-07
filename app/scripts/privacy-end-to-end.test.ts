/**
 * AI Privacy Gateway — végponttól végpontig (#272).
 *
 * Ez a teszt azt a használati utat járja végig, amit egy felhasználó ténylegesen
 * kipróbál, és amin a fejlesztés eddig elhasalt:
 *
 * 1. ENFORCE módban egy sima chat-üzenetben lévő telefonszám és bankszámlaszám
 *    álnevet kap (eddig egyetlen alapértelmezett kategóriához sem volt felismerés).
 * 2. A CRM tool-válasz cégneve álnevet kap, és a UI a valódi nevet mutatja.
 * 3. Szerver-újraindítás (új engine-példány, ugyanaz a vault) után a beszélgetés
 *    újranyitása is a valódi nevet mutatja — nem `[[COMPANY_1]]`-et.
 * 4. Újraindítás után a következő fordulóban ugyanaz a cégnév ismét álnévre
 *    cserélődik (ismert-érték szótár a vaultból), nem megy ki nyersen.
 * 5. Feladat-ticket kontextus (nincs `Conversation` sor) sem áll meg fail-closed
 *    hibával a szabad szöveges találaton.
 * 6. OBSERVE módban mérhető fedettség keletkezik, a szöveg viszont nem változik.
 *
 * Futtatás: npm run test:privacy-end-to-end
 */
import assert from 'node:assert/strict'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import { resolvePrivacyCategoryPolicy } from '../src/domain/privacy/privacy-category-policy'
import { transformPromptMessages } from '../src/domain/privacy/prompt-privacy-transform'
import { resolveEgressTextForSurface } from '../src/domain/privacy/resolve-display-text'
import { resolveToolArgs } from '../src/domain/privacy/resolve-tool-args'
import { transformStructuredOutput } from '../src/domain/privacy/structured-output-transform'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import type { PrivacyScope } from '../src/domain/privacy/surrogate-vault'
import type { ConversationPrivacyKeyRepository } from '../src/repositories/interfaces'
import {
  InMemoryPrivacyKeyRepository,
  InMemorySurrogateVault,
} from './test-in-memory-surrogate-vault'

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

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const TICKET = 'ffffffff-0000-4000-8000-000000000006'
const SCOPE: PrivacyScope = { type: 'conversation', id: CONVERSATION }
const TICKET_SCOPE: PrivacyScope = { type: 'conversation', id: TICKET }

const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
const PHONE = '+36 30 123 4567'
const ACCOUNT = '11773016-11111018'
const EMAIL = 'gergely.giret@itnatives.io'

const silentAudit: PrivacyAuditSink = {
  async recordUnknownSurrogate() {},
  async recordResolveDenied() {},
}

type Fixture = {
  vault: InMemorySurrogateVault
  keys: ConversationPrivacyKeyRepository
  engine: SurrogateEngine
  restart: () => SurrogateEngine
}

function fixture(): Fixture {
  const vault = new InMemorySurrogateVault()
  const keys = new InMemoryPrivacyKeyRepository() as ConversationPrivacyKeyRepository
  const build = () => new SurrogateEngine(vault, silentAudit, undefined, keys)
  return { vault, keys, engine: build(), restart: build }
}

const policy = resolvePrivacyCategoryPolicy({})

async function crmToolTurn(engine: SurrogateEngine, scope: PrivacyScope): Promise<unknown> {
  const result = await transformStructuredOutput({
    output: { rows: [{ id: 4821, company_name: COMPANY, revenue: 1_234_000 }] },
    fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
    engine,
    tenantId: TENANT,
    connectorId: CONNECTOR,
    scope,
    apply: true,
  })
  return result.output
}

async function main() {
  console.log('AI Privacy Gateway end-to-end (#272)\n')

  await test('ENFORCE: a chat-üzenet telefonszáma és bankszámlaszáma álnevet kap', async () => {
    const { engine } = fixture()
    const result = await transformPromptMessages({
      messages: [
        { role: 'user', content: `Hívd fel a beszerzőt a ${PHONE} számon, a számla ${ACCOUNT}.` },
      ],
      mode: 'enforce',
      policy,
      engine,
      tenantId: TENANT,
      scope: SCOPE,
    })
    const sent = result.messages[0]?.content ?? ''
    assert.equal(result.applied, true, 'a transzformációnak alkalmaznia kell a cserét')
    assert.ok(!sent.includes(PHONE), `a telefonszám nyersen ment ki: ${sent}`)
    assert.ok(!sent.includes(ACCOUNT), `a bankszámlaszám nyersen ment ki: ${sent}`)
    assert.match(sent, /\[\[PHONE_\d+\]\]/)
    assert.match(sent, /\[\[ACCOUNT_\d+\]\]/)
    assert.equal(result.spans.length, 2)
  })

  await test('a policy `tokenize` kategóriáihoz van felismerés (a policy nem üres ígéret)', async () => {
    const { engine } = fixture()
    const tokenizeCategories = Object.entries(policy.categories)
      .filter(([, action]) => action === 'tokenize')
      .map(([category]) => category)
    assert.ok(tokenizeCategories.includes('phone'))
    assert.ok(tokenizeCategories.includes('account'))

    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `${PHONE} / ${ACCOUNT}` }],
      mode: 'enforce',
      policy,
      engine,
      tenantId: TENANT,
      scope: SCOPE,
    })
    const detected = new Set(result.spans.map((span) => span.entityType))
    assert.deepEqual([...detected].sort(), ['account', 'phone'])
  })

  await test('a telefon-felismerés nem billenti `sensitive`-be a beszélgetést', async () => {
    const { classifyPrompt } = await import('../src/domain/gateway/sensitivity-router')
    const decision = classifyPrompt([{ role: 'user', content: `Hívj: ${PHONE}` }])
    assert.equal(decision.level, 'clean')
  })

  await test('CRM tool-válasz: a cégnév álnév, a forgalom megmarad', async () => {
    const { engine } = fixture()
    const output = JSON.stringify(await crmToolTurn(engine, SCOPE))
    assert.ok(!output.includes(COMPANY))
    assert.match(output, /\[\[COMPANY_1\]\]/)
    assert.match(output, /1234000/)
  })

  await test('a UI a valódi cégnevet mutatja a fordulóban', async () => {
    const { engine } = fixture()
    await crmToolTurn(engine, SCOPE)
    const shown = await resolveEgressTextForSurface({
      text: 'A [[COMPANY_1]] forgalma 1 234 000 Ft.',
      surface: 'web_ui',
      engine,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(shown, `A ${COMPANY} forgalma 1 234 000 Ft.`)
  })

  await test('szerver-újraindítás után a beszélgetés újranyitása is a valódi nevet mutatja', async () => {
    const { engine, restart } = fixture()
    await crmToolTurn(engine, SCOPE)
    const afterRestart = restart()
    const shown = await resolveEgressTextForSurface({
      text: 'A [[COMPANY_1]] forgalma 1 234 000 Ft.',
      surface: 'web_ui',
      engine: afterRestart,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(shown, `A ${COMPANY} forgalma 1 234 000 Ft.`)
  })

  await test('újraindítás után a következő forduló sem küldi ki nyersen a cégnevet', async () => {
    const { engine, restart } = fixture()
    await crmToolTurn(engine, SCOPE)
    const afterRestart = restart()
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `És a ${COMPANY} tavalyi forgalma?` }],
      mode: 'enforce',
      policy,
      engine: afterRestart,
      tenantId: TENANT,
      scope: SCOPE,
    })
    const sent = result.messages[0]?.content ?? ''
    assert.ok(!sent.includes(COMPANY), `a cégnév nyersen ment ki: ${sent}`)
    assert.match(sent, /\[\[COMPANY_1\]\]/)
  })

  await test('a beszélgetés adatkulcsának törlése után a megjelenítés nem old fel (crypto-shredding)', async () => {
    const { engine, keys, restart } = fixture()
    await crmToolTurn(engine, SCOPE)
    await keys.shredKeysForConversations([CONVERSATION])
    const afterRestart = restart()
    const shown = await resolveEgressTextForSurface({
      text: 'A [[COMPANY_1]] forgalma 1 234 000 Ft.',
      surface: 'web_ui',
      engine: afterRestart,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(shown, 'A [[COMPANY_1]] forgalma 1 234 000 Ft.')
  })

  await test('feladat-ticket: e-mail álnév a modellnek, plaintext a gmail_send-nek és a UI-nak', async () => {
    const { engine } = fixture()
    const tokenizeEmail = resolvePrivacyCategoryPolicy({
      agent: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
    })
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Küldd a levelet a ${EMAIL} címre.` }],
      mode: 'enforce',
      policy: tokenizeEmail,
      engine,
      tenantId: TENANT,
      scope: TICKET_SCOPE,
    })
    const sent = result.messages[0]?.content ?? ''
    const alias = sent.match(/\[\[EMAIL_\d+\]\]/)?.[0]
    assert.ok(alias, `nem keletkezett álnév: ${sent}`)
    assert.equal(sent.includes(EMAIL), false)

    const resolved = await resolveToolArgs({
      args: { to: alias, subject: 'riport', body: 'teszt' },
      engine,
      tenantId: TENANT,
      scope: TICKET_SCOPE,
    })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.deepEqual(resolved.args, { to: EMAIL, subject: 'riport', body: 'teszt' })

    const shown = await resolveEgressTextForSurface({
      text: `A cím maszkolva: ${alias}`,
      surface: 'web_ui',
      engine,
      tenantId: TENANT,
      scope: TICKET_SCOPE,
    })
    assert.equal(shown, `A cím maszkolva: ${EMAIL}`)
  })

  await test('feladat-ticket kontextusban sem áll meg fail-closed hibával a hívás', async () => {
    const { engine } = fixture()
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Ügyfél telefonszáma: ${PHONE}` }],
      mode: 'enforce',
      policy,
      engine,
      tenantId: TENANT,
      scope: TICKET_SCOPE,
    })
    const sent = result.messages[0]?.content ?? ''
    assert.ok(!sent.includes(PHONE))
    assert.match(sent, /\[\[PHONE_1\]\]/)
  })

  await test('OBSERVE: mérhető fedettség keletkezik, de a szöveg nem változik', async () => {
    const { engine } = fixture()
    const original = `Hívd fel a beszerzőt a ${PHONE} számon.`
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: original }],
      mode: 'observe',
      policy,
      engine,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(result.messages[0]?.content, original)
    assert.equal(result.applied, false)
    assert.deepEqual(
      result.spans.map((span) => span.entityType),
      ['phone'],
    )
  })

  await test('OBSERVE: a strukturált CRM-mező is mérhető, a modellcsatorna nyers marad', async () => {
    const { engine } = fixture()
    const result = await transformStructuredOutput({
      output: { rows: [{ id: 4821, company_name: COMPANY, revenue: 10 }] },
      fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope: SCOPE,
      apply: false,
      registerObserved: true,
    })
    assert.equal(JSON.stringify(result.output).includes(COMPANY), true)
    assert.deepEqual(
      result.spans.map((span) => span.entityType),
      ['company'],
    )
  })

  await test('a CRM-kapcsolat privacy-mezői kiegészítésből is érvényesek (régi connector-sor)', async () => {
    const { engine } = fixture()
    const { buildPrivacyAwareOutcomeChannels } = await import(
      '../src/domain/tool-broker/tool-output-privacy'
    )
    // A tárolt config a `fields` deklaráció bevezetése ELŐTT jött létre: csak a
    // sablonkulcs alapján derül ki, hogy Ostoros CRM.
    const legacyConfig = {
      provider: 'ostorosbor-crm',
      baseUrl: 'https://ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app/api/connector/v1',
      egressHosts: ['ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app'],
      authMode: 'service',
      auth: { type: 'bearer_token' },
      proposedTools: [],
      provenance: { templateKey: 'ostorosbor-crm-sales-delegated' },
    }
    const channels = await buildPrivacyAwareOutcomeChannels({
      tool: 'http_api_call',
      trust: 'external_untrusted',
      output: { rows: [{ id: 4821, company_name: COMPANY, revenue: 1_234_000 }] },
      contract: undefined,
      sideEffecting: false,
      connector: { id: CONNECTOR, tenantId: TENANT, config: legacyConfig },
      conversationId: CONVERSATION,
      actingTenantId: TENANT,
      engine,
      mode: 'enforce',
      audit: null,
    })
    assert.ok(!channels.modelText.includes(COMPANY), `nyers cégnév ment a modellnek: ${channels.modelText}`)
    assert.match(channels.modelText, /\[\[COMPANY_1\]\]/)
    // A munkaterület / downstream ág bitre nyers marad.
    assert.equal(JSON.stringify(channels.machineData).includes(COMPANY), true)
  })

  await test('OBSERVE előnézet után ENFORCE: a UI a valódi, nem az előnézeti nevet mutatja', async () => {
    const { engine, restart } = fixture()
    // Első forduló OBSERVE-ban: `[[COMPANY_1]]` csak ELŐNÉZET, nincs mögötte vault-sor.
    await transformStructuredOutput({
      output: { rows: [{ id: 111, company_name: 'Előnézeti Kft.', revenue: 1 }] },
      fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope: SCOPE,
      apply: false,
      registerObserved: true,
    })
    // Átkapcsolás ENFORCE-ra: a valódi `[[COMPANY_1]]` másik céghez tartozik.
    await crmToolTurn(engine, SCOPE)
    const afterRestart = restart()
    const shown = await resolveEgressTextForSurface({
      text: 'A [[COMPANY_1]] adatai.',
      surface: 'web_ui',
      engine: afterRestart,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(shown, `A ${COMPANY} adatai.`)
  })

  console.log(failures === 0 ? '\nMinden teszt zöld' : `\n${failures} teszt elbukott`)
  if (failures > 0) process.exit(1)
}

void main()
