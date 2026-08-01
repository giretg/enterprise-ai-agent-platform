/**
 * TOOL-REGISZTER DRIFT-TESZTEK (issue #194, WP-6).
 * Futtatás: npm run test:tool-registry-drift
 *
 * ÜZLETI JELENTÉS: eddig egy tool attól, hogy létezett és működött, még nem
 * biztos, hogy az agent LÁTTA, hogy a validátor ELFOGADTA, vagy hogy a bérlőnek
 * GRANTOLVA volt. Ezek némán, külön-külön romlottak el, és a felhasználó felé
 * mindig ugyanaz a tünet jelent meg: az agent nem csinálja meg a feladatot, és
 * nem mondja meg, miért. Ezek a tesztek ezt a hibaosztályt fogják meg a CI-ben,
 * mielőtt élesbe kerülne.
 */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveToolHandler } from '../src/domain/tool-broker/handlers/registry'
import {
  TOOL_NAMES,
  TOOL_REGISTRY,
  toolJsonSchema,
  toolsForSurface,
} from '../src/domain/tool-broker/tool-registry'
import { CHAT_PLATFORM_TOOLS } from '../src/domain/agent/chat-tool-loop'
import { PLATFORM_BROKER_TOOLS } from '../src/harness/platform-mcp-bridge'
import { toolInvokeSchema } from '../src/lib/validators/actions'
import { NORMAL_TOOL_CAPABILITY_NAMES } from '../src/lib/tool-capability-catalog'
import {
  SIDE_EFFECTING_TOOLS,
  TOOL_TRUST_REGISTRY,
} from '../src/domain/tool-broker/tool-trust-registry'

let failures = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

const TRUST_CLASSES = new Set(['trusted', 'internal', 'external_untrusted'])

/**
 * 6. teszt allowlistje: olyan fájlok, ahol a tool-nevek felsorolása NEM a
 * regiszter másolata, hanem más szemantikát hordoz (kockázati osztály, tiltólista,
 * `Record<ToolName, …>` kimerítő leképezés, vagy maga a kanonikus forrás).
 */
const TOOL_NAME_ARRAY_ALLOWLIST = new Set([
  // A kanonikus forrás és közvetlen vetületei.
  'src/domain/tool-broker/tool-registry.ts',
  'src/domain/tool-broker/tool-broker-types.ts',
  'src/domain/tool-broker/tool-trust-registry.ts',
  // `Partial<Record<ToolName, …>>` connector-mátrix — kulcsolt, nem lista.
  'src/domain/tool-broker/tool-broker-authorizer.ts',
  // Kockázati osztályok / jóváhagyás-kapu: MÁS döntés, mint a felület-szűrés.
  'src/domain/tool-broker/consequence-gate-policy.ts',
  // Szerep-szintű TILTÓlista (web-egress) — szándékosan nem a regiszter vetülete.
  'src/domain/agents/web-egress-role.ts',
  // UI-címkék: `Record<string, ToolUiLabel>` — kulcsolt, nem lista.
  'src/lib/tool-ui-labels.ts',
])

/**
 * A handlerek `handles()` predikátumai a SAJÁT hatókörüket mondják ki. Ezek nem
 * tudnak némán elsodródni: a 2. teszt tool-onként ellenőrzi, hogy a ténylegesen
 * feloldott handler `id`-ja a descriptor `handlerId`-ja — tehát a két oldal
 * bármelyikének elmozdulása bukik.
 */
const TOOL_NAME_ARRAY_ALLOWLIST_PREFIXES = ['src/domain/tool-broker/handlers/']

/** Egy args-séma mezői — a `.refine()`-olt `z.object` is objektum marad Zod 4-ben. */
function zodObjectShape(schema: unknown): Record<string, z.ZodType> | null {
  const def = (schema as { def?: { type?: string; shape?: Record<string, z.ZodType> } }).def
  if (def?.type !== 'object' || !def.shape) return null
  return def.shape
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function main() {
  console.log('=== Tool-regiszter drift ===')
  const toolNameSet = new Set<string>(TOOL_NAMES)

  // ── 1. Minden ToolName-hez van descriptor ────────────────────────────────
  // Fordításidőben a `Record<ToolName, …>` adja, de a futásidejű ellenőrzés is
  // kell: egy `as` állítás vagy egy hibás merge kicselezheti a típust.
  test('minden ToolName-hez tartozik descriptor', () => {
    assert.ok(TOOL_NAMES.length > 0, 'a regiszter üres')
    for (const name of TOOL_NAMES) {
      const descriptor = TOOL_REGISTRY[name]
      assert.ok(descriptor, `hiányzó descriptor: ${name}`)
      assert.ok(descriptor.description.trim().length > 0, `üres leírás: ${name}`)
      assert.ok(descriptor.argsSchema, `hiányzó argsSchema: ${name}`)
      assert.equal(typeof descriptor.toInvokeInput, 'function', `hiányzó toInvokeInput: ${name}`)
      assert.ok(descriptor.capability.trim().length > 0, `üres capability: ${name}`)
      assert.ok(descriptor.surfaces.length > 0, `egyetlen felületen sem látszik: ${name}`)
    }
  })

  // ── 2. Minden descriptorhoz feloldható handler ───────────────────────────
  // Ez korábban SEHOL nem volt ellenőrizve: egy hiányzó handler csak futásidőben,
  // a felhasználó hívásakor derült volna ki.
  test('minden descriptorhoz feloldható végrehajtó handler', () => {
    for (const name of TOOL_NAMES) {
      const handler = resolveToolHandler(name)
      assert.ok(handler, `nincs handler a toolhoz: ${name}`)
      assert.equal(
        handler.id,
        TOOL_REGISTRY[name].handlerId,
        `a descriptor handlerId-ja nem a ténylegesen feloldott handler: ${name}`,
      )
    }
  })

  // ── 3. Bizalmi osztály + mellékhatás-döntés ──────────────────────────────
  test('minden descriptornak van trust-osztálya és mellékhatás-döntése', () => {
    for (const name of TOOL_NAMES) {
      const descriptor = TOOL_REGISTRY[name]
      assert.ok(TRUST_CLASSES.has(descriptor.trust), `ismeretlen trust: ${name}`)
      assert.equal(typeof descriptor.sideEffecting, 'boolean', `hiányzó sideEffecting: ${name}`)
      assert.equal(TOOL_TRUST_REGISTRY[name], descriptor.trust, `trust-vetület eltér: ${name}`)
      assert.equal(
        SIDE_EFFECTING_TOOLS[name],
        descriptor.sideEffecting,
        `mellékhatás-vetület eltér: ${name}`,
      )
    }
  })

  // ── 4. A chat- és MCP-vetület KIZÁRÓLAG a registryből képződik ───────────
  test('a chat- és MCP-vetület pontosan a surfaces szerinti szűrés', () => {
    assert.deepEqual(
      [...CHAT_PLATFORM_TOOLS].sort(),
      [...toolsForSurface('chat')].sort(),
      'a chat-vetület eltér a surfaces szűréstől',
    )
    assert.deepEqual(
      PLATFORM_BROKER_TOOLS.map((t) => t.name).sort(),
      [...toolsForSurface('mcp')].sort(),
      'az MCP-vetület eltér a surfaces szűréstől',
    )
    for (const tool of PLATFORM_BROKER_TOOLS) {
      assert.ok(tool.description.trim().length > 0, `üres MCP-leírás: ${tool.name}`)
      assert.ok(tool.inputSchema, `hiányzó MCP inputSchema: ${tool.name}`)
    }
  })

  // ── 4b. A validátor- és a capability-vetület is teljes ───────────────────
  // A `toolInvokeSchema` korábban kézzel írt union volt, amiből 19 tool kimaradt:
  // az agent tools API 400-zal utasította vissza őket, hiába volt handlerük.
  test('a validátor-vetület minden toolt lefed', () => {
    const options = (toolInvokeSchema as unknown as { options: Array<{ shape: { tool: { value: string } } }> })
      .options
    const covered = options.map((option) => option.shape.tool.value).sort()
    assert.deepEqual(covered, [...TOOL_NAMES].sort(), 'a validátor union nem fedi le a regisztert')
  })

  test('a capability-katalógus minden tool jogát felkínálja', () => {
    const catalog = new Set(NORMAL_TOOL_CAPABILITY_NAMES)
    for (const name of TOOL_NAMES) {
      assert.ok(
        catalog.has(TOOL_REGISTRY[name].capability),
        `a jogosultság-szerkesztőben nem adható meg: ${name}`,
      )
    }
  })

  // ── 5. A generált JSON Schema és a Zod-séma oda-vissza konzisztens ───────
  // A modellnek mondott „kötelező" mezőnek a validátorban is pontosan kötelezőnek
  // kell lennie — különben a modell jóhiszeműen küld egy hívást, a validátor
  // visszadobja, az agent pedig nem érti, miért nem működik az eszköz.
  test('a JSON Schema és a Zod-séma mezői oda-vissza egyeznek', () => {
    for (const name of TOOL_NAMES) {
      const schema = toolJsonSchema(name)
      assert.equal(schema.type, 'object', `nem objektum-séma: ${name}`)
      assert.ok(!('$schema' in schema), `a $schema kulcsot le kell vágni: ${name}`)

      const shape = zodObjectShape(TOOL_REGISTRY[name].argsSchema)
      assert.ok(shape, `az argsSchema nem objektum-séma: ${name}`)

      const schemaProperties = Object.keys((schema.properties ?? {}) as Record<string, unknown>)
      assert.deepEqual(
        schemaProperties.sort(),
        Object.keys(shape).sort(),
        `a JSON Schema mezői eltérnek a Zod-alaktól: ${name}`,
      )

      // Kötelező = a Zod NEM fogadja el `undefined`-ként.
      const zodRequired = Object.entries(shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([key]) => key)
        .sort()
      const schemaRequired = [...((schema.required ?? []) as string[])].sort()
      assert.deepEqual(
        schemaRequired,
        zodRequired,
        `a modellnek hirdetett kötelező mezők eltérnek a validátorétól: ${name}`,
      )
    }
  })

  // ── 6. Grep-őr: nincs több kézzel írt tool-név tömb ──────────────────────
  test('nincs kézzel írt tool-név tömb a registryn kívül', () => {
    const srcRoot = path.resolve(__dirname, '../src')
    const offenders: string[] = []

    for (const file of walk(srcRoot)) {
      const relative = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/')
      if (TOOL_NAME_ARRAY_ALLOWLIST.has(relative)) continue
      if (TOOL_NAME_ARRAY_ALLOWLIST_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue

      const content = readFileSync(file, 'utf8')
      // Beágyazás nélküli tömb-literálok — a többsoros felsorolásokat is fedi.
      // Csak akkor jelzünk, ha a tömb MINDEN eleme tool-név: így a tool-nevekkel
      // átfedő, de más szemantikájú listák (audit-akciók, esemény-katalógus) nem
      // adnak vakriasztást, a regiszter kézi másolatai viszont fennakadnak.
      for (const match of content.matchAll(/\[[^[\]]*\]/g)) {
        const literals = [...new Set([...match[0].matchAll(/'([^']+)'/g)].map((m) => m[1]))]
        if (literals.length < 3) continue
        if (!literals.every((literal) => toolNameSet.has(literal))) continue
        offenders.push(`${relative}: [${literals.join(', ')}]`)
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `kézzel írt tool-név tömb(ök) a registryn kívül:\n      ${offenders.join('\n      ')}`,
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} drift-teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden tool-regiszter drift-teszt zöld.')
}

main()
