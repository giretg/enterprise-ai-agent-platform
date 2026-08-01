/**
 * Betanított memória → prompt (a Tanítás felület "Amit eddig megtanult" blokkja).
 *
 * Regresszió: a §10.3 "retrieval-only" váltás után a `MemoryVersion.content`
 * kimaradt a chat- és task-promptból, a Tanítás írási útja pedig sosem hozott
 * létre `MemoryChunk`-ot — így a betanított szabály nem ért el a modellhez.
 *
 * Futtatás: npx tsx scripts/trained-memory-prompt.test.ts
 */
import assert from 'node:assert/strict'
import {
  TRAINED_RULES_MAX_CHARS,
  estimateTrainedRulesTokens,
  formatTrainedRulesBlock,
} from '../src/lib/memory-prompt'
import { trainedRulesSystemMessages } from '../src/domain/memory/memory-runtime-helper'
import { EMPTY_MEMORY_PLACEHOLDER } from '../src/domain/training/memory-items'
import { assembleGatewayMessages } from '../src/domain/agent/prompt-assembler'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures += 1
      console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
    })
}

// Valódi, éles betanított tartalom (Réka, 3. frissítés) — ez volt az a szöveg,
// ami a UI-n megjelent, de a promptba sosem került be.
const REAL_TRAINED_CONTENT = `- Ha feladatod valamilyen, riport, kimutatás készítése, akkor:
  Az adatokat mindig áttekinthető, jól formázott táblázatokban jelenítsd meg.
  Ha nem kér mást felhasználó, akkor a riport formátuma legyen html
- A riportokat html formában készítsd.`

async function main() {
  console.log('\n=== trained-memory-prompt ===\n')

  await check('üres / hiányzó tartalom → nincs blokk', () => {
    assert.equal(formatTrainedRulesBlock({ content: null }), null)
    assert.equal(formatTrainedRulesBlock({ content: undefined }), null)
    assert.equal(formatTrainedRulesBlock({ content: '   \n  ' }), null)
  })

  await check('az üres-placeholder nem kerül a promptba', () => {
    assert.equal(formatTrainedRulesBlock({ content: EMPTY_MEMORY_PLACEHOLDER }), null)
    assert.equal(formatTrainedRulesBlock({ content: `\n${EMPTY_MEMORY_PLACEHOLDER}\n` }), null)
  })

  await check('a betanított szabályok szó szerint bekerülnek a blokkba', () => {
    const block = formatTrainedRulesBlock({ content: REAL_TRAINED_CONTENT, version: 3 })
    assert.ok(block, 'kell hogy legyen blokk')
    assert.ok(block.includes('A riportokat html formában készítsd.'))
    assert.ok(block.includes('áttekinthető, jól formázott táblázatokban'))
  })

  await check('a blokk jelzi a verziót és utasításként keretezi a szabályokat', () => {
    const block = formatTrainedRulesBlock({ content: REAL_TRAINED_CONTENT, version: 3 })!
    assert.ok(block.includes('3. frissítés'), 'a memória-verzió látszik a fejlécben')
    assert.ok(/MINDEN feladatnál tartsd be/.test(block), 'utasítás-jellegű keretezés')
    // A precedencia kimondva: rendszerszabály > felhasználó > betanított szabály.
    assert.ok(block.includes('biztonsági és rendszerszabály'))
    assert.ok(block.includes('a felhasználó aktuális'))
  })

  await check('verzió nélkül is működik (fejléc szám nélkül)', () => {
    const block = formatTrainedRulesBlock({ content: 'Mindig magyarul válaszolj.' })!
    assert.ok(block.startsWith('Betanított munkaszabályok —'))
    assert.ok(block.includes('Mindig magyarul válaszolj.'))
  })

  await check('a túl hosszú szabálylista vágásra kerül', () => {
    const huge = 'x'.repeat(TRAINED_RULES_MAX_CHARS + 5000)
    const block = formatTrainedRulesBlock({ content: huge, version: 9 })!
    assert.ok(block.includes('levágva'), 'a vágás jelezve van')
    // Fejléc + vágott törzs — nem a teljes 17k karakter.
    assert.ok(block.length < TRAINED_RULES_MAX_CHARS + 1500)
  })

  await check('trainedRulesSystemMessages: nincs üzenet, ha nincs betanított szabály', () => {
    const result = trainedRulesSystemMessages({ content: EMPTY_MEMORY_PLACEHOLDER, version: 1 })
    assert.equal(result.messages.length, 0)
    assert.equal(result.tokens, 0)
  })

  await check('trainedRulesSystemMessages: egy system üzenet + pozitív token-becslés', () => {
    const result = trainedRulesSystemMessages({ content: REAL_TRAINED_CONTENT, version: 3 })
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0]!.role, 'system')
    assert.ok(result.messages[0]!.content.includes('A riportokat html formában készítsd.'))
    assert.ok(result.tokens > 0, 'a blokk beleszámít a kontextus-budgetbe')
    assert.equal(result.tokens, estimateTrainedRulesTokens(result.messages[0]!.content))
  })

  await check('a blokk a stabil, cache-elhető prompt-prefixben marad', () => {
    const trained = trainedRulesSystemMessages({ content: REAL_TRAINED_CONTENT, version: 3 })
    const messages = assembleGatewayMessages({
      stablePreamble: [
        { role: 'system', content: 'szerep + viselkedés' },
        ...trained.messages,
        { role: 'system', content: 'kollégák' },
      ],
      variableContext: [{ role: 'system', content: 'Project memory context (…)' }],
      history: [{ role: 'user', content: 'Készíts riportot a Q3 számokról.' }],
    })

    const trainedIndex = messages.findIndex((m) =>
      (m.content ?? '').includes('Betanított munkaszabályok'),
    )
    const boundaryIndex = messages.findIndex((m) => m.cacheBoundary === true)
    const historyIndex = messages.findIndex((m) => m.role === 'user')

    assert.ok(trainedIndex >= 0, 'a betanított blokk bekerül a gateway-üzenetekbe')
    assert.ok(boundaryIndex >= 0, 'van cache-határ')
    assert.ok(trainedIndex <= boundaryIndex, 'a blokk a cache-elhető prefix része')
    assert.ok(trainedIndex < historyIndex, 'a blokk megelőzi a beszélgetés-előzményt')
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.\n' : `\n${failures} teszt bukott.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
