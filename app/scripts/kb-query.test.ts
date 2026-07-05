/**
 * A KB-keresési query desztillálásának (`distillKbSearchQuery`) és a
 * fájlnév-boostos retrieval-scoringnak (`assembleKbHits`) determinisztikus,
 * DB nélküli tesztje. A regresszió-forgatókönyv: egy folyamat-ticket zajos,
 * hosszú feladat-utasítása (bemásolt korábbi hibaszöveggel) korábban felhígította
 * a kulcsszavas keresést, és a keresett dokumentum kiesett a top-k-ból.
 *
 * Futtatás: npx tsx scripts/kb-query.test.ts
 */
import assert from 'node:assert/strict'
import { distillKbSearchQuery, extractDocumentMentions } from '../src/lib/kb-query'
import { assembleKbHits } from '../src/domain/tool-broker/tool-broker-service'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

// A képernyőképen látott ticket-feladat rekonstrukciója: angol utasítás + a
// keresett dokumentum neve + egy bemásolt, hosszú korábbi hibaszöveg (kaszkád).
const NOISY_TASK = `Create an HTML document summarizing the recommendations, including the specific General Data Management and Protection Policy v1.1.docx references and justifications, based on the drafted proposal: "Sajnálom, de jelenleg nem tudom elérni a belső tudásbázisban szereplő dokumentumokat, így a General Data Management and Protection Policy v1.1.docx tartalmát sem tudom áttekinteni, és nem tudok forráshivatkozásokkal alátámasztott, szabályzatokon alapuló javaslatokat készíteni." The document should be well-formatted and easy to read.`

async function run() {
  console.log('=== KB query desztilláció + fájlnév-boost teszt ===')

  await check('extractDocumentMentions: kinyeri a .docx fájlnevet a szövegből', () => {
    const mentions = extractDocumentMentions(NOISY_TASK)
    assert.ok(
      mentions.includes('General Data Management and Protection Policy v1.1.docx'),
      'a teljes fájlnév megjelenik a kinyert említések közt',
    )
  })

  await check('distillKbSearchQuery: fájlnév elöl, a bemásolt hosszú idézet kiesik', () => {
    const q = distillKbSearchQuery(NOISY_TASK)
    assert.ok(
      q.startsWith('General Data Management and Protection Policy v1.1.docx'),
      'a fájlnév a query elejére kerül',
    )
    assert.ok(
      !q.includes('Sajnálom, de jelenleg nem tudom elérni'),
      'a bemásolt korábbi hibaszöveg (hosszú idézet) nem kerül a keresésbe',
    )
    assert.ok(q.length < NOISY_TASK.length, 'a desztillált query rövidebb a nyers utasításnál')
  })

  await check('distillKbSearchQuery: rövid, tiszta kérdés lényegében változatlan', () => {
    const q = distillKbSearchQuery('Mi az adatkezelési szabályzat lényege?')
    assert.equal(q, 'Mi az adatkezelési szabályzat lényege?')
  })

  await check('assembleKbHits: fájlnév-boost a cél-dokumentumot a generikus doc elé emeli', () => {
    // Cél-dokumentum: a neve erősen egyezik a query címstemjeivel, a törzse rövid.
    // Versenytárs: generikus tartalom, sok közös „policy/data/management" stemmel,
    // de a neve NEM egyezik. Fájlnév-boost nélkül a bőbeszédű versenytárs nyerne.
    const distilled = distillKbSearchQuery(NOISY_TASK)
    const hits = assembleKbHits({
      query: distilled,
      k: 5,
      memoryContent: '',
      memoryId: 'mem-1',
      memoryVersion: null,
      okfChunkHits: [],
      docs: [
        {
          id: 'target',
          filename: 'General Data Management and Protection Policy v1.1.docx',
          extractedText: 'Az Ipoteka Bank által kezelt érzékeny adatok kezelési szabályai.',
        },
        {
          id: 'generic',
          filename: 'security-incident-runbook.md',
          extractedText:
            'General incident response. Data handling and management policy. Protection and security procedures. Recommendations and references for well-formatted documents. Management justifications.',
        },
      ],
      supersededDocIds: new Set(),
    })
    assert.ok(hits.length >= 1, 'van találat')
    assert.equal(hits[0].docId, 'doc:target', 'a keresett dokumentum kerül az élre')
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt elbukott`)
  if (failures > 0) process.exitCode = 1
}

run()
