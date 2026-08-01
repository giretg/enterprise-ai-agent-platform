/**
 * issue #161 — a follow-up három szelete:
 *   1) runtimeHints clamp + diff (katalógus UI mögötti szabály),
 *   2) `preferredMode: 'task'` → board-promóció döntése és szövege,
 *   3) tulajdoni lap ↔ nyilvántartás egyeztetés párosítási magja.
 *
 * Run: npx tsx scripts/skill-runtime-hints-followup.test.ts
 */
import assert from 'node:assert/strict'

import {
  SKILL_RUNTIME_HINT_LIMITS,
  clampSkillRuntimeHints,
  parseSkillContent,
} from '../src/lib/skill/skill-content'
import { diffSkillVersions } from '../src/lib/skill/skill-diff'
import {
  buildSkillTaskPromotionBinding,
  buildSkillTaskPromotionMessage,
  buildSkillTaskTitle,
  shouldPromoteSkillRunToTask,
} from '../src/domain/agent/skill-task-promotion'
import {
  assessNyilvantartasCompleteness,
  buildEgyeztetesMunkafuzet,
  egyeztetesSorok,
  hasCompleteHttpApiGetAllProvenance,
  matchStrength,
  normalizeNyilvantartasRows,
  parseHanyad,
  type EgyeztetesNyilvantartasSor,
} from '../src/lib/tulajdoni-lap-egyeztetes'
import { parseReconcileRecordList } from '../src/lib/reconcile-records'
import type { TulajdoniLapOwner } from '../src/lib/tulajdoni-lap'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ❌ ${name}`)
    console.error(error)
  }
}

function owner(over: Partial<TulajdoniLapOwner> & { nev: string }): TulajdoniLapOwner {
  return {
    nevValtozatok: null,
    szuletesiEv: null,
    anyjaNeve: null,
    cim: null,
    hanyad: '1/1',
    szazalek: 100,
    bejegyzesSorszamok: [1],
    ...over,
  }
}

console.log('\nissue #161 — runtimeHints UI, board-promóció, egyeztetés\n')

// ── 1. runtimeHints clamp + diff ────────────────────────────────────────────

test('clamp: tartományon kívüli érték a legközelebbi érvényesre húzódik', () => {
  const low = clampSkillRuntimeHints({ maxWallClockMs: 1_000, maxToolCalls: 1 })
  assert.equal(low?.maxWallClockMs, SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.min)
  assert.equal(low?.maxToolCalls, SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.min)

  const high = clampSkillRuntimeHints({ maxWallClockMs: 99_000_000, maxToolCalls: 5_000 })
  assert.equal(high?.maxWallClockMs, SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.max)
  assert.equal(high?.maxToolCalls, SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.max)
})

test('clamp: üres szerkesztő → nincs hint (nem üres objektum)', () => {
  assert.equal(clampSkillRuntimeHints({}), undefined)
  assert.equal(clampSkillRuntimeHints({ maxWallClockMs: null, preferredMode: null }), undefined)
  assert.equal(clampSkillRuntimeHints(null), undefined)
})

test('clamp: preferredMode önmagában is érvényes hint', () => {
  assert.deepEqual(clampSkillRuntimeHints({ preferredMode: 'task' }), { preferredMode: 'task' })
})

test('a séma megőrzi a clamp-elt hintet (kör: UI → séma)', () => {
  const hints = clampSkillRuntimeHints({ maxWallClockMs: 900_000, maxToolCalls: 120 })
  const content = parseSkillContent({ instructions: ['x'], runtimeHints: hints })
  assert.equal(content.runtimeHints?.maxWallClockMs, 900_000)
  assert.equal(content.runtimeHints?.maxToolCalls, 120)
})

test('diff: a keret emelése LÁTHATÓ a jóváhagyónak', () => {
  const base = {
    content: parseSkillContent({ instructions: ['a'] }),
    requires: [],
  }
  const target = {
    content: parseSkillContent({
      instructions: ['a'],
      runtimeHints: { maxWallClockMs: 900_000, preferredMode: 'task' },
    }),
    requires: [],
  }
  const diff = diffSkillVersions(base, target)
  const hintChanges = diff.changes.filter((c) => c.category === 'runtimeHints')
  assert.equal(hintChanges.length, 2)
  assert.ok(hintChanges.some((c) => c.detail.includes('900 mp')))
  assert.equal(diff.highestRisk, 'medium')
})

// ── 2. board-promóció ───────────────────────────────────────────────────────

test('promóció: csak betöltött skill + preferredMode=task esetén', () => {
  assert.equal(
    shouldPromoteSkillRunToTask({
      runtimeHints: { preferredMode: 'task' },
      loadedSkillNames: ['tulajdoni-lap-egyeztetes'],
    }),
    true,
  )
  assert.equal(
    shouldPromoteSkillRunToTask({ runtimeHints: { preferredMode: 'task' }, loadedSkillNames: [] }),
    false,
  )
  assert.equal(
    shouldPromoteSkillRunToTask({ runtimeHints: { preferredMode: 'chat' }, loadedSkillNames: ['x'] }),
    false,
  )
  assert.equal(shouldPromoteSkillRunToTask({ runtimeHints: null, loadedSkillNames: ['x'] }), false)
})

test('ticket-cím: skill + kérés, hosszú szöveg vágva', () => {
  const title = buildSkillTaskTitle({
    skillNames: ['egyeztetes'],
    userText: 'x'.repeat(400),
    maxLength: 40,
  })
  assert.equal(title.length, 40)
  assert.ok(title.startsWith('egyeztetes: '))
})

test('promóció-üzenet: elmondja, hol folytatódik és mi lett a csatolmánnyal', () => {
  const message = buildSkillTaskPromotionMessage({
    skillNames: ['tulajdoni-lap-egyeztetes'],
    ticketTitle: 'tulajdoni-lap-egyeztetes: 043/15',
    attachmentCount: 2,
  })
  assert.ok(message.includes('boardra'))
  assert.ok(message.includes('2 fájl'))
  assert.ok(message.includes('tulajdoni-lap-egyeztetes: 043/15'))
})

test('promóció: a ticket a chathez és az első csatolmányhoz is tartósan kapcsolódik', () => {
  assert.deepEqual(
    buildSkillTaskPromotionBinding({
      conversationId: 'conversation-1',
      documents: [
        { id: 'document-1', filename: 'lap.pdf', mimeType: 'application/pdf', kind: 'file' },
        { id: 'document-2', filename: 'foto.png', mimeType: 'image/png', kind: 'screenshot' },
        { id: 'document-1', filename: 'lap.pdf', mimeType: 'application/pdf', kind: 'file' },
      ],
    }),
    {
      conversationId: 'conversation-1',
      sourceDocumentId: 'document-1',
      attachmentDocumentIds: ['document-1', 'document-2'],
      ticketAttachments: [
        {
          documentId: 'document-1',
          filename: 'lap.pdf',
          mimeType: 'application/pdf',
          kind: 'file',
        },
        {
          documentId: 'document-2',
          filename: 'foto.png',
          mimeType: 'image/png',
          kind: 'screenshot',
        },
      ],
    },
  )
})

// ── 3. egyeztetés magja ─────────────────────────────────────────────────────

test('parseHanyad: tört igen, százalék nem', () => {
  assert.equal(parseHanyad('3/4'), 0.75)
  assert.equal(parseHanyad(' 1 / 2 '), 0.5)
  assert.equal(parseHanyad('75%'), null)
  assert.equal(parseHanyad('1/0'), null)
  assert.equal(parseHanyad(null), null)
})

test('párosítás: a név önmagában NEM azonosító', () => {
  const apa = owner({ nev: 'Soltész Gábor', szuletesiEv: '1950', anyjaNeve: 'Kiss Mária' })
  const fiu: EgyeztetesNyilvantartasSor = {
    nev: 'Soltész Gábor',
    szuletesiEv: '1978',
    anyjaNeve: 'Nagy Éva',
  }
  assert.equal(matchStrength(apa, fiu), 'nincs')
  assert.equal(
    matchStrength(apa, { nev: 'SOLTÉSZ  GÁBOR', szuletesiEv: 1950, anyjaNeve: 'kiss mária' }),
    'teljes',
  )
  // Hiányzó kulcs a nyilvántartásban → párosítunk, de bizonytalanként.
  assert.equal(matchStrength(apa, { nev: 'Soltész Gábor' }), 'részleges')
})

test('API mezőaliasok: partnerNev / id / jogcim → kanonikus sor', () => {
  const rows = normalizeNyilvantartasRows([
    {
      partnerNev: 'Kovács János',
      id: 'own-1',
      jogcim: 'adásvétel',
      hanyad: '1/2',
    },
    { name: 'Nagy Éva', ownershipShare: '1/2' },
    { zaj: 'nincs név' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].nev, 'Kovács János')
  assert.equal(rows[0].azonosito, 'own-1')
  assert.equal(rows[0].megjegyzes, 'adásvétel')
  assert.equal(rows[0].hanyad, '1/2')
  assert.equal(rows[1].nev, 'Nagy Éva')
  assert.equal(rows[1].hanyad, '1/2')
})

test('http_api_get_all items burkoló + aliasok → egyeztethető', () => {
  const parsed = {
    ok: true,
    itemCount: 2,
    items: [
      { partnerNev: 'A Anna', hanyad: '1/1', id: 'a1', jogcim: 'öröklés' },
      { partnerNev: 'B Béla', hanyad: '0/1', id: 'b1' },
    ],
  }
  const list = parseReconcileRecordList(parsed)
  assert.ok(list)
  const rows = normalizeNyilvantartasRows(list!)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].nev, 'A Anna')
  assert.equal(rows[0].azonosito, 'a1')
})

test('legacy envelope-olt tool-outputs szöveg → egyeztethető sorok', () => {
  const payload = JSON.stringify({
    ok: true,
    items: [
      { partnerNev: 'A Anna', hanyad: '1/1', id: 'a1' },
      { partnerNev: 'B Béla', hanyad: '1/1', id: 'b1' },
    ],
  })
  // issue #195 D5 — a munkaterületre már a NYERS gépi adat kerül (a burkolat a
  // modell csatornáján marad), ezért a fájlból közvetlenül parse-olható.
  const list = parseReconcileRecordList(JSON.parse(payload.trim()))
  assert.ok(list)
  const rows = normalizeNyilvantartasRows(list!)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].nev, 'A Anna')
})

test('unió: a „Törlés szükséges" sor csak a nyilvántartásból jöhet elő', () => {
  const { sorok, osszegzes } = egyeztetesSorok({
    lapTulajdonosok: [
      owner({ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/2', szazalek: 50 }),
      owner({ nev: 'B Béla', szuletesiEv: '1980', anyjaNeve: 'N Nóra', hanyad: '1/2', szazalek: 50 }),
    ],
    nyilvantartas: [
      { nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/2' },
      { nev: 'C Csaba', szuletesiEv: '1960', anyjaNeve: 'O Olga', hanyad: '1/4' },
    ],
  })
  assert.equal(sorok.length, 3)
  assert.equal(osszegzes.rendben, 1)
  assert.equal(osszegzes.ujRekord, 1)
  assert.equal(osszegzes.torles, 1)
  const torlendo = sorok.find((r) => r.statusz === 'Törlés szükséges')
  assert.equal(torlendo?.nev, 'C Csaba')
  assert.equal(torlendo?.forras, 'Nyilvántartás')
  // A törlendő sornál nincs kitalált % / terület.
  assert.equal(torlendo?.szazalekLap, null)
})

test('eltérő hányad → Módosítás szükséges, indoklással', () => {
  const { sorok } = egyeztetesSorok({
    lapTulajdonosok: [
      owner({ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '3/4', szazalek: 75 }),
    ],
    nyilvantartas: [{ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/2' }],
  })
  assert.equal(sorok[0].statusz, 'Módosítás szükséges')
  assert.ok(sorok[0].megjegyzes.includes('3/4'))
  assert.ok(sorok[0].megjegyzes.includes('1/2'))
})

test('bizonytalan párosítás jelölve van és számolódik', () => {
  const { sorok, osszegzes } = egyeztetesSorok({
    lapTulajdonosok: [
      owner({ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/1', szazalek: 100 }),
    ],
    nyilvantartas: [{ nev: 'A Anna', hanyad: '1/1' }],
  })
  assert.equal(osszegzes.bizonytalanParositas, 1)
  assert.equal(sorok[0].statusz, 'Rendben')
  assert.ok(sorok[0].megjegyzes.includes('nem teljes kulcson'))
})

test('több bejegyzés egy személyhez: a visszakereséshez a sorszámok bekerülnek', () => {
  const { sorok } = egyeztetesSorok({
    lapTulajdonosok: [
      owner({
        nev: 'A Anna',
        szuletesiEv: '1970',
        anyjaNeve: 'M Mária',
        hanyad: '1/1',
        szazalek: 100,
        bejegyzesSorszamok: [3, 7],
      }),
    ],
    nyilvantartas: [{ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/1' }],
  })
  assert.ok(sorok[0].megjegyzes.includes('II/3 + II/7'))
})

test('széljegy esetén a sor megjegyzése figyelmeztet', () => {
  const { sorok } = egyeztetesSorok({
    lapTulajdonosok: [owner({ nev: 'A Anna', hanyad: '1/1', szazalek: 100 })],
    nyilvantartas: [],
    vanSzeljegy: true,
  })
  assert.ok(sorok[0].megjegyzes.includes('széljegy'))
})

test('csonka nyilvántartás: 50-ös oldal + sok Új rekord → block (Excel ne legyen késznek látszó)', () => {
  // Regresszió a /tulajdoni-lap-egyeztetes futásra: http_api_get első oldala (50)
  // extractelve → 137 „Új rekord" hamis pozitív.
  const verdict = assessNyilvantartasCompleteness({
    lapTulajdonosDb: 182,
    nyilvantartasDb: 50,
    ujRekordDb: 137,
  })
  assert.equal(verdict.block, true)
  assert.ok(verdict.indok)
  assert.match(verdict.indok!, /http_api_get_all/)
  assert.match(verdict.indok!, /50/)
})

test('csonka nyilvántartás: http_api_get_all forrás → nem blockol, csak figyelmeztet', () => {
  const verdict = assessNyilvantartasCompleteness({
    lapTulajdonosDb: 182,
    nyilvantartasDb: 50,
    ujRekordDb: 137,
    sourceLooksComplete: true,
  })
  assert.equal(verdict.block, false)
  assert.equal(verdict.warn, true)
  assert.ok(verdict.indok)
})

test('get_all teljes forrását strukturált meta igazolja, a fájlnév nem', () => {
  assert.equal(
    hasCompleteHttpApiGetAllProvenance({
      items: [],
      provenance: { sourceTool: 'http_api_get_all', paginationComplete: true },
    }),
    true,
  )
  assert.equal(hasCompleteHttpApiGetAllProvenance({ items: [] }), false)
  assert.equal(hasCompleteHttpApiGetAllProvenance(['http_api_get_all']), false)
})

test('csonka nyilvántartás: confirm után enged', () => {
  const verdict = assessNyilvantartasCompleteness({
    lapTulajdonosDb: 182,
    nyilvantartasDb: 50,
    ujRekordDb: 137,
    confirmedComplete: true,
  })
  assert.equal(verdict.block, false)
  assert.equal(verdict.warn, false)
})

test('egészséges arány: nem gyanús', () => {
  const verdict = assessNyilvantartasCompleteness({
    lapTulajdonosDb: 100,
    nyilvantartasDb: 95,
    ujRekordDb: 8,
  })
  assert.equal(verdict.block, false)
  assert.equal(verdict.warn, false)
  assert.equal(verdict.indok, null)
})

test('üres nyilvántartás nagy lap mellett → block', () => {
  const verdict = assessNyilvantartasCompleteness({
    lapTulajdonosDb: 40,
    nyilvantartasDb: 0,
    ujRekordDb: 40,
  })
  assert.equal(verdict.block, true)
  assert.match(verdict.indok!, /üres|0 sor/i)
})

test('munkafüzet: fejléc, képletek és összegsor egy menetben állnak elő', () => {
  const { sorok } = egyeztetesSorok({
    lapTulajdonosok: [
      owner({ nev: 'A Anna', szuletesiEv: '1970', anyjaNeve: 'M Mária', hanyad: '1/2', szazalek: 50 }),
    ],
    nyilvantartas: [{ nev: 'C Csaba', hanyad: '1/2' }],
  })
  const wb = buildEgyeztetesMunkafuzet({
    sorok,
    parsed: {
      meta: { oldalak: 3, tipus: 'teljes', kelt: '2026.07.16' },
      osszesites: {
        resz2Osszes: 2,
        resz2Hatalyos: 1,
        resz2Torolt: 1,
        resz3Osszes: 0,
        resz3Hatalyos: 0,
        szeljegyDb: 0,
        egyediTulajdonos: 1,
        hatalyosHanyadOsszeg: '1/1',
        hatalyosHanyadOsszegSzazalek: 100,
        valid: true,
        megjegyzes: '',
      },
      szeljegyek: [],
      ingatlan: { teruletHaOsszesen: '12,5', akOsszesen: '30,2' },
      terhek: [],
    },
  })
  assert.equal(wb.egyeztetesSorok[0][0], 'Forrás')
  // Lap-oldali sor: I/J képlet; nyilvántartás-oldali sor: üres.
  assert.equal(wb.egyeztetesSorok[1][8], '=G2/100*Ingatlan!$B$5')
  assert.equal(wb.egyeztetesSorok[2][8], null)
  const osszeg = wb.egyeztetesSorok[wb.egyeztetesSorok.length - 1]
  assert.equal(osszeg[0], 'Összesen')
  assert.equal(osszeg[6], '=SUM(G2:G3)')
  // A terület/AK az Ingatlan lapon számként landol (a képletek erre hivatkoznak).
  assert.deepEqual(
    wb.ingatlanSorok.find((row) => row[0] === 'Terület (ha)'),
    ['Terület (ha)', 12.5],
  )
})

console.log(
  failures === 0
    ? '\n✅ Minden #161 teszt zöld'
    : `\n❌ ${failures} teszt bukott`,
)
process.exit(failures === 0 ? 0 : 1)
