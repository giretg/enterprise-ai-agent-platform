# Knowledge Base v3 — OKF dokumentum-tudásbázis specifikáció

**Projekt:** Enterprise AI Agent Platform
**Státusz:** javasolt Fázis 2 / KB-v3 specifikáció
**Dátum:** 2026-07-03
**Előzmény:** ez a `Knowledge-Base-v2-OKF-Wiki-Spec.md` átdolgozott, szűkített változata. A v2 megmarad referenciának; ez a v3 a mérvadó.
**Cél:** a jelenlegi `Document.extractedText` + in-memory `kb_search` alapú tudásbázis kiváltása egy enterprise-szintű, auditálható, agent-barát, **kurált OKF-dokumentum-tudásbázissal** — RAG/vektoros réteg nélkül, de arra nyitott varrattal.

---

## ⏱️ Implementációs állapot (2026-07-03)

> Ez a szakasz azt jelzi, mi **készült el kódban** a specből. A `§16 Sprint 1` (adatmodell + skeleton), a `§17 első implementációs szelet` determinisztikus magja, a **Sprint 2 extraction pipeline** (formátumfüggő PDF-oldal / DOCX-section / XLSX-cella forrás-provenance), a Sprint 3 retrieval-magja (Postgres full-text `kb_search v2` + §10.5 superseded coexistence + oldal/section-szintű citation payload), a Sprint 3 OKF-navigációs toolok (`kb_list_index` + `kb_get_page`, end-to-end), a Sprint 3 review réteg (§7.6 determinisztikus OKF-validátor + §12.2 hárompaneles review UI), **és a Sprint 4 eval-harness** (§15 determinisztikus eval-generátor + retrieval-kiértékelő a valódi assembler ellen: navigációs helyesség / source-link helyesség / no-answer precízió / latency / token-költség) kész és tesztelt. **Ezzel a teljes KB-v3 MVP roadmap (Sprint 1–4) kész.**

### ✅ Kész (Sprint 4 — Eval-harness — 2026-07-03)

- **Determinisztikus eval-harness (§15):** új `app/src/lib/kb-eval.ts` — LLM-mentes, tiszta modul, ami a published OKF-korpuszból eval-készletet generál és egy retrieval-függvényen kiértékeli. A körkörösség tudatos korlátja (§15): ez smoke/regressziós jelzés, nem abszolút minőségmérce.
  - **`generateEvalCases({ chunks, negativeQueries? })`:** oldalanként (path) egy **pozitív** kérdés a cím tokenjeiből (a full-text a title-t is indexeli → a helyes oldalra kell navigálnia), `expectedPaths` + `expectedSource` (formátumfüggő locus: PDF=oldal, DOCX=section, XLSX=cella) a chunk `sourceRef`-jéből; plusz a **negatív** kérdések („nem tudható a dokumentumból", `DEFAULT_NEGATIVE_QUERIES` vagy override). Az `index.md` navigációs oldal sosem lesz eval-eset.
  - **`evaluateRetrieval({ cases, retrieve, confidenceThreshold? })`:** per-eset verdikt + aggregált metrikák (§15/§20): **navigációs helyesség** (top-hit path a várt oldalak közt), **retrieval recall** (jött-e találat — a groundedness szükséges feltétele), **source-link helyesség** (a top-hit forrás-locusa a várt oldal/section/cellára mutat-e — §3.3 az egyetlen biztonsági háló, ezért a nevező a navigációsan eltalált esetek), **no-answer precízió** (negatívra küszöb feletti találat nélkül tartózkodik-e), **latency** (per-eset + avg/max) és opcionális **token-költség** (ha a retrieve adja). `formatEvalReport` az ember-olvasható összegzéshez.
- **Tesztek:** `kb-eval.test.ts` (9 eset) a **valódi `assembleKbHits` assembler** ellen fut, egy tiszta in-memory chunk-„searcher" elé kötve (ez a Postgres `searchChunks` ts_rank-szerződését utánozza — DB nélkül): eset-generálás (pozitív/negatív, index-kizárás), tiszta korpuszon 100% nav+source+no-answer, rossz-oldal navigálás bukik, jó oldal/rossz forrás-oldal → source-link bukik (§3.3), küszöb feletti zaj → no-answer precízió bukik, token-költség aggregáció, riport-formázás → 9/9 zöld. A `kb-gate` (14/14), `kb-retrieval` (14/14), `kb-extraction` (11/11), `kb-validator` (11/11) továbbra is zöld. 0 tsc, eslint tiszta.
  - `app/scripts/kb-eval.test.ts` (`npm run test:kb-eval`)

### ✅ Kész (Sprint 2 — Extraction pipeline — 2026-07-03)

- **Formátumfüggő extraction (§7.3/§7.4):** új `app/src/lib/kb-extraction.ts` modul, ami a feltöltött fájlt **normalizált markdown + forrás-provenance-os szeletekre** (`ExtractedBlock[]`) bontja. Minden szelet a rá mutató, formátumfüggő forrás-refet hordozza (§4.7):
  - **PDF → oldal-szint** (`pdf-parse` `pagerender`, oldalanként egy blokk, `sourceRef.page`);
  - **DOCX → heading/section-út** (`mammoth` HTML + tiszta `htmlToSections` parser: preamble + `<h1..h6>`-szekciók, lista-bullet + entity-decode, `sourceRef.section`);
  - **XLSX → cella-tartomány** (`exceljs`, munkalaponként blokk, `Sheet!A1:E{n}` range, `sourceRef.cell`);
  - **MD/HTML/plain → section** (heading-split, `sourceRef.section`).
- **Perzisztencia:** a szeletek a `Document.metadata.extraction`-be kerülnek feltöltéskor (`uploadDocument` most `extractStructured`-öt hív, a `mimeType` is rögzül); a nyers bájtokat továbbra sem tároljuk (a `storageRef` a szöveget tartja), ezért az extraction feltöltéskor egyszer fut le. A layout-aware span-pontos újrakinyerés a nyers bájtból tudatosan post-MVP (D-G/D7).
- **Bundle-integráció (§17.3):** a `buildOkfBundle` új `blocks?` bemenete — ha van, szeletenként egy OKF-oldal a **saját** forrás-refjével; a page frontmatterbe gép-olvasható `source_ref: {…}` kerül, amit a `chunkOkfBundle`/`parseOkfPage` round-tripel, így a **chunk `sourceRef` oldal/section/cella-szintű** (nem generikus section). Régi dokumentumon nincs blokk → heading-split fallback (backward-compatible). A `KnowledgeBaseService` a `readExtractionBlocks(document.metadata)` úton táplálja be a draft- és publish-bundle-be.
  - `app/src/lib/kb-v3.ts` (`ExtractedBlock`, `blocks` input, `source_ref` frontmatter round-trip), `app/src/domain/knowledge-base/knowledge-base-service.ts`, `app/src/app/actions/platform.ts`.
- **Tesztek:** `kb-extraction.test.ts` (11 eset: `columnLetter`, text/DOCX-HTML/XLSX(valós exceljs buffer)/PDF(valós fixture) extraction, end-to-end blokk→bundle→chunk source-ref round-trip PDF-oldalra és XLSX-cellára, heading-split backward-compat, metadata round-trip) → 11/11 zöld. A `kb-gate` (14/14) és `kb-retrieval` (14/14) továbbra is zöld. 0 tsc, eslint tiszta.
  - `app/scripts/kb-extraction.test.ts` (`npm run test:kb-extraction`)

### ✅ Kész (Sprint 3 Review UI + §7.6 validátor — 2026-07-03)

- **§7.6 determinisztikus OKF-validátor:** új `app/src/lib/kb-validator.ts` — a `validateOkfBundle(bundle, { connectorId })` tiszta (DB-mentes) függvény a generált bundle-ön: YAML-frontmatter parse, kötelező mezők (`type`/`title`/`connector_id`), **connector-egyezés** (D-B scope), törött belső link (`..`/`.` feloldással a bundle-fájlokhoz), külső/`mailto:` link, üres / túl hosszú (>20k) oldal, **`## Source` forrás-link coverage** (§3.3 egyetlen biztonsági háló), és érzékeny-adat heurisztika (email / API-kulcs / kártyaszám / IBAN — §14.5 warning). Kimenet: `{ ok, pageCount, brokenLinks, externalLinks, sourceLinkCoverage, sensitiveHits, errors, warnings, issues[] }`. A hard `error` strukturális sérülés, a `warning` review-figyelmeztető — a validátor **nem blokkol**, az emberi review dönt (§7.7/D-F).
- **Service-bekötés + audit (§13):** a `KnowledgeBaseService.createDraftArtifact` a draft-generáláskor lefuttatja a validátort, és a teljes eredményt a `KnowledgeArtifact.validationResult`-be menti (a korábbi `{ pageCount }` helyett). A `kb.artifact.generated` audit-meta most `brokenLinks`/`sourceLinkCoverage`/`warnings`/`errors`-t is jelez; strukturális hibánál külön `kb.artifact.validation_failed` esemény (új action a katalógusban). Új `getArtifactReview({ agentId, documentId })` service-metódus a review UI adatához (forrás extracted text + determinisztikusan újraépített OKF file-tree + friss validáció + a jóváhagyási ticket).
- **§12.2 hárompaneles review UI:** új `app/src/components/agents/kb-artifact-review.tsx` overlay — (1) forrás/extracted text, (2) generált OKF file-tree + oldal-preview, (3) validation report (ok/hiba/figyelmeztetés badge-ek, metrikák: oldalak / forrás-lefedettség% / törött-külső link / érzékeny adat, issue-lista severity szerint) + **approve/reject** (a publikálás/elutasítás a meglévő `approveKbDocument`/`rejectKbDocument` úton). A `AgentKnowledgeBasePanel` pending-listájából „Áttekintés" gombbal nyílik. Új `getKbArtifactReview` server action (`operator`-gate) + `kbArtifactReviewSchema` validátor.
- **Tesztek:** `kb-validator.test.ts` (11 eset: tiszta bundle → ok + teljes coverage; connector-mismatch / hiányzó frontmatter / hiányzó kötelező mező / törött link → error; valós index→pages link nem törött; hiányzó Source / üres oldal / külső link / érzékeny adat → warning; index-mentesség) → 11/11 zöld. A `kb-gate` (14/14, a `validationResult` bővítés nem törte el), `kb-retrieval` (14/14), `kb-extraction` (11/11) továbbra is zöld. 0 tsc, eslint tiszta.
  - `app/scripts/kb-validator.test.ts` (`npm run test:kb-validator`)

### ✅ Kész (Sprint 3 OKF-navigáció — 2026-07-03)

- **`kb_list_index` (§9.3) + `kb_get_page` (§9.2) end-to-end:** a két navigációs tool a `kb_search` utáni többkörös OKF-bejárás elsődleges retrieval-útja (D-I). A chunk `path`/`title`/`section`/`sourceRef` adat már megvolt (Sprint 3 retrieval-mag); most a Tool Broker-endpontok is megvannak.
  - **Repository (§11):** `KnowledgeChunkRepository.listIndex` (published oldalak path-onként, `pathPrefix`-szűrés, `connectorId`-scope) + `getPageChunks` (egy oldal chunkjai `chunkIndex` sorrendben, `artifactId`-egyértelműsítéssel). Csak `published` artifact (§14.1), a Prisma relation-filteren át (`artifact: { status: 'published' }`). `app/src/repositories/postgres/knowledge-repository.ts`, interfész `KnowledgeIndexEntry`/`KnowledgePageChunk`.
  - **Tool Broker (§9):** union + `TOOL_REQUIREMENTS` (`knowledge_base` read) + dispatch + `kbListIndex`/`kbGetPage` metódusok. A scope-feloldás (`kb_search`-csel közös) `resolveKbConnectorScope` helperbe kiemelve — az agenthez linkelt ÖSSZES KB-connector unióján dolgozik (D-B). Tiszta, DB-mentes összeállítók: `assembleKbIndex` (maxDepth-szűrés) + `assembleKbPage` (chunk-összefűzés + forrás-link). `app/src/domain/tool-broker/tool-broker-service.ts`.
  - **Runtime-felület:** a `chat-tool-loop` `CHAT_PLATFORM_TOOLS`-ba + `TOOL_SCHEMAS`-ba + `buildToolInvoke`-ba bekötve (a többkörös loop hívja, nem előre-lefutó, mint a `kb_search`); a harness `platform-mcp-bridge` tool-definíció + HTTP-dispatch; a `toolInvokeSchema` validátor; a capability-seed (`ensureAgentKnowledgeBase` most `kb_search`+`kb_list_index`+`kb_get_page`-t oszt).
  - **Audit (§13):** `argsMeta` + `resultMeta` a nav-toolokra (pageCount / found+path+textLength).
  - **Tesztek:** `kb-retrieval.test.ts` +5 tiszta eset (index-lista, maxDepth, oldal-összefűzés sorrend, found:false, section-fallback) → 14/14 zöld; **élő repo-smoke** a TESZT DB-n (`npm run smoke:kb-nav`): published-only szűrés, `pathPrefix`, scope-izoláció, `chunkIndex`-sorrend, draft-kizárás. 0 tsc, eslint tiszta.

### ✅ Kész (Sprint 3 retrieval-mag — 2026-07-03)

- **Full-text index (§8.4/§10):** `knowledge_chunks_fts_idx` GIN index a `to_tsvector('simple', title || ' ' || text)` kifejezésre. A `prisma db push` nem hozza létre az expression-alapú tsvector indexet, ezért — az audit append-only triggerhez hasonlóan — **nyers SQL scriptként** telepítjük; dev+test DB-re lefutott.
  - `app/scripts/apply-kb-chunk-fts-index.ts` (`npm run db:apply-kb-fts[:test]`)
- **`searchChunks` (§9.1/§10):** Postgres full-text a **publikált** OKF-chunkokon (`to_tsquery('simple', term:* | …)` prefix-OR, `ts_rank` sorrend, `connector_id`-scope — D-B, csak `published` artifact — §14.1). A `simple` config ékezet-érzékeny, extension nélkül fut Neonon (§10.1); az ékezet-tűrő recallt a legacy fallback adja.
  - `app/src/repositories/postgres/knowledge-repository.ts` (`searchChunks`, `toKbTsQuery`), interfész-bővítés `KnowledgeChunkSearchHit`
- **`kb_search v2` retrieval-összeállítás (§9.1/§10/§11.3):** az OKF-chunk full-text találatok **elöl** (kurált, published), utánuk a legacy stem-scoring (memória + nem-superseded nyers doc) tölti k-ig; ha egyik sem ad találatot, teljes-korpusz fallback. Minden OKF-találat **navigálható path**-t és **oldal/section/cella-szintű forrás-linket** hordoz (§4.7). Tiszta, DB-mentes `assembleKbHits` függvényben (tesztelhető).
  - `app/src/domain/tool-broker/tool-broker-service.ts` (`assembleKbHits`, `kbSearch`, `KbSearchHit` bővítés), `app/src/lib/kb-format.ts` (citation-render), `app/src/domain/index.ts` (wiring)
- **§10.5 superseded coexistence:** ha egy dokumentumból már **publikált** OKF-artifact van, a forrás nyers `extractedText` kereshetősége superseded — nem jön vissza nyers + parafrázis duplán (`KnowledgeArtifactRepository.publishedSourceDocumentIds`).
- **Audit (§13):** a `kb_search` result-meta most `okfHitCount`-ot is jelez (published chunk vs. legacy).
- **Tesztek:** `kb-retrieval.test.ts` (9 eset: OKF-elsőbbség, citation, superseded-kihagyás, legacy fallback, tsquery-építő) + **élő SQL smoke** (találat pozitív ts_rank-kal, ékezetes query, scope-izoláció). 0 tsc, eslint tiszta; a `kb-gate` 14/14 továbbra is zöld.
  - `app/scripts/kb-retrieval.test.ts` (`npm run test:kb-retrieval`)

### ✅ Kész (Sprint 1 + §17 determinisztikus mag)

- **Adatmodell (§8):** `KnowledgeProcessingMode`, `KnowledgeArtifactStatus`, `KnowledgeArtifactFormat`, `KnowledgeConnectorSharing` enumok; `Document` bővítés (`mimeType`, `contentHash`, `processingMode`, `metadata`); `KnowledgeArtifact` (**connector-scope**, `createdByAgentId` nullable provenance — D-B) és `KnowledgeChunk` (oldal/section granularitás, `sourceRef` JSON, **embedding nélkül** — D-A). db push dev+test lefutott.
  - `app/prisma/schema.prisma`
- **Repository réteg (§11):** `KnowledgeArtifactRepository` + `KnowledgeChunkRepository` interfész és Postgres-implementáció, bekötve a `repositories` konténerbe és a `KnowledgeBaseService`-be.
  - `app/src/repositories/interfaces/index.ts`, `app/src/repositories/postgres/knowledge-repository.ts`
- **KB-v3 mag (§4.7/§5/§17):** determinisztikus (nem LLM) OKF-bundle generátor (`buildOkfBundle` — `index.md` + heading-szekció oldalak + `## Source` forrás-link), heading-alapú chunkoló (`chunkOkfBundle`) formátumfüggő `sourceRef`-fel, és a `SYSTEM_TENANT_ID` konstans (D-E, valós UUID — nincs NULL-ág).
  - `app/src/lib/kb-v3.ts`
- **Artifact-flow (§7.5/§7.8/§11.1):** `requestDocument({processingMode})` → OKF-módban draft artifact (`pending_review`); `approveDocument` publikál (chunk index épül, `published` + `publishedAt`); `rejectDocument` → artifact `failed`; `publishArtifact`, `listPendingArtifacts`. Új audit action-ök: `kb.artifact.generated/published/rejected`.
  - `app/src/domain/knowledge-base/knowledge-base-service.ts`, `app/src/lib/audit/event-catalog.ts`
- **Acceptance-teszt (§16 Sprint 1):** draft artifact keletkezik; publikálás előtt **nincs chunk → nem kereshető**; jóváhagyás után published + chunk index. 14/14 zöld, tsc + eslint tiszta.
  - `app/scripts/knowledge-base-gate.test.ts` (`npm run test:kb-gate`)

### ⛔ Még hátra (nem készült el)

- **Sprint 2 — Extraction pipeline (§7.3):** ✅ **KÉSZ** — formátumfüggő PDF-oldal / DOCX-section / XLSX-cella forrás-provenance (`kb-extraction.ts`), a szeletek a `Document.metadata`-ban, a `buildOkfBundle` `blocks`-integrációjával (lásd fent). A layout-aware span-pontos citation (bekezdés/byte-offset) tudatosan post-MVP (D-G/D7).
- **Sprint 3 — Retrieval (§9.1/§10):** ✅ **KÉSZ** — full-text GIN index + `kb_search v2` chunk-alapú full-text keresés + §10.5 superseded coexistence + oldal/section-szintű citation payload (lásd fent).
- **Sprint 3 — Navigáció (§9.2/§9.3):** ✅ **KÉSZ** — `kb_list_index` + `kb_get_page` end-to-end (repo → Tool Broker → chat-tool-loop + harness-bridge + validátor + capability-seed + audit); tiszta összeállítók tesztelve + élő repo-smoke (lásd fent).
- **Sprint 3 — Review UI (§12.2):** ✅ **KÉSZ** — hárompaneles artifact-review overlay (forrás / OKF file-tree+preview / validation report + approve/reject) + §7.6 determinisztikus validátor (`kb-validator.ts`), a `validationResult`-be mentve és a review UI-ban megjelenítve (lásd fent).
- **Sprint 4 — Eval (§15):** ✅ **KÉSZ** — determinisztikus eval-generátor + retrieval-kiértékelő (`kb-eval.ts`), a valódi assembler ellen tesztelve (lásd fent). A körkörös LLM-generált-és-ítélt kérdés-készlet (§15) mint jövőbeli bővítés a `retrieve` varraton át beköthető; a determinisztikus mag már ad regressziós jelzést.
- **Governance-részletek:** külön „knowledge admin" szerep (§8.6) — MVP-ben az `admin`/`approver` fedi, dedikált enum-érték nem készült. `KnowledgeProcessingJob` modell (§8.5, opcionális) — nincs.

---

## 0. Mi változott a v2-höz képest (döntésnapló)

Ez a verzió egy strukturált „grilling" (design-pressure-test) eredménye. A v2 több feltevése megdőlt vagy egyszerűsödött:

| # | Döntés | v2 | v3 |
|---|---|---|---|
| D-A | **Retrieval-modell** | OKF-wiki + Postgres/pgvector **hibrid RAG** | **OKF-navigáció + Postgres full-text**, vektor **nélkül**; a `KnowledgeIndexStore` varrat megmarad későbbi vektorhoz |
| D-B | **Scope-kulcs** | `agentId` a chunkon/artifacton (1 connector = 1 agent feltételezés) | **`connectorId` az authoritatív scope-kulcs**; az `agentId` legfeljebb nullable provenance, retrievalben **soha nem szűr** |
| D-C | **Megoszthatóság** | implicit agent-scope | **A KB = egy connector; 1..N agent linkelheti** (`agentConnector`, `accessMode`). A megoszthatóság a *connector* tulajdonsága, **független** a tartalom típusától |
| D-D | **Tartalom-típus vs. megosztás** | OKF ≈ agent-privát összemosva | **Két független tengely:** `processingType ∈ {raw_file, okf}` és `sharing ∈ {single, multi}` |
| D-E | **Globális/platform-tudás** | `tenant NULL` (izolációs rés) | **valódi `system` tenant**; a scope-filter változatlan (`WHERE tenant_id = :t`), nincs NULL-ág |
| D-F | **Írás a KB-be** | tervezett auto-write / agent-önírás | **kizárólag ticket-alapú emberi kapu** MVP-ben; `writePolicy` toggle **elhalasztva** |
| D-G | **Citation pontosság** | span-szint (`page, paragraph, byte offset`) | **oldal/section-szintű „innen származik" link** a forrásra; hamis pontosság nélkül. Span formátumfüggő: PDF=oldal, DOCX=section, XLSX=cella |
| D-H | **Idézés forrása** | kétértelmű | **„wikiben kerestél → wikiből idézel"**; az eredeti dokumentum-ref az OKF-ben marad emberi verifikációhoz |
| D-I | **Navigáció-toolok** | „későbbi" (`kb_get_page`, `kb_list_index`) | **elsődleges retrieval-út**; a runtime többkörös tool-loopja támogatja (`chat-tool-loop.ts`, `maxTurns=20`) |

**A v3 egymondatos iránya:**

> **OKF-kompatibilis, ember által review-zott dokumentum-tudásbázis + Postgres full-text keresés + OKF-navigáció + connector-alapú megosztás + meglévő ticket/write-gate/audit governance. Vektor nélkül, de arra bővíthető varrattal.**

---

## 1. Probléma

### 1.1 Jelenlegi állapot

- eredeti fájl: `Document.storageRef`,
- opcionálisan kinyert szöveg: `Document.extractedText`,
- feldolgozási állapot: `Document.status`,
- KB-hez kapcsolás: `Document.connectorId`.

A `KnowledgeBaseService` governance-alapja jó: feltöltött dokumentumhoz tanítási ticketet nyit, a dokumentum addig nem kereshető, amíg nincs jóváhagyva, jóváhagyás után `connectorId + processed` állapotot kap. A retrieval ma egy in-memory stem-scoring az `extractedText`-en és a memórián, az agenthez linkelt összes KB-connector unióján (`tool-broker-service.ts`).

### 1.2 Hiányosságok

1. **Nem kurált tudás** — a nyers PDF/DOCX szöveg zajos.
2. **Nem review-zható értelmesen** — nagy text blobot nehéz hitelesíteni.
3. **Nem navigálható** — az agent nem tud fogalmak/szabályok/runbookok között linkelten mozogni.
4. **Gyenge provenance** — a válasz nem vezethető vissza a forrás konkrét helyére.
5. **Nehezen frissíthető** — nincs jó verzió-diff.
6. **Gyenge keresés** — a puszta kulcsszó/stem-scan kevés.

> **Megjegyzés a scope-ról:** a v3 tudatosan **nem** old meg nagy, rendezetlen corpuson való szemantikus keresést (RAG). A célzott use-case-ek kurált, mérsékelt méretű tudásbázisok (policy-k, playbookok, runbookok), ahol a **struktúra + kulcsszó + emberi kuráció** elég. Ha később valódi nagy corpus jelenik meg, a §10.4 varrat mentén hozzátehető a vektor.

---

## 2. Célállapot

- feltöltött fájlokból **opcionálisan** agent-friendly OKF-tudásréteg készül (opt-in, dokumentumonként);
- a canonical tudás **ember által olvasható markdown/OKF bundle**;
- minden tudásfrissítés **write-gate / approval / audit** alatt marad, kizárólag **emberi jóváhagyással**;
- a runtime retrieval **determinisztikus**: scope-filter + full-text + OKF-navigáció + forrás-link citation;
- az agent kizárólag a Tool Broker által engedélyezett eszközökkel fér hozzá;
- a régi `kb_search` szerződés **backward-compatible** marad.

---

## 3. Döntés: kurált OKF-dokumentum-tudásbázis, RAG nélkül

### 3.1 Miért OKF-kompatibilis dokumentum-réteg?

- markdown fájlok + YAML frontmatter,
- ember által review-zható, diffelhető, verziózható artifact,
- linkelhető concept page-ek → **a struktúra maga a retrieval-affordancia** (navigáció),
- vendorsemleges, nincs kötelező runtime,
- illeszkedik a platform governance-modelljéhez: a tudás nem fekete doboz, hanem auditálható artifact.

### 3.2 Miért nem (most) vektoros RAG?

- **Enterprise-auditálhatóság:** egy embedding-index nem mutatja meg, mit „tud" pontosan az agent.
- **Infra-kockázat:** pgvector Neonon = nyílt kérdés (extension-elérhetőség, nyers SQL a Prisma-réteg megkerülésével, dimenzió-lock, embedding-verziózás provider-váltásnál). Ezt a v3 **nem** vállalja az MVP-ben.
- **A célzott use-case-ek nem igénylik:** kurált, mérsékelt KB-n a navigáció + full-text jobb (determinisztikus, nem „talál ki" hasonlóságot).

### 3.3 A RAG-elhagyás ára és a biztonsági háló

RAG nélkül **nincs retrieval-oldali biztonsági háló** — az agent a wiki minőségén és struktúráján múlik. Mivel a review a gyakorlatban gyakran „approve all" lesz, a teljes súly az **LLM-parafrázisra** és a **review-ra** kerülne. Ezt **egy dolog ellensúlyozza:** minden OKF-oldal a **forrásoldalra visszamutató linket** hordoz (D-G/D-H). Ez az egyetlen ellenőrzési pont, ezért **a citation-link nem lehet gyenge** (§5, §9.1).

### 3.4 Végleges javaslat

**Canonical knowledge layer:** OKF-kompatibilis markdown bundle.
**Runtime retrieval layer:** Postgres full-text (`tsvector`) + OKF-navigáció; **nincs vektor**, de `KnowledgeIndexStore` interfész-varrat megmarad.
**Agent access layer:** Tool Broker mögötti `kb_search v2`, `kb_get_page`, `kb_list_index` (mindhárom első osztályú).

---

## 4. Fogalmak

### 4.1 Raw Document
Az eredeti feltöltött dokumentum — `Document` + `storageRef`.

### 4.2 Extracted Text
Kinyert normalizált text/markdown. Backward compatibility és feldolgozási input.

### 4.3 Knowledge Artifact
Verziózott, review-zható OKF-tudáscsomag egy forrásdokumentumból (MVP: one document → one artifact, §18/D5).

### 4.4 Knowledge Base (connector)
**A KB = egy `knowledge_base` típusú connector.** 1..N agent linkelheti (`agentConnector`, `accessMode` `read`/`write`). A megoszthatóság a connector tulajdonsága, **független** attól, hogy a tartalma nyers file vagy OKF (D-C/D-D).

### 4.5 OKF Bundle
Markdown fájlok könyvtára YAML frontmatterrel:

```text
kb/<connectorId>/
  index.md
  policies/
    index.md
    remote-work-policy.md
  procedures/
    onboarding.md
  glossary/
    terms.md
  log.md
```

> **Fontos:** a bundle a **connectorhoz** kötődik (`kb/<connectorId>/`), **nem** az agenthez — ez a D-B scope-döntés következménye.

### 4.6 Knowledge Chunk
A publikált OKF bundle indexelhető egysége (oldal/section granularitás). Tartalmaz: text, path, section, metadata, **source ref** (oldal/section-szint), content hash, full-text index mező. **Nincs embedding mező** (D-A).

### 4.7 Source Ref (a v2 „Source Span" helyett)
A forrásra mutató provenance, **formátumfüggő és durva** (D-G):

- dokumentum ID + filename (mindig),
- **PDF:** oldalszám (ha kinyerhető),
- **DOCX:** heading/section út (a DOCX-nek nincs fix lapozása),
- **XLSX:** `Sheet!R{n}C{m}` cella-hivatkozás (pontos),
- rövid idézet (best-effort).

**Nincs** `paragraph` és `byte offset` ígéret, amíg nincs layout-aware extractor.

---

## 5. Példa OKF concept page

```markdown
---
type: Policy
title: Remote Work Policy
description: Company policy for remote work eligibility, approval and reporting.
resource: gcs://bucket/raw/hr-remote-policy.pdf
tags: [hr, remote-work, policy]
timestamp: 2026-07-03T10:00:00Z
source_document_id: "..."
connector_id: "..."            # a KB scope-kulcsa (NEM agent_id)
created_by_agent_id: "..."     # opcionális provenance, retrievalben nem szűr
classification: internal
confidence: draft_llm_generated
---

# Remote Work Policy

## Summary
Employees may request remote work if the role and team operating model allow it.

## Rules
- Approval is required from the direct manager.
- Exceptions are handled by HR.
- Changes must be recorded in the HR system.

## Related
- [Onboarding](../procedures/onboarding.md)

## Source
- Forrás: `hr-remote-policy.pdf`, oldal 3 — [ellenőrzés]
- Forrás: `hr-remote-policy.pdf`, oldal 5 (táblázat) — [ellenőrzés]
```

> A `## Source` szekció **oldal/section-szintű link a forrásdokumentumra**, nem span-pontos idézet. Az ember odalapoz és ellenőriz.

---

## 6. Célarchitektúra

```text
CONTROL PLANE
  Agent Registry
  KB upload UI  (processing-mode + sharing + write-policy)
  KB artifact review UI
  Training/write-gate tickets
  Knowledge admin (tenant-szintű szerep)
  Audit log

DATA PLANE
  Raw document storage
  Extraction pipeline
  OKF generator
  OKF validator
  Knowledge artifact store
  Knowledge chunk index (full-text; NINCS vektor)

TOOL BROKER
  kb_search v2      (scope + full-text)
  kb_get_page       (navigáció)
  kb_list_index     (navigáció)

AGENT RUNTIME
  Harness / chat-tool-loop (többkörös tool-loop, maxTurns=20)
  Model Gateway
  Tool Broker only, no direct KB/database access
```

> Az agent nem fér hozzá közvetlenül a dokumentumokhoz vagy az adatbázishoz. Minden lekérdezés a Tool Brokeren megy át (authorization, audit, policy enforcement).

---

## 7. Pipeline

### 7.1 Upload
Rögzítendő: `filename`, `storageRef`, `status = uploaded`, `uploadedById`, opcionálisan `mimeType`, `contentHash`, `metadata`.

### 7.2 Processing mode + KB-beállítások
A UI mód-választója (default **nem** OKF, és lebeszéli a fölösleges konverziót — D-A/§0):

1. **Raw text only** — legacy / gyors.
2. **OKF** — LLM által generált OKF-javaslat review-ra.

A KB (connector) szintjén beállítható:
- **sharing:** single-agent vagy multi-agent (hány agent linkelheti);
- **write-policy:** MVP-ben fix `human_approved` (a toggle elhalasztva — D-F).

### 7.3 Extraction
- PDF: `pdf-parse` (oldal-szint provenance; layout-aware parser később),
- DOCX: `mammoth` (heading/section-szint; „oldal" nincs),
- XLSX: `exceljs` (cella-pontos),
- Markdown/HTML/plain text: direkt parser.

Kimenet: normalized markdown + **source refs** (§4.7) + structural blocks.

### 7.4 Segmentation
Szemantikai egységek: fejezetek, policy rule-ok, definíciók, táblák, folyamatlépések, FAQ.

### 7.5 OKF generation
Az LLM létrehoz: `index.md`, concept page-ek, `log.md`, warnings, source coverage report. **Nem publikál automatikusan** — mindig `pending_review` / `draft`.

> A citation a legkevésbé megbízható LLM-output. MVP-ben a `## Source` **oldal/section-szintű forrás-link**, nem span-pontos állítás — így a hiba „rossz oldalra lapozás", nem „hamis pontosság" (D-G).

### 7.6 Validation
YAML frontmatter parse, kötelező mezők, broken links, üres/túl hosszú oldalak, **source-link coverage**, tenant/connector egyezés, tiltott külső linkek / érzékeny adat jelzése.

### 7.7 Human review
Approver nézet: eredeti dokumentum, extracted text, generált OKF file tree, page preview, diff az előző verzióhoz, validation warnings, approve/reject. **Az emberi jóváhagyás az egyetlen write-út** (D-F).

### 7.8 Publish
Approval után:
- `KnowledgeArtifact.status = published`,
- `Document.status = processed`, `Document.connectorId` beáll,
- a forrás nyers doc kereshetősége **superseded** lesz (§10.5, hogy ne jöjjön vissza kétszer),
- `KnowledgeChunk` rekordok + full-text index frissül,
- audit event rögzül.

---

## 8. Adatmodell-javaslat

### 8.1 Enumok

```prisma
enum KnowledgeProcessingMode {
  raw_text_only
  okf                 // v2 okf_wiki; a structured_rag / okf_plus_rag törölve (nincs RAG)
}

enum KnowledgeArtifactStatus {
  draft
  processing
  pending_review
  published
  failed
  superseded
}

enum KnowledgeArtifactFormat {
  okf_v0_1
  markdown_bundle
  raw_markdown
  json
}

enum KnowledgeConnectorSharing {
  single_agent
  multi_agent
}
```

### 8.2 Document bővítés

```prisma
model Document {
  // meglévő mezők változatlanul
  id            String         @id @default(uuid()) @db.Uuid
  filename      String
  storageRef    String         @map("storage_ref")
  extractedText String?        @map("extracted_text")
  status        DocumentStatus @default(uploaded)
  connectorId   String?        @map("connector_id") @db.Uuid
  uploadedById  String         @map("uploaded_by") @db.Uuid
  createdAt     DateTime       @default(now()) @map("created_at") @db.Timestamptz

  // KB-v3 javasolt mezők
  mimeType       String?        @map("mime_type")
  contentHash    String?        @map("content_hash")
  processingMode KnowledgeProcessingMode? @map("processing_mode")
  metadata       Json           @default("{}")
}
```

### 8.3 KnowledgeArtifact

```prisma
model KnowledgeArtifact {
  id               String                  @id @default(uuid()) @db.Uuid
  tenantId         String?                 @map("tenant_id") @db.Uuid   // system-tenant is valós sor (D-E)
  connectorId      String                  @map("connector_id") @db.Uuid // SCOPE-KULCS
  createdByAgentId String?                 @map("created_by_agent_id") @db.Uuid // provenance, NEM scope (D-B)
  sourceDocumentId String?                 @map("source_document_id") @db.Uuid

  format           KnowledgeArtifactFormat @default(okf_v0_1)
  status           KnowledgeArtifactStatus @default(draft)
  version          Int
  contentHash      String                  @map("content_hash")
  bundleRef        String                  @map("bundle_ref")
  generationModel  String?                 @map("generation_model")
  generationPromptHash String?             @map("generation_prompt_hash")
  validationResult Json                    @default("{}") @map("validation_result")
  reviewSummary    String?                 @map("review_summary")
  createdById      String?                 @map("created_by") @db.Uuid
  approvedById     String?                 @map("approved_by") @db.Uuid
  createdAt        DateTime                @default(now()) @map("created_at") @db.Timestamptz
  publishedAt      DateTime?               @map("published_at") @db.Timestamptz

  @@unique([connectorId, sourceDocumentId, version])
  @@index([tenantId, connectorId, status])   // scope = tenant + connector
  @@index([connectorId, status])
  @@map("knowledge_artifacts")
}
```

> **A v2-höz képest:** az `agentId NOT NULL` **kikerült** mint scope-kulcs; helyette `connectorId` az authoritatív, és `createdByAgentId` a nullable provenance (D-B).

### 8.4 KnowledgeChunk

```prisma
model KnowledgeChunk {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String?  @map("tenant_id") @db.Uuid
  artifactId   String   @map("artifact_id") @db.Uuid
  connectorId  String   @map("connector_id") @db.Uuid   // SCOPE-KULCS (D-B)

  path         String
  title        String
  type         String
  section      String?
  chunkIndex   Int      @map("chunk_index")
  text         String
  summary      String?
  tags         Json     @default("[]")
  metadata     Json     @default("{}")
  sourceRef    Json?    @map("source_ref")   // oldal/section-szint (§4.7), NEM span-pontos
  contentHash  String   @map("content_hash")

  // Full-text: Postgres tsvector generált oszlop / GIN index nyers SQL migrationnel.
  // NINCS embedding mező (D-A). A vektor később a KnowledgeIndexStore mögött adható hozzá.

  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([tenantId, connectorId])   // scope = tenant + connector
  @@index([connectorId])
  @@index([artifactId, path])
  @@map("knowledge_chunks")
}
```

### 8.5 KnowledgeProcessingJob (opcionális)

Változatlan a v2-höz képest, kivéve hogy a `mode` a szűkített `KnowledgeProcessingMode` enumot használja. (A teljes modell a v2 §8.5-ben.)

### 8.6 Governance-kiegészítések

- **`system` tenant:** valódi tenant-sor a platform-adminisztrációs agenteknek (Provisioning Agent stb.) és azok tudásának. A `kb_search` scope-filter változatlan (`WHERE tenant_id = :t`); a system-agenteknél `:t = system` (D-E).
- **Knowledge admin szerep:** tenant-szinten állítható; a megosztott / tenant-szintű KB-k governance-gazdája. A `system` tenantot **külön platform/super-admin** kezeli — strukturálisan elválik a tenant-adminoktól.
- **Write-jog:** a `read` link bőkezűen osztható; a `write`/`contribute` szűk (KB-gazda + knowledge admin). **Many-reader / few-writer.**

---

## 9. Tool Broker API

### 9.1 `kb_search v2`

Név marad `kb_search`; a mögöttes implementáció full-text + scope alapú.

```ts
type KbSearchInput = {
  query: string
  agentId: string
  topK?: number
  mode?: 'answer_context' | 'wiki_navigation' | 'exact_lookup'
  filters?: {
    tags?: string[]
    type?: string[]
    sourceDocumentId?: string
    updatedAfter?: string
  }
}

type KbSearchResult = {
  chunks: Array<{
    text: string
    score: number          // full-text rank (ts_rank), NEM cosine
    artifactId: string
    path: string           // OKF path — navigációhoz is használható
    title: string
    type: string
    confidence?: string    // pl. draft_llm_generated — trust jelzés a citationhöz
    source: {
      documentId?: string
      filename?: string
      page?: number         // PDF esetén
      section?: string      // DOCX/OKF esetén
      cell?: string         // XLSX esetén
    }
  }>
  suggestedLinks?: Array<{ title: string; path: string; reason: string }>  // navigáció
}
```

### 9.2 `kb_get_page` — **elsődleges retrieval-út** (nem „későbbi")

```ts
type KbGetPageInput = {
  agentId: string
  path: string
  artifactId?: string
}
```

### 9.3 `kb_list_index` — **elsődleges retrieval-út**

```ts
type KbListIndexInput = {
  agentId: string
  pathPrefix?: string
  maxDepth?: number
}
```

> A navigáció (`kb_list_index → kb_get_page`) a runtime **többkörös tool-loopjára** épül (`chat-tool-loop.ts`, `maxTurns=20`, a tool-eredmény visszakerül a kontextusba). Ez runtime-szinten igazolt (D-I).

---

## 10. Retrieval stratégia

A `kb_search v2` lépései:

1. **Authorization:** a Tool Broker ellenőrzi, hogy az agent használhatja-e a `knowledge_base` connectort.
2. **Scope filter:** `tenantId` + **az agenthez linkelt connector-halmaz** (`agentConnector`) + `published` artifact. **A szűrő `connectorId`-alapú, nem `agentId`-alapú** (D-B).
3. **Metadata filter:** tags, type, sourceDocumentId, classification.
4. **Full-text search:** Postgres `tsvector` / `websearch_to_tsquery`, `ts_rank` sorrend.
5. **Navigáció (opcionális, agentic):** ha `mode = wiki_navigation`, a `suggestedLinks` + `kb_get_page` úton az agent bejárja az OKF-fát.
6. **Citation assembly:** source ref (oldal/section) + OKF path + document metadata + `confidence`.
7. **Audit:** tool call, input hash, output refs, policy decision.

> **Nincs** vektoros keresés, fúzió (RRF) és rerank az MVP-ben.

### 10.1 Miért Postgres full-text?
A platform már Postgres/Prisma alapú. A `tsvector` beépített, **extension nélkül** működik Neonon, determinisztikus és olcsó. A vektorok elhagyásával eltűnik a v2 D2/D3 kockázata (pgvector-elérhetőség, nyers SQL, dimenzió-lock, embedding-verziózás).

### 10.4 `KnowledgeIndexStore` varrat (jövőbeli vektor)
A retrieval egy `KnowledgeIndexStore` interfész mögött legyen (full-text implementációval). Így később **hozzáadható** a vektoros substrate (pgvector vagy külső) **a kb_search újraírása nélkül**. Ez ne legyen egyirányú ajtó.

### 10.5 Nyers doc ↔ OKF coexistence
Ha egy dokumentumból OKF-artifact készül és publikálódik, a **forrás nyers `extractedText` kereshetősége superseded** lesz — így a full-text nem ad vissza egyszerre nyers és parafrazált változatot ugyanarról. A `KnowledgeArtifactStatus.superseded` erre való.

### 10.6 Memória vs. dokumentum (integráció)
A mai `kb_search` egy poolba fúzionálja a memóriát és a dokumentumokat. A v3-ban **minden retrievable egység chunk** (a memória is heading-chunkolva, ha bekerül a KB-keresésbe), egyetlen full-text index, egyetlen `ts_rank` sorrend — így nincs két, nehezen kalibrálható scoring-skála.

---

## 11. Domain service változások

### 11.1 `KnowledgeBaseService`
Marad orchestration layer, bővül:

```ts
type RequestDocumentParams = {
  agentId: string
  documentId: string
  createdById: string
  processingMode?: 'raw_text_only' | 'okf'
}
```

Új metódusok: `requestDocument`, `startProcessing(ticketId)`, `createDraftArtifact`, `approveArtifact`, `rejectArtifact`, `publishArtifact`, `listPendingArtifacts(agentId)`.

### 11.2 Approval jelentése
Approval után: artifact publikálódik, chunk index épül (full-text), forrás nyers doc superseded, document `processed`, `connectorId` beáll, audit event rögzül.

### 11.3 Backward compatibility
Ha nincs `KnowledgeArtifact`, a `kb_search` fallbackel a régi `Document.extractedText` full-text keresésre. A meglévő megosztott KB-linkek (pl. „Excellence Pay belső tudásbázis") **grandfatherből maradnak**; a connector-alapú scope ezt natívan kezeli.

---

## 12. UI/UX javaslat

### 12.1 Upload képernyő
- Az operátor fájlt tölt fel vagy szöveget illeszt be, majd **Beküldés jóváhagyásra**.
- A feldolgozási módot **nem** a feltöltő választja (nincs „Nyers KB” / „OKF wiki” a feltöltő sávon).
- **sharing:** a teljes KB-connector megosztása másik agenttel; a szekció akkor jelenik meg, ha van jóváhagyott dokumentum vagy meglévő megosztás.
- feldolgozási státusz: uploaded → awaiting approval → (approver választ módot) → published / failed.

### 12.2 Review képernyő
A **jóváhagyó** választja a módot: **Egyszerű dokumentum** (`raw_text_only`) vagy **Feldolgozás wiki formában** (`okf`). Wiki esetén draft artifact készül, majd hárompaneles review: (1) feltöltött szöveg, (2) wiki oldalak + preview, (3) ellenőrzés + approve/reject. Kiemelések: alacsony source-link coverage, ellentmondás, broken link, nem besorolt / érzékeny tartalom. Jóváhagyás mód nélkül nem engedélyezett.

### 12.3 Agent sandbox nézet
A citation mutassa: OKF page title, section, original filename, source **oldal/section** (nem span), artifact version, `confidence` jelzés.

---

## 13. Audit és governance

Új audit actionök: `kb.processing.started/failed`, `kb.artifact.generated/validation_failed/approved/rejected/published`, `kb.index.rebuilt`, `kb.search.executed`.

Audit metadata (kivonat):

```json
{
  "connectorId": "...",
  "createdByAgentId": "...",
  "documentId": "...",
  "artifactId": "...",
  "artifactVersion": 3,
  "contentHash": "...",
  "processingMode": "okf",
  "model": "...",
  "validation": { "brokenLinks": 0, "sourceLinkCoverage": 0.92, "warnings": 2 }
}
```

---

## 14. Security és compliance

### 14.1 Isolation
- Agent csak Tool Broker toolokon át fér hozzá.
- Runtime csak `published` artifactból keres.
- Draft/pending csak review UI-ban látható.

### 14.2 Tenant és connector scope
Minden chunk hordozza: `tenantId`, `connectorId`, `artifactId`. A `kb_search` első lépése **mindig** scope-filter, `tenantId = :t` (a `system` tenant is valós érték, **nincs NULL-ág**) **és** `connectorId ∈ (agent linkelt connectorai)`.

### 14.3 Megosztás és write-jog
- `read` link bőkezűen osztható; `write` szűk (KB-gazda + knowledge admin) — **many-reader / few-writer**.
- Az agent **nem ír** a KB-be közvetlenül; minden write ticket-alapú emberi jóváhagyással (D-F).

### 14.4 Retention és legal hold
Dokumentum törlésekor/lejáratakor: artifact superseded/deleted, chunk soft delete/tombstone, audit trail megőrzés policy szerint.

### 14.5 Sensitive data warnings
A pipeline jelezze: személyes adat, API key/secret gyanú, pénzügyi adat, confidential tartalom. MVP-ben regex + LLM classifier **warning**, nem enforcement.

---

## 15. Eval stratégia (egyszerűsített)

RAG nélkül az eval kisebb. Minden publikált artifacthoz **opcionálisan**:
- 10–30 kérdés a dokumentumból,
- expected **OKF path + forrás-link**,
- negatív kérdések („nem tudható a dokumentumból"),
- regression a publish után.

Metrikák: **navigációs helyesség** (a jó oldalra jutott-e), answer groundedness, **source-link correctness** (a wiki-oldal a helyes forrásoldalra mutat-e — ez a ground truth, nem span-pontosság), no-answer precision, latency, token cost.

> **A körkörösség tudatos korlátja:** ugyanaz az LLM generálja és ítéli a kérdéseket — ez smoke/regression jelzés, nem abszolút minőségmérce. Emberi spot-check kell mellé.

---

## 16. MVP roadmap (átalakítva — a v2 „Sprint 4 hibrid retrieval" törölve)

### Sprint 0 — (új) nincs pgvector-spike
A vektoros réteg elhagyásával a v2 legnagyobb infra-kockázata (D2/D3) **eltűnik**. Nincs külön de-risking sprint.

### Sprint 1 — Data model és skeleton
`KnowledgeArtifact` (connector-scope), `KnowledgeChunk` (full-text, embedding nélkül), `KnowledgeProcessingMode` enum, `Document` bővítés, repository interfészek, üres processing job flow, `system` tenant + knowledge admin szerep.
**Acceptance:** dokumentumhoz draft artifact jön létre; approval előtt nem kereshető; approval után published.

### Sprint 2 — Extraction és OKF generator ✅ KÉSZ
PDF/DOCX/XLSX/MD extraction, normalized markdown, **formátumfüggő source ref** (§4.7), OKF bundle generator (`index.md`, concept page-ek), a szeletek `Document.metadata`-ban, `buildOkfBundle` `blocks`-integráció + `source_ref` frontmatter round-trip.
**Acceptance (teljesült):** valós PDF-fixture-ből és XLSX-bufferből oldal/cella-szintű source ref; DOCX HTML→section; end-to-end blokk→bundle→chunk round-trip tesztelve (`test:kb-extraction`, 11/11). A basic validator (§7.6) a Sprint 3 review UI-jal jön.

### Sprint 3 — Review UI + retrieval ✅ KÉSZ
KB artifact review oldal, file tree preview, diff, approve/reject, audit events. **Full-text index + `kb_search v2` + `kb_get_page` + `kb_list_index`** a Tool Broker mögött (a v2-ben ez Sprint 4 volt — most ide olvad, vektor nélkül).
**Acceptance (teljesült):** approver látja a wiki tartalmat a hárompaneles review overlay-en (forrás / OKF file-tree+preview / §7.6 validation report); approve után publish + full-text kereshető; agent chunk + citation payloadot kap; fallback a legacy `extractedText`-re; csak published artifactból keres; **navigáció működik a többkörös tool-loopon**. (A verzió-diff az előző artifacthoz tudatosan post-MVP — D4/D5: MVP-ben one-document→one-artifact + csak approve/reject.)

### Sprint 4 — Eval és polish ✅ KÉSZ
Determinisztikus eval-generálás a published korpuszból, retrieval/navigation regression a valódi assembler ellen, source-link correctness report, latency/token-cost mérés (`kb-eval.ts` + `test:kb-eval`).
**Acceptance (teljesült):** eval-készlet generálódik minden published OKF-oldalra (+ negatívok); a kiértékelő méri a navigációs helyességet / retrieval recallt / source-link helyességet / no-answer precíziót / latencyt / token-költséget; a metrikák a termelési `assembleKbHits` ellen igazoltak (9/9 zöld). A körkörös LLM-generált kérdés-készlet (§15 tudatos korlátja) a `retrieve` varraton át bővíthető.

---

## 17. Első implementációs szelet

A legkisebb hasznos változtatás:

1. `KnowledgeArtifact` + `KnowledgeChunk` tábla (**connector-scope**, embedding nélkül).
2. `KnowledgeBaseService.approveDocument()` úgy, hogy ne csak `Document.connectorId + processed` legyen, hanem `KnowledgeArtifact(published)` is, és a forrás nyers doc superseded.
3. Egyszerű OKF bundle generátor markdown fájlokra, **forrás-linkkel** a `## Source` szekcióban.
4. `KnowledgeChunk` heading-alapú chunkolással + Postgres full-text index.
5. `kb_search` fallback + új full-text chunk search; `kb_get_page`/`kb_list_index` a navigációhoz.

Ez már vektor nélkül is értéket ad: review-zható canonical artifact, jobb citation-út, navigálható struktúra — és a §10.4 varrat mentén később könnyű ráépíteni a vektort.

---

## 18. Nyitott döntések

| # | Döntés | Javaslat |
|---|---|---|
| D1 | OKF bundle hol tárolódjon? | MVP: GCS/storageRef prefix (`kb/<connectorId>/`) vagy DB-backed virtual files; később Git export |
| D4 | Draft artifact szerkeszthető-e kézzel? | MVP-ben csak approve/reject; később inline edit |
| D5 | One document = one artifact vagy multi-document bundle? | MVP: one document → one artifact; később bundle merge |
| D6 | OKF schema strictness | MVP: minimális frontmatter schema; később versioned schema |
| D7 | Layout-aware PDF extractor (span-pontos citation) | Post-MVP befektetés; MVP: oldal/section-szint (D-G) |
| D8 | Vektor visszahozatala | Csak ha valódi nagy, rendezetlen corpus jelenik meg; a §10.4 varrat mentén (v2 D2/D3 újranyílik) |

*(A v2 D2 [pgvector] és D3 [embedding provider] az MVP-ből törölve — a RAG-elhagyás következménye.)*

---

## 19. Nem cél az első verzióban

- teljes vállalati document management rendszer,
- real-time collaborative wiki editor,
- automatikus publikálás emberi review nélkül (D-F),
- **vektoros / szemantikus RAG** (D-A — a §10.4 varrat mentén később),
- **agent-önírás a KB-be** jóváhagyás nélkül (D-F),
- span-pontos citation layout-aware extractor nélkül (D-G),
- multi-agent shared ontology teljes megoldása,
- complex knowledge graph reasoning.

---

## 20. Összegzés

A KB-v3 iránya:

> **OKF-kompatibilis, ember által review-zott dokumentum-tudásbázis + Postgres full-text keresés + OKF-navigáció + connector-alapú megosztás + `system`-tenant globális tudás + ticket-alapú write-gate + erős audit. Vektor nélkül, de arra bővíthető varrattal.**

Illeszkedik a meglévő architektúrához:
- a `knowledge_base` connector és a `kb_search` tool megmarad,
- az approval flow megmarad (egyetlen write-út: emberi jóváhagyás),
- a scope **connector-alapú** (megoszthatóság a connector tulajdonsága),
- a globális tudás valódi `system` tenant (nincs izolációs NULL-rés),
- a nyers dokumentum nem tűnik el, a forrás-link ellenőrizhető,
- az infra-kockázat (pgvector) eltűnik, a vektor később hozzátehető.

A változtatás nem RAG-upgrade, hanem termékdifferenciátor: a platform kontrollált, review-zható, verziózott, **navigálható és forrás-visszavezethető** enterprise knowledge layert épít a feltöltött fájlokból — a governance megőrzésével.
