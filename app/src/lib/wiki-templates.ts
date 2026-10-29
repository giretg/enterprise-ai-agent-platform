import type { KbLanguage } from './kb-language'

/** Stable IDs for the wiki creation UI (#946). Schema text is versioned with code. */
export const WIKI_TEMPLATES = [
  { id: 'general', name: { hu: 'Általános tudástár', en: 'General knowledge' } },
  { id: 'health-journal', name: { hu: 'Egészség-napló', en: 'Health journal' } },
] as const
export type WikiTemplateId = typeof WIKI_TEMPLATES[number]['id']

export function renderWikiTemplate(template: WikiTemplateId, language: KbLanguage): string {
  const en = language === 'en'
  const health = template === 'health-journal'
  const paths = health
    ? `- sources/<date>-<provider>-<kind>.md (type: source)
- labs/<parameter>.md (type: entity)
- conditions/<diagnosis>.md (type: entity)
- medications/<medicine>.md (type: entity)
- providers/<provider>.md (type: entity)
- timeline.md (type: analysis)
- overview.md (type: overview)`
    : `- sources/<slug>.md (type: source)
- entities/<slug>.md (type: entity)
- concepts/<slug>.md (type: concept)
- analyses/<slug>.md (type: analysis)
- overview.md (type: overview)`
  return en ? `# Wiki rules — ${health ? 'Health journal' : 'General knowledge'}

Template version: 1
Language: en

ingest_review: silent
Choose discuss to review the main lessons with the user before writing, or silent to write immediately.

## Page types and paths
${paths}
Paths use lowercase ASCII letters, digits, hyphens and slashes, ending in .md; transliterate names. index.md and log.md are server-generated; WIKI.md is human-edited.

## Frontmatter
Each page supplies type, title, summary (one line), category, and frontmatter.sources: [{documentId, page?, section?, cell?}]. Every page except overview requires an existing raw source from this KB. Source pages require frontmatter.source_date (YYYY-MM-DD, the document date). Ask when unknown; never invent a date or source. Send the body separately from frontmatter. Link related pages with [[path]].

## Workflow
Read WIKI.md and index.md, read the full source, find existing pages, write the source summary and update related pages. Patch small additions; upsert new pages. Cite original document IDs and page numbers. Write each source immediately before reading the next; finalize its inbox item only after all updates. Keep both dated claims when sources contradict, mark ⚠️ contradiction, and use the newer source_date for current state when it supersedes the old claim. Preserve historical facts.
${health ? `
## Health journal
A source is one report: include provider, clinician and kind (lab / visit / discharge / imaging). Labs pages record unit, reference range and a chronological table:
| date | value | unit | reference range | flag (H/L) | source |
|---|---|---|---|---|---|
Conditions record first appearance, treatments, linked reports and current state. Medications record when, prescriber, dose and reason. Providers record clinicians and institutions. timeline.md has one row per report grouped by year; overview.md covers active diagnoses, persistently abnormal values and current medicines.
Copy values exactly with units, reference ranges and original page citations. Keep ## Facts separate from ## Interpretation. Mark uncertain scans ⚠️ and obtain a clearer source. Keep measurements sorted by source date; appendToSection alone does not sort a table, so replaceSection when inserting an older measurement. Interpretations cite reports and remain distinct from diagnoses; concerning findings should be discussed with a clinician.
` : ''}` : `# Wiki-szabályok — ${health ? 'Egészség-napló' : 'Általános tudástár'}

Sablonverzió: 1
Nyelv: hu

ingest_review: silent
A discuss beállításnál írás előtt beszéld meg a fő tanulságokat a felhasználóval; silent esetén azonnal írj.

## Oldaltípusok és útvonalak
${paths}
Az útvonal kisbetűs ASCII betűt, számot, kötőjelet és perjelet tartalmazhat, .md végződéssel; az ékezetes nevet írd át. Az index.md és log.md szerver által generált; a WIKI.md ember által szerkesztett.

## Frontmatter
Minden oldal mezői: type, title, summary (egy sor), category, frontmatter.sources: [{documentId, page?, section?, cell?}]. Az overview kivételével minden oldalhoz létező, ugyanebben a tudástárban tárolt nyers forrás kell. Forrásoldalon kötelező a frontmatter.source_date (YYYY-MM-DD, a dokumentum saját dátuma). Ismeretlen dátumnál kérdezz; dátumot és forrást ne találj ki. A törzset külön küldd a frontmattertől. Kapcsolatok: [[path]].

## Munkafolyamat
Olvasd a WIKI.md-t és index.md-t, a teljes forrást és a kapcsolódó meglévő oldalakat. Írd meg a forrás összefoglalóját és frissítsd az érintett oldalakat. Kis bővítéshez patch, új oldalhoz upsert. Hivatkozz az eredeti dokumentumra és oldalszámra. Forrásonként azonnal írj, mielőtt a következőt olvasod; a tálcatételt csak az összes frissítés után zárd le. Ellentmondásnál őrizd meg mindkét dátumozott állítást, jelöld: ⚠️ ellentmondás; az aktuális állapotnál az újabb source_date irányadó, ha felváltja a régit. A történeti tényeket őrizd meg.
${health ? `
## Egészség-napló
Egy forrás egy lelet: intézmény, orvos, típus (labor / vizit / zárójelentés / képalkotó). A sources/<dátum>-<intézmény>-<típus>.md nevet ékezet nélkül használd. A labs/<paraméter>.md oldalon mértékegység, referenciatartomány és időrendi táblázat szerepel:
| dátum | érték | egység | ref. tartomány | jelzés (H/L) | forrás |
|---|---|---|---|---|---|
A conditions/ a diagnózis első megjelenését, kezeléseit, kapcsolódó leleteit és aktuális állapotát tartalmazza; a medications/ a felírás idejét, orvosát, adagot és indokot; a providers/ az orvosokat és intézményeket. A timeline.md évenként, leletenként egy sort ad; az overview.md az aktív diagnózisokat, tartós eltéréseket és szedett gyógyszereket foglalja össze.
Az értékeket betűre pontosan, mértékegységgel, referenciatartománnyal és a forrás oldalszámával rögzítsd. A ## Tények és ## Értelmezés külön fejezet legyen. Bizonytalan olvasat: ⚠️, kérj tisztább forrást. A mérések source_date szerint rendezettek; régebbi mérés beillesztéséhez replaceSection kell, az appendToSection nem rendez. Az értelmezés hivatkozzon a leletre, ne minősüljön diagnózisnak; riasztó eltérésnél javasolj orvosi egyeztetést.
` : ''}`
}
