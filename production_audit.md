# Production Audit napló

Napi éles-környezeti biztonsági és megbízhatósági audit. Minden bejegyzés egy
vizsgált scope-ot, a coverage-t, a bizonyított findingokat, a javításokat, az
ellenőrzéseket és a residual riskeket rögzíti. Cél: bizonyítható kockázatcsökkenés
és növekvő audit-coverage.

---

## 2026-10-29 — AI-adattárház (#984/#985) Excel-import: összevont tartományok (merge) memória-amplifikáció → PR #997

**Scope-választás (kockázati alapon):** `git fetch` után `origin/main` `ef7a2e5e`-en állt; a 10-28-i kör bázisa
(`64b656ca`) óta több merge, köztük a legnagyobb, **még nem auditált** új alrendszer: a **#984/#985 AI-adattárház
1. fázis** (`c0b9047c` + követő fixek `6b9f0286`, `199df3ce`, `eacfc9cd`). Ez a legmagasabb unknown-unknown
kockázat: **untrusted `.xlsx` beolvasás** (DoS/zip-bomba/memória), **lekérdezés-motor** (SQL-injekció,
cross-tenant), **export**, **agentenkénti hozzáférés** (friss authz), **dinamikus DDL** (tenant-séma). A visszatérő
🟡 DNS-rebinding TOCTOU residualt (carry-forward 10-20…10-28) **tudatosan megint nem** választottam (felügyelet
nélkül a fetch-szintű IP-pin blast-radiusa kiesés-kockázat; a #984 nem érint egressz). Minden trace `origin/main`
HEAD-ről, külön worktree-ben (`eaap-wh`, linkelt `node_modules`), a main `.env` érintése nélkül.

### Coverage (teljes import + lekérdezés adatfolyam)
`sql.ts` (azonosító-kapu `qi`/`qs`/`qt`, séma = `warehouseSchemaName(tenantId)` **szerveroldali**, readOnly tx +
statement_timeout), `query.ts` (strukturált lekérdezés-fordító: mezők/szűrők/aggregátum/rendezés a katalógus ellen,
értékek paraméterként, 1 join-ugrás, LIKE-escape), `warehouse-service.ts` (schemaFor, query/export/commit/rollback,
preview↔commit hash-kötés, advisory-lock), `mcp.ts` (9 `warehouse.*` eszköz; tenant a principalból, agent-kapu
off/read/write), `permissions.ts` (szerep-min), `plan.ts` (`.strict()` terv, `FIELD_NAME` betűvel kezdődik → `_`
belső oszlopok nem árnyékolhatók), `store.ts` (DDL + insert/update, minden azonosító `qi`/`qt`, értékek param),
`excel-reader.ts` (`assertSafeOfficeArchive` a kitömörítés előtt, sor/oszlop/lap-plafon), `office-archive-guard.ts`
(64 MB tömörítetlen plafon). A kötelező scoped security scan (Claude Security `scan-changes`) ütemezett
munkamenetben továbbra sem futtatható (3. lépés wake-up nyugtázás) → kézi adversariális end-to-end trace.

### Biztonsági megállapítás — a lekérdezés/DDL/authz felület HELYTÁLL (0 finding)
- **SQL-injekció:** minden séma/tábla/oszlop `qi`/`qs`/`qt` regex-kapun megy (`IDENT`, `wh_[0-9a-f]{32}`), minden
  érték `$n`-paraméter; a lekérdezés-fordító csak katalógusban létező mezőt old fel. A `rollback` jsonb-kulcs
  interpoláció (`h.before->>'<név>'`) a katalógus-oszlopnevekre megy, amik `qi`-gatelt létrehozásúak → idézőjel
  kizárva. **Nem reprodukálható.**
- **Cross-tenant:** a séma kizárólag a szerveroldali `actor.tenantId`-ből (`schemaFor` + `warehouseSchemaName`), a
  tool-argumentumból SOHA (AC8); az MCP-séma `passthrough`, de a szolgáltatás csak a principalt használja.
- **AI-terv:** `.strict()` + `FIELD_NAME`/`DATASET_KEY` regex → a fájlba rejtett „utasítás" legfeljebb szöveg; a
  DDL-t a szerkezetkezelő generálja, nem a terv (AC13). CSV-export képlet-injekció ellen idézőjel-prefix.

### Bizonyított finding (🟠 magas, megbízhatóság / szolgáltatáskiesés) — JAVÍTVA (PR #997)
- **Az `applyMerges` megkerülte a `WAREHOUSE_MAX_ROWS` korlátot és korlátlan memóriát allokálhatott.** A
  `readWorkbookGrid` a nyers sorokra betartja a plafont, de az utána futó `applyMerges` a `<mergeCell>`
  tartományokból **korlátlanul** hozott létre új sorokat. A csomagolt XLSX a merge-listát kompaktan tárolja
  (pár száz bájt), a `merges` 5000-es plafonjával tartományonként max. 1000 sor × 200 oszlop → **~5 000 000 sor /
  ~1e9 cella** a JS-ben, a **64 MB archívum-kapu alatt** (a merge-XML pici) → **heap-OOM a közös, több-bérlős
  processzben** (egy import kiütheti a Cloud Run workert — l. [[healthcheck-cloud-run-oom-concurrency]]). Belépés:
  `warehouse.prepare_import` (operator / `write` agent). **Bizonyíték:** a pre-fix algoritmus 300 merge-dzsel már
  **300 000 sort** (3× plafon) hoz létre; 5000-re extrapolálva ~5M.

### Javítás (PR #997, 2 commit)
- `applyMerges`: a plafonon túl **nem** fabrikál új sort (meglévő sorokat a korlátig kitölt), a kitöltött cellák
  számát **munkafüzet-szintű megosztott** költségvetés (`WAREHOUSE_MAX_MERGE_FILL_CELLS = MAX_ROWS × MAX_COLUMNS`)
  korlátozza; a levágást `truncatedRows` jelzi. Valós (fejléc-) merge érintetlen.
- A megosztott költségvetést a `readWorkbookGrid` egyetlen `mergeFillBudget`-ként adja át minden laphoz → 50 lap
  plafonja nem adódik össze (a review által feltárt lapokon-átívelő rés).

### Ellenőrzések
- **Regresszió** (`scripts/warehouse.test.ts`, `npm run test:warehouse` — CI): **AC12b** 5000 rosszindulatú merge →
  ≤ `WAREHOUSE_MAX_ROWS`, `truncatedRows`, <10 s; **AC12c** valós összevont fejléc változatlanul terjeszti a master
  értéket; **AC12d** két rosszindulatú lap egy megosztott költségvetésen → 1. kimeríti (budget=0), 2. 0 új cellát
  szintetizál.
- **`tsc --noEmit`:** tiszta az érintett fájlokra (a globális `TS2688` a linkelt `node_modules` artefaktum).
- **`test:warehouse` lokálisan nem futott**: hiányzó `@fast-csv/format` függőség (fixture→exceljs) → **CI**-ban fut;
  az `applyMerges` logikát izolált szkripttel igazoltam (mindhárom eset zöld, OOM-input 248 ms).
- **Független `/code-review` (Standards + Spec, párhuzamos):** Standards **0 dokumentált szabálysértés**; Spec tárta
  fel a **laponkénti vs. munkafüzet-szintű** költségvetés-rést → javítva (`5a8e32fd`) + AC12d. A `truncatedColumns`
  félrecímkézést (mindkét axis) `truncatedRows`-ra javítottam.

### Residual risk / következő audithoz
- **ℹ️ Valós sor-szám a readeren át `WAREHOUSE_MAX_ROWS + 50`** (a reader szándékos ráhagyása a levágás
  detektálásához) — a memória-korlát tartja, csak a számérték +50; a JSDoc most pontos. Nem biztonsági rés.
- **ℹ️ Per-merge `start.row + 1000` függőleges span-vágás csendes** (nem állít `truncated`-ot) — pre-existing, nem
  e diff vezette be; >1000 soros valós merge veszthet kitöltést figyelmeztetés nélkül. Külön, alacsony prioritású kör.
- **Warehouse még nem auditált felületei:** `transform.ts` (link-egyezés, `loadLinkTargets` LIMIT 500000 — memória?),
  `profiler.ts` (magyar formátum-heurisztika), `warehouse-registry.ts` + 0038 migráció (séma-provisioning jogok),
  export-route (`/api/control-plane/warehouse/export/[dataset]` — audience/jogosultság), `value-parse.ts`.
- **🟡 Egress DNS-rebinding by-name TOCTOU** (platform-szintű, MEGERŐSÍTVE — carry-forward 10-20…10-29): változatlanul
  nyitva; **EMBERI FELÜGYELETTEL** futtatandó dedikált kör jelöltje.

---

## 2026-10-28 — Feladatátadás (handoff) idempotencia (#940 maradék → PR #989): a kötelező `idempotencyKey` érvényesítése a létrehozási úton

**Scope-választás (kockázati alapon):** `git fetch` után `origin/main` `64b656ca`-n állt; a 10-27-i kör
bázisa (`898c0377`) óta **egyetlen** új merge: **#983** (mini-app iframe-előnézet, `9ea93860`). A #983
biztonság-releváns (eltávolítja a beágyazó külső iframe `sandbox` attribútumát a Control Plane / agent-panel /
MCP-néző kereteiről), ezért előbb azt trace-eltem: a **helytáll**. Az agent-tartalom izolációját változatlanul
a *belső* tartalom-iframe `sandbox="allow-scripts"` (opaque origin, `allow-same-origin` nélkül) **+** a
`content/[token]` válasz CSP `sandbox allow-scripts` adja; a keretoldalon nincs agent-JS, így a külső sandbox
elhagyása az izolációt nem gyengíti (a 10-25-i #967-kör már a teljes felületet lefedte, 0 finding). A `frame-src`
most host-source (`miniAppFrameCsp(miniAppOrigin())`), ami helyes, mert opaque beágyazónál a `'self'` blokkolna.
→ #983: **nincs finding**. Finding kényszerítése helyett a legmagasabb, még nem auditált **megbízhatósági**
kockázatra váltottam, amit a **#940 saját záró jegyzete** (`code_review.md`, 2026-10-22) nyitott maradékként
nevesített. A visszatérő 🟡 DNS-rebinding TOCTOU residualt (carry-forward 10-20…10-27) **tudatosan megint nem**
választottam (fetch-szintű IP-pin, blast-radius = minden kimenő connector → felügyelet nélkül kiesés-kockázat).
Minden trace `origin/main` HEAD-ről; a fix külön worktree-ben (`eaap-940-idem`, linkelt `node_modules`), a main
`.env` érintése nélkül.

### Coverage (teljes adatfolyam a `platform.handoff` létrehozási úton)
`domain/project-work/mcp.ts` (`handoffInputSchema` — a `idempotencyKey` **kötelező**: `z.string().min(1).max(200)`;
`invokeHandoff` teljes út: cél-feloldás, authz, `insert`, memória-injektálás, audit), `domain/handoff/handoff-service.ts`
(`HandoffStore` interfész), `repositories/postgres/handoff-repository.ts` (`insert`/`decide`), `domain/mini-app/mcp.ts`
(a megosztás→handoff második hívó), `app/actions/handoff.ts` (csak **döntés**, nem létrehozás — a létrehozás egyetlen
belépési pontja az MCP `invokeHandoff`). A #940 (merge `122f6535`) a `decide`-ot már atomivá tette
(`updateManyAndReturn where status in (open,accepted)`), de a **létrehozást** nem.

### Bizonyított finding (🟠 magas, megbízhatóság / hibás üzleti működés) — JAVÍTVA
- **A `platform.handoff` kötelező `idempotencyKey`-jét a létrehozási út figyelmen kívül hagyta.** `invokeHandoff`
  a `parsed.idempotencyKey`-t sehol nem olvasta, és feltétel nélkül `deps.handoffs.insert(...)`-elt. Egy
  **megismételt (retry)** vagy **párhuzamos**, azonos kulcsú hívás → **duplikált átadás-sor** + (ha a hívó
  operálhatja a címzettet) **duplikált `open_task`** a címzett agent memóriájába + **duplikált `handoff.created`**
  audit. Üzleti hatás: flaky kapcsolatnál (pont amiért az idempotencyKey létezik; l. a 10-01-i „5xx retry-duplikátum"
  kör) ugyanaz a feladat 2-3×, a címzett többször végzi el, az audit több „sikeres" átadást mutat. A kulcs
  advertizált és kötelező, a célja a dedup — csendben eldobva **hamis idempotencia-garancia**.

### Javítás (a mini-app létrehozás már auditált idempotencia-mintáját követve, PR #989)
- **0038 migráció:** `handoffs.idempotency_key` (nullable) + parciális unique index
  `(tenant_id, from_agent_id, idempotency_key)`. A NULL-kulcsú utak (mini-app-megosztás) a Postgres
  NULL-distinctness miatt nem ütköznek → korlátlanok maradnak. Index-név a Prisma-generátorral azonos
  (`handoffs_tenant_id_from_agent_id_idempotency_key_key`, 52<63) → **nincs migráció-drift** (a visszatérő
  prod-incidens kockázata kizárva; a Standards-review igazolta).
- **Repository `insert`:** idempotens — ütközéskor (P2002) a meglévő átadást adja vissza; `{ handoff, created }`.
  A dedup-határ maga a DB unique index (nem read-then-write), ezért **race-safe** (a Spec-review igazolta).
- **`invokeHandoff`:** `created:false` esetén nem injektál memóriát és nem ír `handoff.created` auditot (csak a
  generikus `auditOk`-ot); a választ `idempotent: true` jelzi. A mini-app hívó `{ handoff }`-ra igazítva.

### Ellenőrzések
- **Tesztek (regresszió):** `handoff.test.ts` — gyors, DB nélkül: ismételt hívás azonos kulccsal → **1 átadás,
  1 memória-sor**, a második `idempotent:true`. `handoff-repository.test.ts` — valós Postgres (**CI** `test:handoff-repository`
  job): ismételt **és 3-utas párhuzamos** azonos kulcsú létrehozás → **1 sor**; eltérő kulcs → külön sor.
- **`tsc --noEmit`:** az összes érintett fájlra **tiszta** (a 10 globális `TS2688` a linkelt `node_modules`
  @types-feloldási műterméke, nem a diff). **esbuild/eslint** a linkelt `node_modules` platform-/modul-hibája miatt
  ebben a munkamenetben nem futtatható (precedens: 10-25) → a lint/tesztek a CI-ban futnak.
- **Független `/code-review` (Matt Pocock, Standards + Spec, párhuzamos):** Standards **tiszta** (0 kemény
  szabálysértés; 2 nem-blokkoló judgement call: elérhetetlen `: null` ág, `isUniqueViolation` repón belüli
  ismétlés — pre-existing). Spec: **mind az 5 elvárt viselkedés teljesül, race-safe**; 2 alacsony súlyú maradék
  (lent). A nem-atomitást a `cfd6219f` kommenttel explicitté tettem a kódban is.

### Residual risk / következő audithoz
- **ℹ️ Handoff létrehozás+injektálás+audit nem egyetlen tranzakció (#940 eleve nyitott maradéka):** ha egy hívás
  a sor-létrehozás után, az injektálás előtt elhal, a retry (`!created`) nem injektál újra — de a **hiteles
  kézbesítés maga az átadás-sor** (briefing/inbox), a memória-injektálás csak kényelmi réteg, így **átadás nem
  vész el**. Teljes atomitás = külön, **felügyelt** kör (a hármast egy tranzakcióba vonni). Párhuzamos replaynél a
  válasz `memoryId`/`notified` tájékoztató mezői elavultak lehetnek; **duplikált injektálás nem történik**.
- **🟡 Egress DNS-rebinding by-name TOCTOU (platform-szintű, MEGERŐSÍTVE — carry-forward 10-20…10-27):**
  változatlanul nyitva; a legmagasabb prioritású, **EMBERI FELÜGYELETTEL** futtatandó dedikált kör jelöltje.
- **ℹ️ `platform.handoff` létrehozás ≠ Control Plane / natív chat / ticket:** a létrehozás ma csak MCP-n keresztül
  megy (`invokeHandoff`); ha később UI-/ticket-út is kap létrehozást, arra is kell idempotencia-/dedup-kapu.
- **Következő audit további jelöltjei (még nem auditált, magas kockázat):** #983 mini-app sandbox-delta (most
  trace-elve, 0 finding — lezárható), #964 skill-platform-share (cross-tenant), #937 connector-template-endpoint-
  scope (SSRF-fix teljessége), #841 IAM token-redeem eszkaláció-fix.



**Scope-választás (kockázati alapon):** `git fetch` után `origin/main` `898c0377`-re állt (a 10-26-i kör
bázisa `b4df87b9` volt). Azóta **két új, nem auditált** merge: #975 (fix: „Adj neki ticketet" gomb törlése
a varázslóból — triviális UI) és **#980 Wiki-előzmények** (`898c0377`, +5439 sor, 40 fájl). Egyértelműen
a **#980** a legmagasabb kockázat: a 10-23-i (#942 wiki-alapok) és 10-25-i (#943/#946 wiki-író út) körök
kötelező következő ellenőrzésként jelölték, hogy *amint a wiki perzisztens verzió-történetet, időutazást
és GDPR-törlést kap, a privát-KB tartalom/oldalcím szivároghat az előzmény-/log-/audit-felületeken*. A
#980 ezt élesítette: teljesen új **verzió-történet** (`wiki_page_revisions` bővítés + `wiki_tags` +
`wiki_erasures` + `wiki_read_cursors`, 0037 migráció), **visszaállítás** (konzol-azonnali + agent-
jóváhagyásos), **időutazás** (`asOf` olvasás change-számra/dátumra — **agent-elérhető** `kb_get_page`-en),
**megőrzés-sweep** (napi ritkítás/törlés) és **auditált GDPR-törlés** (oldal / verzió / kifejezés-kitakarás,
minden másolaton: revízió, change-set, napló, nyers forrás, index-chunk, függő gateway-kártya). A GDPR-
törlés + verzió-történet a klasszikus helye a *resurrection* (törölt tartalom visszaállítása), a privát-KB
*cross-user/-tenant olvasás* és a *takarító-adatvesztés* hibáknak → legmagasabb unknown-unknown kockázat.
A visszatérő 🟡 DNS-rebinding TOCTOU residualt **tudatosan megint nem** választottam (felügyelet nélküli
futásban a fetch-szintű IP-pin blast-radiusa szolgáltatáskiesés-kockázat — l. carry-forward; a #980-at nem
érinti, nincs egress). Minden trace `origin/main` HEAD-ről, a main `.env` érintése nélkül.

### Coverage (teljes bizalmi-határ + adatfolyam-trace a LIVE felületen)
`wiki-history-service.ts` (idővonal/verzió/diff, `listChanges`/`getChangeSet`, `previewRevert`/`revert`,
`getStateAt`/`getPageAt` időutazás, címkék, `getRetention`/`updateRetention`/`sweepRetention`,
`previewErasure`/`executeErasure`/`planErasure`, `deepRedact`/`stripPagesJson`/`replacePaths`),
`wiki-history-repository.ts` (`stateAt` raw-SQL, `sweepRetention` advisory-lock + védett-CTE,
`findTextMatches`, `executeErasure` tranzakció), `wiki-service.ts` (`planRevert`/`revertAsHuman`/
`requestRevert`, `resolveAsOf`, `readPageAsOf`, `restoreTarget`), `wiki-console-service.ts` `authorize`/
`accessFor` (a megosztott kapu — privátnál admin is `not_found`), `actions/knowledge-wiki.ts` (18 server
action, session-aktor), `handlers/knowledge-base.ts` + `tool-definitions.ts` (MCP-kitettség: `kb_wiki_changes`,
`kb_wiki_revert`, `kb_get_page asOf`), `ai-audit-retention/route.ts` (sweep cron-wiring), 0037 migráció
(oszlopok + indexek + backfill). A kötelező scoped security scan (Claude Security `scan-changes`)
**ütemezett munkamenetben továbbra sem futtatható** (3. lépés költség-megerősítése nem fogad el wake-up
nyugtázást) — a mélyaudit kézi end-to-end adversariális trace + a szerzői AC1–AC10 DB-tesztsuite átnézése.

### Biztonsági megállapítás — NINCS bizonyított finding; a felület helytáll (origin/main)
Tételesen, adversariális trace-szel verifikálva:
- **Tenant/privát-KB/szerep-izoláció (minden olvasó + író úton).** Minden konzol-út a
  `WikiConsoleService.authorize`-on megy: `connectors.findById(id, tenantId)` **+** explicit
  `connector.tenantId !== actor.tenantId → not_found` (kettős ellenőrzés, cross-tenant kizárva), `type`-
  kapu. Privát KB: csak `ownerUserId === userId` kap view/contribute/manage; a nem-tulajdonos admin csak
  `metaOnly` → `access.view=false` → **`not_found`** (az előzmény/időutazás/GDPR is, D13). Megosztott KB:
  view/contribute = operator, manage = admin. A `getRetention`/`updateRetention`/`previewErasure`/
  `executeErasure` `manage`-kapuzott (megosztott=admin, privát=tulaj). AC10 ezt DB-n igazolja.
- **Aktor nem hamisítható.** Minden server action `requireTenantRole('viewer')`-ből veszi az
  `userId/tenantId/role`-t (session), sosem kliens-argumentumból; Zod-validáció az inputon.
- **GDPR non-resurrection (a headline-garancia).** (a) **Időutazás**: `getPageAt`/`getStateAt`/`readPageAsOf`
  a tombstone-olt revízió tartalmát üresre cseréli (`erasedAt ? '' : body`), és a fizikai sor amúgy is
  ki van ürítve (`executeErasure` title/summary/body='' , sourceRefs=DbNull). (b) **Visszaállítás**:
  `planRevert` **mind a cél-**, **mind az előző revízió** `erasedAt`-jére `version_erased`/`conflict`-ot ad
  — törölt verzióra nem lehet visszaállni; a `restoreTarget` kizárólag a (kiürített) revízió-sorból épít,
  sosem a change-set JSON-ból. A „GDPR oldal-mód" teszt a revert→`version_erased`-et expliciten állítja.
- **GDPR-törlés teljessége.** `planErasure`+`findTextMatches` minden másolatot felsorol: aktuális oldal
  (új, redaktált verzió szintetikus change-settel), régi revíziók (tombstone vagy redakció), change-set
  `pages`/`pageSummary`/`logEntry`/`validation`, napló-sorok, nyers `documents`+`document_source_files`
  (az eredeti fájl törlődik), `knowledge_chunks` (regexp-redakció), **nyitott gateway-kártyák** (args-
  redakció + reject). AC9 DB-n UNION-lekérdezéssel igazolja: a név **sehol** nem marad (page/revision/
  changeSet/log/chunk/document/gateway) **és az auditban sem** (`redactKbAuditForVisibility` + csak
  `matchHash`/`erasedHashes` kerül a metaadatba, a kifejezés sosem). `confirmName` + `reason` kapu.
- **Megőrzés-sweep adatvédelem.** `sweepRetention` védett-CTE: aktuális verzió, oldalanként a legutóbbi
  `keepLatest=5`, **címkézett** állapotok, **függő change-set baseVersion-je** (content_hash), és a
  **sír-jelek** (`erased_at`) sosem törlődnek; napi ritkítás 1-et tart/nap, a `deleteBefore` utáni teljes
  törlés `keepLatest`/aktuális/címke-védett. AC8 ezt DB-n igazolja.

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding
- **Race-safe sorszám + izoláció.** `executeErasure`, `applyChangeSet` és `sweepRetention` **ugyanazon**
  `pg_advisory_xact_lock(hashtext(connectorId))` alatt fut, a `seq` atomi `UPDATE agent_wikis SET
  next_seq=next_seq+1 … RETURNING next_seq-1` — párhuzamos írás+törlés közt nincs dupla sorszám (AC7 6-utas
  párhuzammal igazolja). A `resolve`-szerű CAS a page-updatere `updateMany where version=expectedVersion →
  count 0 → ErasureAborted` (konfliktus esetén a tranzakció tiszta visszagörgetés).
- **Időutazás-bound.** `resolveAsOf` a seq-et `[0, latest]`-re clampeli; dátum a nap végére (UTC) oldódik.
- **Olvasók nem szivárogtatnak törölt tartalmat.** `diffRevisions`/`getChangeSet` a fizikailag kiürített
  revízió-sorból dolgozik (a `getChangeSet` külön `erasedAt`-kapuval is), a `getRevision` `erasedAt ? ''`-t ad.
- **`findTextMatches` raw-SQL** paraméterezett (`position(${needle} in lower(col))`), nincs injekció; a
  precedencia helyes (az OR-lánc zárójelezett). NULL-oszlopon a `position` NULL → nem illeszkedik, nem hibázik.
- **Migráció.** 0037 additív (nullable/default oszlopok), indexek a forró utakra (`wiki_change_sets(wiki_id,
  seq)` unique, `wiki_page_revisions(page_id, created_at)` + `(change_set_id)`); backfill egyszeri.

### Bizonyított finding — NINCS. Kódmódosítás nem indokolt.
A felület fail-closed, tenant/privát-KB/szerep-gated, GDPR-resurrection-mentes (idő-utazás üres + revert
`version_erased`), race-sorosított, és a szerzői AC1–AC10 DB-suite (plusz D8 / „GDPR oldal-mód" / privát-
audit-tartalommentesség) átfogóan fedi. Ide kockázat-csökkentő indok nélkül nyúlni **kockázatot adna**.
Nincs fix-PR és nincs `/code-review` (az a *létrehozott változtatásra* való). Nettó kód-változás: **0**.
(Precedens: 10-21, 10-23, 10-25, 10-26.) A ledger-bejegyzés a `fix/drive-search-free-text-query` munka-ág
working-tree-jében gyűlik a korábbi (10-17…10-26) bejegyzésekkel együtt, commit nélkül — a batch-elt
`docs(audit):` commit a user döntése.

### Vizsgált, de elvetett (nem finding) megfigyelések
- **`getPageAt`/`readPageAsOf` nem szűri a `pending_approval` státuszt** (szemben a `getStateAt`-tel és az
  indexszel). **Nem elérhető**: revízió-sor sosem kap `pending_approval` státuszt (revízió csak *alkalmazott*
  change-setből vagy `executeErasure`-ből jön → `published`/`archived`); a `getStateAt`-beli szűrő tisztán
  defenzív. Azonos connector/tenant, amelyre a hívónak amúgy is `view`-ja van → nincs határ-átlépés.
- **GDPR-törlés nem érinti a meglévő audit-sorokat** (megosztott KB auditjába korábban bekerülhetett
  tartalom). A #980 erasure-je az **új** audit-sort redaktálja; a *régi* audit-tartalom kitakarása platform-
  szintű, külön kérdés (privát KB-nál `redactKbAuditForVisibility` már eddig is tartalommentes). Nem #980-
  finding; a következő körök audit-retenció témájába illik.

### Ellenőrzések
- Statikus end-to-end adversariális trace a teljes bizalmi-határon (fent tételesen), a szerzői AC1–AC10
  DB-tesztsuite (`app/scripts/wiki-history-db.test.ts`, 524 sor) átnézésével — a GDPR-leak (AC9), a privát-
  KB admin-izoláció (AC10), a párhuzamos sorszám (AC7), a megőrzés-védelem (AC8) és a revert-konfliktus (AC3/
  D8) mind lefedve. A DB-tesztek valódi Postgrest igényelnek (CI migrations job) — ütemezett, felügyelet
  nélküli futásban **nem futtattam** (prod `directUrl` védelme, Neon-pool; nincs eldobható branch-provision).
- Kódmódosítás nem történt → nincs külön build/tsc/eslint ezen körben.

### Residual risk / következő audithoz
- **🟡 Egress DNS-rebinding by-name TOCTOU (platform-szintű, MEGERŐSÍTVE — carry-forward 10-20…10-26):**
  változatlanul nyitva; a legmagasabb prioritású, **EMBERI FELÜGYELETTEL** futtatandó dedikált kör jelöltje
  (fetch-szintű IP-pin, blast-radius = minden kimenő connector). A wiki-előzményeket nem érinti.
- **ℹ️ GDPR-törlés ↔ beágyazás/embeddings (nem finding):** a `knowledge_chunks.text`/`title` regexp-
  redaktált, de ha a KB vektor-beágyazásokat is tárol, azok derivált reprezentációként a kitakarás után is
  kódolhatják a törölt szöveget. GDPR-értelmezési kérdés (derivált adat); ha szükséges, a chunk-redakció
  mellé re-embedding az upgrade-út. Külön kör / terméki döntés.
- **ℹ️ Régi audit-sorok GDPR-kitakarása (nem finding, platform-szintű):** l. fent; a napi audit-retenció és
  a wiki-erasure összehangolása jövőbeli téma.
- **Következő audit további jelöltjei (10-27-ig merge-elt, még nem auditált, magas kockázat):** #964 skill-
  platform-share (superadmin platform/cross-tenant skill-megosztás — tenant-határ), #937 connector-template-
  endpoint-scope (SSRF/scope review-fix *teljessége*), #940 handoff-atomitás, #967 Mini-App MCP CSP/share-
  idempotencia *residual* (10-25 óta nyitva), valamint a 10-26 óta nyitott #973/#974 metaadat-utak.

## 2026-10-26 — Customer-Promise ledger (#936/#672, merge `435d84c7`): új agent-írható MCP perzisztencia + állapotgép

**Scope-választás (kockázati alapon):** `git fetch` után a checkout (`fix/drive-search-free-text-query`
@`60a1227b`) el volt maradva `origin/main` (@`b4df87b9`) mögött. A 10-25-i kör (HEAD `30de09ed`) óta
**négy még nem auditált PR** merge-elt: #974 (mcp-tool-errors-actionable, error-polish), #936 (promise-
ledger / #672), #937 (connector-template-endpoint-scope — *már review-branch*), #973 (skill-triggers-
versions-placement, metaadat+migráció). A legnagyobb **új, agent-írható, külső-adatot hordozó**
felület egyértelműen a **#936 Customer-Promise ledger** (+1007 sor, 32 fájl): egy teljesen új
perzisztencia-tábla (`customer_promises`, 0036) + **állapotgép** (`open/claimed → fulfilled/cancelled/
missed`), amelyet **öt új MCP-eszköz** ad az agenteknek (`platform.promise.register/get/list/complete/
cancel`), ügyfél-PII-t (név/e-mail/ref) tárolva. Új agent-írható állapotgépek a klasszikus helye a
cross-tenant szivárgásnak, az átmenet-authz hibáknak és a race conditionöknek → a legmagasabb
unknown-unknown kockázat. (#937 már biztonsági review-fix; #974/#973 kisebb/metaadat.) A visszatérő
🟡 DNS-rebinding TOCTOU residualt **tudatosan megint nem** választottam fő scope-nak (felügyelet
nélküli futásban a fetch-szintű IP-pin blast-radiusa szolgáltatáskiesés-kockázat — l. carry-forward).
**Minden trace `origin/main` HEAD-ről**, a main `.env` érintése nélkül; a stub-teszteket eldobható
worktree-n futtattam (DB-mentes, prod `directUrl` érintetlen).

### Coverage (teljes bizalmi-határ + adatfolyam-trace a LIVE felületen)
`customer-promise-service.ts` (register-validáció, `get`/`list`/`resolve`/`countUrgentForUser`, PII-mentes
`record` audit-helper), `customer-promise/mcp.ts` (séma + `invokeCustomerPromise` aktor-levezetés +
owner/agent-kapu), `customer-promise-repository.ts` (`insertUnderLimit` `FOR UPDATE`-sorosítás + 50-limit,
CAS-`resolve`, tenant-scoped `findById`/`list`), 0036 migráció (FK + indexek), `mcp-server.ts` (tool-
regisztráció, `bindAgentHeader` definitionId-injektálás, `get_definition` briefing-integráció),
`project-work/mcp.ts` `authorizeProjectWorkCall` (a megosztott gate: tenant-scoped `loadDefinition` +
`findAgentGrant` + `canOperateAgent`/`canReadPublishedAgent` + pin-check), `actions/customer-promise.ts`
(UI server action, `allowTenantScope` approver-kapu), `gateway-services.ts` wiring. A kötelező scoped
security scan (Claude Security `scan-changes`) **ütemezett munkamenetben továbbra sem futtatható**
(3. lépés költség-megerősítése nem fogad el wake-up nyugtázást) — a mélyaudit kézi end-to-end
adversariális trace + a szerzői tesztsuite futtatása `origin/main`-en.

### Biztonsági megállapítás — NINCS bizonyított finding; a felület helytáll (origin/main)
Tételesen, adversariális trace-szel verifikálva:
- **Tenant/owner/agent izoláció.** Minden repo-metódus `tenantId`-scoped (`findById`/`list`/`resolve`
  `where {tenantId,…}`). Az MCP-aktor **teljesen szerver-oldali**: `ownerUserId = principal.userId`,
  `agentId = definition.agentId` (sosem args). `get`/`complete`/`cancel`: `svc.get` megköveteli
  `row.ownerUserId === principal.userId`-t (`manageAll` undefined MCP-n), majd `row.agentId !==
  definition.agentId → not_found`. → agent csak **a saját tulajdonú**, **ugyanazon agenten** lévő
  promise-ot éri el. Hamisított `promiseId` más owner/agent/tenant alól `not_found`/`not_allowed`.
- **Grant-kapu (gate).** `authorizeProjectWorkCall`: `definitionId` a hívó **tenantjára** feloldva;
  `findAgentGrant` + `canOperateAgent` (register/get/complete/cancel) / `canReadPublishedAgent` (list).
  A HTTP-teszt igazolja: `view`-grant → list OK, de register/get/complete/cancel → `agent_access_denied`;
  **nincs grant** → list is `agent_access_denied`; stale definition-pin → `agent_stale`.
- **Bound-kliens binding.** `bindAgentHeader` a `definitionId`-t a bound agentből injektálja (vagy a
  megadottat a bound agenthez validálja), `canViewAgent`-kapuval; a gate utána **újra** `findAgentGrant`-et
  ellenőriz → a header-kötés nem kerüli meg a grant-ellenőrzést.
- **Audit PII-redakció.** A `record` **csak** `id/agentId/dueAt/status`-t ír a `metadata`-ba; a
  cím/commitment/customerName/customerEmail/resolvedNote **nem** kerül auditba (a tág admin/superadmin-
  olvasható naplóba). A szerzői stub-teszt explicit assert-eli, hogy `private@example.com`/`Call private
  customer`/`Done` **sosem** jelenik meg az audit-sorban. A PII a tenant-scoped táblában marad (CRM-szerű).
- **UI eszkaláció-kapu.** `listCustomerPromisesAction`/`resolveCustomerPromiseAction`: az `allowTenantScope`
  (= tenant-wide hozzáférés más user promise-aihoz) **`hasMinimumRole(…, 'approver')`-hez kötött**, és a
  resolve szerver-oldalon újra kikényszeríti (a UI `canResolve` csak megjelenítés).

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding
- **Race-safe átmenet (CAS).** `resolve` `updateMany where {id,tenantId, status in [open,claimed]}` →
  `count 0` esetén `already_resolved` (két párhuzamos complete közül egy nyer; nincs dupla). Tranzakcióban.
- **Limit-sorosítás.** `insertUnderLimit` `SELECT … FROM agents … FOR UPDATE` alatt számol+szúr be →
  a per-agent 50 aktív-limit párhuzamos ownerök közt sem kerülhető meg. A lejárt (`dueAt < now`) nyitott
  sorok **szándékosan nem** foglalnak helyet (semmit nem zár le automatikusan) — bounded + dokumentált.
- **Validáció.** `dueAt` ISO+offset, `now < dueAt <= now+366 nap`; `timezone` valós `Intl`-zóna; e-mail-
  regex; hossz-plafonok. Az MCP-séma szigorúbb (`channel` enum) — konzisztens. `missed` enum létezik, de
  semmi nem állítja (dead, nem rés). Pagination a service-ben `limit ≤ 51`-re clampelve (hasMore-detektálás).
- **Briefing-rezíliencia.** `get_definition` promise-lekérdezése `.catch(() => [])` — egy hiányzó tábla /
  lekérdezés-hiba **nem** töri el a briefinget (HTTP-teszttel igazolva: `relation … does not exist` →
  üres lista, nem error).

### Bizonyított finding — NINCS. Kódmódosítás nem indokolt.
Fail-closed, tenant/owner/agent-gated, CAS-biztos, PII-redaktált auditú, átfogóan tesztelt felületbe
kockázat-csökkentő indok nélkül nyúlni **kockázatot adna**. Nincs fix-PR és nincs `/code-review` (az a
*létrehozott változtatásra* való). Nettó kód-változás: **0**. (Precedens: 10-21, 10-23, 10-25.)

### Ellenőrzések
- `scripts/customer-promise.test.ts` (eldobható `origin/main` worktree, linkelt `node_modules`, **DB nélkül**)
  — **zöld**: validáció, tenant/owner-izoláció, 50-limit + overdue-mentesség, lifecycle/`already_resolved`,
  overdue-flag, urgent-badge, pagination, PII-mentes audit.
- `scripts/mcp-http.test.ts` — **zöld**; a „promise HTTP tools enforce grants, ownership, tenant and
  argument boundaries" eset a gate-et HTTP-szinten fedi (view-vs-operate, no-grant, stale-pin, invalid-args,
  briefing-rezíliencia). A teljes mcp-http suite is zöld.
- Prod `directUrl`-t nem érintettem; a worktree-t a futtatás után eltávolítottam.

### Residual risk / következő audithoz
- **🟡 Egress DNS-rebinding by-name TOCTOU (platform-szintű, MEGERŐSÍTVE — carry-forward 10-20…10-25):**
  változatlanul nyitva; a legmagasabb prioritású, **EMBERI FELÜGYELETTEL** futtatandó dedikált kör
  jelöltje (fetch-szintű IP-pin, blast-radius = minden kimenő connector). A promise-ledgert nem érinti
  (nincs egress).
- **ℹ️ Promise-limit elhasználódás (nem finding):** a lejárt, le nem zárt promise-ok a `list active`-ban
  és a briefingben korlátlanul gyűlhetnek (`missed`-re semmi nem vált). Terméki/UX-kérdés, nem korrektségi
  hiba; egy jövőbeli auto-`missed`-sweep tisztítaná a briefinget. A limit-számlálót nem érinti.
- **ℹ️ Register nem-idempotens:** nincs idempotencyKey; egy retry két promise-sort hoz létre. Belső DB-sor
  (nem visszavonhatatlan külső hatás, szemben a 10-01 körrel) → nem finding; ha a duplikáció gond lesz,
  per-hívás efemer kulcs az upgrade-út.
- **Következő audit további jelöltjei (10-26-ig merge-elt, még nem auditált):** #937 connector-template-
  endpoint-scope (biztonsági review-fix **teljességét** igazolni — SSRF/scope), #973 skill-triggers-
  versions-placement (séma-migráció + skill-metaadat), #974 mcp-tool-errors-actionable (hibaüzenet-
  információszivárgás), valamint a 10-25 óta nyitott #964 skill-platform-share és #940 handoff-atomitás.

## 2026-10-25 — LLM Wiki író-út (#943/#946) + Mini-App MCP (#967, merge `f9d5df68`/`30de09ed`): az élesedő agent-író és app-kiszolgáló felületek

**Scope-választás (kockázati alapon):** `git fetch` után a checkout (`fix/drive-search-free-text-query`
@`60a1227b`) **28 commit / 9 merge** maradt el `origin/main` (@`30de09ed`) mögött. A 10-23-i kör
(#948 Wiki Foundation) óta merge-elt, **még nem auditált** munka: #943 (2/6 wiki-író MCP-eszközök),
#946 (5/6 Control Plane wiki-konzol), #947 (6/6 e2e), #967 (Mini-App MCP), #964 (skill-platform-share),
#940 (handoff-atomitás). Két felület emelkedik ki:

1. **LLM Wiki író-út (#943/#946)** — a 10-23-i ledger **kötelező következő ellenőrzésként** jelölte:
   „amint a wiki-írás (`kb_wiki_write` + change-set apply) élesedik, a privát-KB oldalcím/tartalom
   audit-ba/log-ba szivároghat, ha nem a `redactKbAuditForVisibility`-n megy át." A 2/6+5/6+6/6 pont ezt
   élesítette → konkrét, előre rögzített szivárgás-hipotézis élő kóddal.
2. **Mini-App MCP (#967, +3400 sor, 23 fájl)** — teljesen új felület: az agent **tetszőleges HTML-t**
   hoz létre, amit a platform **token-alapú publikus route-on** és iframe-ben szolgál ki, szervezeti/
   agent-megosztással. Stored-XSS (session-lopás) + cross-tenant láthatóság + publikus-route authz =
   a legnagyobb új, külső-felületű kockázat.

A visszatérő 🟡 DNS-rebinding TOCTOU residualt (carry-forward 10-20/10-21/10-23) **tudatosan megint nem
választottam fő scope-nak**: l. lent — megerősítettem a rés valódiságát, de a fetch-szintű IP-pin javítás
blast-radiusa (minden kimenő connector) felügyelet nélküli futásban szolgáltatáskiesés-kockázatot adna
(az audit kifejezetten kerülendőként sorolja). **Minden trace `origin/main` HEAD-ről** (stale-branch
tanulság), a main `.env` érintése nélkül.

### Coverage (teljes bizalmi-határ + adatfolyam-trace a LIVE felületeken)

**Wiki író-út:** `wiki-service.ts` (1292 sor: `write`/`plan`/`apply`/`applyApproved`/`canDecide`/
`approverScopeFor`/`audit`), `wiki-console-service.ts` (922 sor: `load`-kapu + mind a 18 konzol-metódus
authz-a), `knowledge-wiki.ts` server action (253 sor, vékony), `wiki-repository.ts` `applyChangeSet`
tranzakció, `kb-private-redaction.ts`. **Mini-App:** `mini-app-service.ts` (544: `readable`/`owned`/
`gate`/`create`/`update`/`share`/`unshare`/`recomputeVisibility`/`archive`/purge), `mcp.ts` (498:
aktor-levezetés + `checkShareTarget`), `link-token.ts` (HMAC), `frame.ts` (CSP/sandbox), `mini-app-serve.ts`
(route-feloldás + wrong-origin), `mini-app-origin.ts`, `human-access.ts`, a két publikus token-route
(`content/[token]`, `open/[token]`) és a `control-plane/.../download` route. A kötelező scoped security
scan (Claude Security `scan-changes`) **ütemezett munkamenetben továbbra sem futtatható** (3. lépés
költség-megerősítése nem fogad el wake-up nyugtázást) — a mélyaudit kézi end-to-end trace + a szerzői
regressziós tesztek viselkedés-fedezetének igazolása.

### Biztonsági megállapítás — NINCS bizonyított finding; mindkét felület helytáll (origin/main)

Tételesen, adversariális trace-szel verifikálva:
- **Wiki privát-KB audit-redakció (a 10-23 hipotézis — KEZELVE).** A `this.audit` helper **minden**
  wiki-lifecycle-sort (`inbox.submitted/claimed`, `changeset.submitted/approved/applied`, `page.*`)
  a `redactKbAuditForVisibility`-n vezet át; a külön `before/after` payload-os append (changeset.applied)
  is. A redakció **allowlist + rekurzív**: nested objektumba leszállva `title`/`summary`/`body`/`path`/
  `finalPath`/`sources` **kiesik** (nincs a `SAFE_STRING_KEY=/(id|ids|hash|hashes)$/`-ben, nem rövid enum),
  `status`/`action` enumként marad; a `pages:[{path,action}]` tömb objektumokkal → `undefined`. Privát
  KB-nál `inputRef/outputRef` csak UUID/hash. → az előre jelzett oldalcím/tartalom-szivárgás **nem áll fenn**.
- **Wiki change-set apply integritás.** `applyChangeSet` per-wiki `pg_advisory_xact_lock(hashtext(connectorId))`
  alatt sorosít; change-set egyszer-használat (`updateMany where status:'pending'` → count 0 abort);
  oldal-update **optimista verzió** (`where {id, connectorId, version: expectedVersion}` → count 0 =
  conflict, lost-update ellen); create ütközés a `connectorId_path` unique-ra fut (abort, nincs korrupció);
  minden verzió `wikiPageRevision`-be. A konténer-artifact idempotens (`findFirst ?? create`). Nincs
  részleges állapot.
- **Wiki konzol authz (cross-user privát).** Központi `load(need)`: privát KB-nál `accessFor` csak a
  **tulajdonosnak** ad `view/contribute/manage`-t; nem-tulajdonos admin max `metaOnly` → `load` **not_found**
  bármely `need`-re. Mind a 13 connector-művelet a `load`-on megy. `getChangeSetReview` (full diff/title/body)
  **csak** a change-set rögzített `approverScope`-ja szerint (`canDecide` → privátnál owner, admin sem).
  `purgePrivate` csak privátra + `manage`. A server action mindenki `requireTenantRole('viewer')` után a
  service dönt.
- **Mini-App tartalom-izoláció (stored-XSS ellen).** A `content/[token]` route a `sandbox allow-scripts`
  CSP-vel szolgál ki — **`allow-same-origin` NÉLKÜL** → a dokumentum **opaque originbe** kerül akkor is,
  ha `MINI_APP_ORIGIN` nincs beállítva (fejlesztés); így az agent JS a platform-cookie-t/`localStorage`-t
  nem éri el. Plusz `connect-src 'none'` (nincs exfil), `default-src 'none'`, `base-uri/form-action 'none'`.
  A keret-iframe maga is `sandbox="allow-scripts"`. A külön origin (D7) defense-in-depth, nem az egyetlen
  védelem.
- **Mini-App token / publikus route.** `link-token`: HMAC-SHA256, `timingSafeEqual`, 2048-hossz-plafon,
  fix struktúra-validáció, `exp` + `contentHash` pin (verzióhoz kötött). A route **cookie-t nem olvas**
  (szándékos: megosztható link), a hozzáférést az aláírt, lejáró token adja; archivált/inaktív app → 410.
  A `download` route **bejelentkezett** + `miniAppHumanAccess` + tenant-scoped `findById(tenantId,…)`,
  `attachment` + `sandbox` CSP.
- **Mini-App megosztás / tenant-izoláció.** `share` `owned()`-gated (csak tulajdonos); `activateShares`
  `{tenantId: actor.tenantId}`-scoped; a célpont-láthatóságot `checkShareTarget` a **hívó tenantjára**
  szűkítve dönti (`loadDefinitionByAgent({tenantId: principal.tenantId})` + `canViewAgent`). Egy idegen-tenant
  agentId-re tévesen aktivált share is **inert**, mert a `readable` tenant-kapuja (`app.tenantId ===
  actor.tenantId`) kizárja. Az MCP-aktor **teljesen szerver-oldali** (`principal` + authorizált `definition`),
  nem kliens-inputból.

### Bizonyított finding — NINCS. Kódmódosítás nem indokolt.
Két, fail-closed, következetesen tenant/owner-gated, élő regressziós tesztekkel fedett felületbe
kockázat-csökkentő indok nélkül nyúlni **kockázatot adna**. Nincs fix-PR és nincs `/code-review` (az a
*létrehozott változtatásra* való). Nettó kód-változás: **0**. (Precedens: 10-21, 10-23.)

### Ellenőrzések
- **Teszt-fedezet igazolása (a trace korroborálása):** a szerzői `scripts/mini-app.test.ts` pontosan a
  trace-elt viselkedést fedi: cross-tenant/nem-megosztott → `mini_app_not_found`; share→látható→unshare→
  rejtett; non-owner `update` → `mini_app_not_owner`; `canViewAgent:false` → `share_target_not_visible`;
  link-token aláírás/lejárat/forge; lint hard-fail (`iframe_tag`/`form_tag`). A wiki-oldalon
  `scripts/wiki-foundation.test.ts` + `wiki-console.test.ts` + `kb-wiki-e2e.test.ts` (782 sor) a
  láthatóságot/redakciót/apply-t fedi.
- A teszteket **nem futtattam** külön worktree + linkelt `node_modules` nélkül (prod `directUrl`-t
  szándékosan nem érintem); a viselkedést a kódon trace-eltem és a teszt-esetek állításaival vetettem össze.

### Residual risk / következő audithoz
- **🟡 Egress DNS-rebinding by-name TOCTOU (platform-szintű, MEGERŐSÍTVE — carry-forward 10-20/10-21/10-23):**
  `guardEgressUrl` (`domain/net/egress-guard.ts`) feloldja és a privát/reserved tartományok ellen
  ellenőrzi az IP-ket, majd **eldobja** és `{ok:true, host, url}`-t ad vissza; a hívó (`web_fetch`,
  MCP-connector `guardedMcpFetch`, sandbox-connection-tester) a **hostnévvel** csatlakozik → a connect-kori
  újra-feloldás és az ellenőrzés közt rebind-ablak. **Allowlist-kapuzott** (superadmin/tenant-admin által
  felvett hostok), de egy általad kontrollált, allowlistázott host DNS-ét ellenőrzés után `169.254.169.254`-re
  rebindelve a **GCP metadata** (SA-token) elérhető → eszkaláció. **Javítási terv (felügyelt kör):** a
  feloldott, validált publikus IP pinelése a kapcsolatba (`https.Agent`/undici `lookup` a pin-elt IP-vel,
  `servername`=eredeti host), redirect-láncon újra-ellenőrzés, IPv6/happy-eyeballs kezelés + integrációs
  teszt valós DNS/TLS ellen. **Nem kódoltam:** nagy blast-radius (minden kimenő connector), stub-teszttel
  nem igazolható, felügyelet nélkül szolgáltatáskiesés-kockázat. **A legmagasabb prioritású, dedikált,
  EMBERI FELÜGYELETTEL futtatandó kör jelöltje.**
- **ℹ️ Mini-App álnév-feloldás (§5.4) deferred, kódban `ponytail:`-lel jelölve:** a `content/[token]`
  route a HTML-t úgy adja ki, ahogy az agent beküldte — ha korábban tokenizált PII-t tartalmaz, az nyersen
  mehet ki a megosztott linken. Nem regresszió (nyitott feature), de a mini-app megosztás élesítése előtt
  tisztázandó a privacy-gateway interakció.
- **ℹ️ `MINI_APP_ORIGIN` élesítési követelmény:** a tartalom-izolációt a CSP `sandbox` (opaque origin)
  már a külön origin nélkül is megadja, de a külön origin a defense-in-depth réteg — élesben beállítandó
  (memóriában is jelölve).
- **🟡 Retenciós sweep hiba-izoláció (carry 10-23):** a `sweepOrphanedPrivateKnowledgeBases` per-connector
  try/catch nélkül; önhelyreállító, olcsó jövőbeli hardening.
- **Következő audit egyéb jelöltjei (10-25-ig merge-elt, még nem auditált):** #964 skill-platform-share
  (cross-tenant skill-megosztás authz), #940 handoff-atomitás (`make handoff decisions atomic` —
  race-condition-fix teljességét igazolni), #949 scanned-PDF KB-oldal (nagy-input / OCR feldolgozás),
  valamint a #841 IAM token-redeem eszkaláció-fix (10-23 óta nyitott jelölt).

## 2026-10-23 — LLM Wiki Foundation (#942 / PR #948, merge `89f3dc9b`): privát tudásbázis-láthatóság + wiki-jog + audit-redakció

**Scope-választás (kockázati alapon):** `git fetch` után a checkout (`fix/drive-search-free-text-query`
@`60a1227b`) **44 merge-dzsel** maradt el `origin/main` (@`89f3dc9b`) mögött. A 10-21-i kör óta
merge-elt, még **nem auditált** munka: #948 (LLM Wiki, 10-22), #927 (token-szinkron), #841 (IAM
token-redeem eszkaláció-fix), #625 (migrate-on-build). A legnagyobb **új, adat-hordozó, hozzáférés-
vezérelt** felület egyértelműen a **#948 LLM Wiki Foundation** (+3701 sor, 28 fájl): egy teljesen új
**access-control réteg tenant-adat felett** (`wiki-access.ts`, `wiki-access-service.ts`,
`wiki-repository.ts`), **privát-KB redakció** (`kb-private-redaction.ts`), új Prisma-séma (202 sor) +
0031 migráció, MCP-eszközökön kiadva. Cross-tenant izoláció + privát-tartalom szivárgás + authz-megkerülés
+ adattörlő purge-út = a legnagyobb nem-auditált kockázat. (A visszatérő 🟡 DNS-rebinding TOCTOU
residualt tudatosan nem választottam: ismert minta, kockázatos fix felügyelet nélküli futásban; az új,
„unknown-unknown"-okat hordozó felület magasabb prioritású.) **Külön worktree-n `origin/main` HEAD-ről**
(a stale-branch tanulság a 10-21-i körből), a main `.env` érintése nélkül.

**Coverage (teljes bizalmi-határ + adatfolyam-trace a LIVE felületen):** `wiki-access.ts` (tiszta
policy: `effectiveWikiAccess`/`isKnowledgeBaseVisibleTo`/`scopeSnapshotConnectorsToUser`/
`resolveWikiApprover`/`canDecideWikiChange`/`canManageKnowledgeBaseLink`), `authorize-tool-call.ts`
(KB read-gate: snapshot-szűkítés hívóra + élő connector `isKnowledgeBaseVisibleTo` re-check, mindkettő
`not_found`), `auth/mcp-server.ts` (mind az 5 agent-eszköz `scopeSnapshotToUser`; publikált `contentHash`
a szűretlen snapshoton = stabil), `agent-definition/index.ts` (`knowledgeBaseSnapshotFields` — privát
csak `visibility`+`ownerUserId`-vel kerül be; alapérték kimarad), `knowledge-base-service.ts` (ingest
`connectorId`+`actor:'agent'`, visibility+tenant+aktív re-check), `kb-private-redaction.ts` (allowlist),
`wiki-access-service.ts` (create/link/setAccess/purge/sweep, minden audit-sor redaktálva),
`wiki-repository.ts` (nyers inbox-SQL, claim-race, `PostgresPrivateKnowledgeBaseStore.purge`/
`listOrphaned`), `actions/platform.ts` (getAgentGovernance szűrés, updateAgentConnectorBinding→service,
publish scope), `ai-audit-retention/route.ts` (sweep-cron kötés), `connector-repository.ts`/
`agent-repository.ts` (séma-select + guard), 0031 migráció. A kötelező scoped security scan (Claude
Security `scan-changes`) **ütemezett munkamenetben továbbra sem futtatható** (3. lépés költség-
megerősítése nem fogad el wake-up nyugtázást) — a mélyaudit kézi end-to-end trace + a szerzői
tesztsuite futtatása.

### Biztonsági megállapítás — NINCS bizonyított finding; a felület helytáll (origin/main)

Tételesen, több esetben **adversariális trace-szel** verifikálva (nem feltételezve):
- **Cross-user privát-KB izoláció.** `kb_get_document({documentId})` A privát dokumentumára B
  felhasználóként: connectorId nélkül a `pickBinding` csak a B-re **szűkített** snapshotból választ
  (A privátja kiesett) → B saját/közös connectora; a service `document.connectorId !== input.connectorId`
  → `not_found`. Explicit connectorId=A-privát → a scoped snapshotban nincs → `not_found`. **Kétszeresen
  kapuzott** (snapshot-scope + élő `isKnowledgeBaseVisibleTo` re-check).
- **Snapshot-szivárgás.** A publikált snapshotba a privát kötés `visibility:'private_to_user'`+`ownerUserId`
  mezővel kerül (`knowledgeBaseSnapshotFields`); a `scopeSnapshotToUser` mind az 5 MCP-eszközben kiszűri a
  nem-tulajdonosnak. A `findConnectorsForAgent` `include:{connector:true}` → a governance-szűrő és a
  snapshot-építő **valódi** `visibility`/`ownerUserId`-t lát (nem no-op). A `contentHash` a szűretlen
  snapshoton → vázlat/közzétett összevetés nem törik.
- **Audit-redakció (privát KB).** `inputRef`/`outputRef` → csak UUID/hash (fájlnév→null); metadata
  **allowlist** (id/ids/hash végű kulcs + enum-kulcsok ≤64 char); path/cím/fájlnév/`purpose`/
  `collectFocus`-érték **kiesik** (csak `collectFocusChanged` boolean marad). **Minden** életciklus-
  audit-út redaktál (create/link/setAccess/access-changed/purge). Admin/superadmin a privát tartalmat
  az audit-on sem látja.
- **Purge / 30-napos sweep (adatvesztés-kapu).** `purge` Serializable tranzakcióban, a listázás↔törlés
  közti visszaállt tagságra **újra-ellenőrzéssel megszakad** (fail-safe); az `UPDATE owner_missing_since`
  és a SELECT óra-logikája konzisztens (tag hiánya → KB-nkénti óra; felfüggesztett → `membership.updated_at`);
  connectoronként atomi (nincs részleges törlés). A dokumentumok FK-ja explicit `deleteMany`-vel megy (a
  wiki-táblák amúgy is CASCADE). 0031: épkézláb defaultok (legacy→`shared`/`read`), DB-szintű CHECK
  (`private ⇒ KB + owner_user_id`).
- **Nem-élő (foundation-only, nincs elérhető hívó):** `kb_wiki_write` (0 nem-teszt referencia a kódban),
  inbox/claim/submit, `resolveWikiTarget` — a tényleges wiki-írás 2/6 (#943). A wiki-tartalom-író audit-
  redakciós rés tehát **ebben a PR-ban még nem élő**; a 2/6 auditjának kötelező ellenőrzése.

### Bizonyított finding — NINCS. Kódmódosítás nem indokolt.
Fail-closed, allowlistes, DB-CHECK-kel és 28 zöld egységteszttel fedett access-control rétegbe
kockázat-csökkentő indok nélkül nyúlni **kockázatot adna**. (Precedens: 09-16, 09-26, 10-20 — 0-finding
coverage-körök.) Nincs fix-PR és nincs `/code-review` (az a *létrehozott változtatásra* való). Nettó
kód-változás: **0**.

### Ellenőrzések
- `npm run test:wiki-foundation` (stub DB, a worktree-be linkelt `node_modules`-szal) — **28/28 zöld**;
  a tesztnevek pontosan az általam trace-elt viselkedést fedik (cross-user privát-láthatóság, közvetlen
  connectorId→not_found, élő-vs-snapshot re-check, audit-redakció path/cím/fájlnév-kiesés, purge-authz,
  30-napos sweep, láthatóság-immutabilitás, kb_ingest agent-actor).
- `test:wiki-private-purge-db` **nem futott** (valódi Postgres kell; a sweep/purge logikát a stub-
  foundation teszt fedi, a prod directUrl-t szándékosan nem érintem).
- Kézi adversariális read-gate trace (fenti cross-user eset) — a kódon verifikálva.

### Residual risk / következő audithoz
- **🟡 Retenciós sweep hiba-izoláció nélkül:** `sweepOrphanedPrivateKnowledgeBases` a napi
  `ai-audit-retention` POST-ban **az audit-sweep UTÁN** fut; egyetlen purge dobása az egész választ
  500-ra viszi (az audit-rész már commitolt), a maradék árva csak másnap törlődik. Önhelyreállító, nincs
  részleges állapot (connectoronkénti tranzakció) → nem finding; per-connector try/catch olcsó jövőbeli
  hardening.
- **ℹ️ Privát-KB audit `contentHash` korreláció:** a redakció **szándékosan** megtartja a sha256
  `contentHash`-t (auditálhatóság). Admin known-plaintext-tel megerősíthetné, hogy egy konkrét ismert
  fájlt ingestáltak-e. Tervezési döntés (a path/cím/fájlnév már kiesik), nem rés; a 2/6-nál érdemes a
  szándékosságát rögzíteni.
- **🟡 2/6 (#943) wiki-író út auditja KÖTELEZŐ:** a `createPage`/`updatePage`/`appendLog`/`createChangeSet`
  cím/body/path-ot tárol, és ezek **ma nincsenek** redaktálva (a redakció csak a lifecycle-audit-sorokra
  fut). Amint a wiki-írás (`kb_wiki_write` + change-set apply) élesedik, a privát-KB oldalcím/tartalom
  audit-ba/log-ba szivároghat, ha nem a `redactKbAuditForVisibility`-n megy át. Ez a #943 kör **első**
  ellenőrzendő pontja.
- **🟡 DNS-rebinding by-name TOCTOU (platform-szintű, carry-forward 10-20/10-21):** továbbra is nyitva;
  a wikit nem érinti (nincs egress). Dedikált kör jelöltje.
- **Következő audit további jelöltjei (10-23-ig merge-elt, még nem auditált):** #841 IAM token-redeem
  eszkaláció-fix (tagság-emelés/global-role-leminősítés — biztonsági felület, érdemes a fix teljességét
  igazolni), #927 token-szinkron-regresszió (a memóriában 10-19 100% 401; most 10-20-i fix), valamint a
  fenti gateway-költségkeret (10-21 residual).

## 2026-10-21 — Model Gateway (Hermes managed-client céges-modell út): token-kibocsátás + proxy + tartalomszűrő

**Scope-választás (kockázati alapon):** a 10-20-i bejegyzés „következő audit" listája ezt jelölte
top-jelöltnek (Hermes gateway-token lejárat/csere #890/#896/#907, `maxTokens` író-ág #903,
tartalomszűrő #871–#875/#782), és a memória **élő incidenst** jelez (10-18/10-19 token-csere 100%
401-regresszió). A Model Gateway a **legnagyobb új, külső-felületű auth-határ**: egy internetről
elérhető Hermes-kliens 10 perces, user+agent-kötött HS256-JWT-vel hívja a **céges modell egyetlen
kapuját**, amely a céges OpenRouter-kulccsal költ, és amelyen a **PAN-blokk / álnevezés** (adat-
szivárgás elleni kontroll) fut. Friss + sokat churnölt (#769/#781 proxy, #858/#860 indító-token,
#890/#896/#903/#907 token-lánc, #773/#782 szűrő, #747 teljes szűrő) + pénzügyi + privacy felület.

### ⚠️ Folyamat-lelet (fontos a következő körökre): a munkamunka-branch elavult volt
A session a `fix/drive-search-free-text-query` (@`60a1227b`) checkouton indult, amely **19 merge-dzsel
el volt maradva** `origin/main` (@`e53af17f`) mögött. Az első olvasási kör a **régi** tartalomszűrőt
(`entityType`-alapú `Candidate`, hardkódolt `['email','person']` tokenizálás, „tokenize→block"
fail-safe) látta, és ebből egy látszólagos findingot vezetett le (alap `bound` preset telefonszámot/
bankszámlát blokkol). **`origin/main`-en ez NEM áll fenn** — a szűrőt időközben átírták
(`filterMessages`, `SlotMemo`, `NOT_TOKENIZABLE={pan,secret_key}`, `content_filter.mode`
enforce/observe/off). **Tanulság: minden audit `git fetch` után `origin/main`-hez mérve történjen,
ne a checkout feature-branchhez.** A teljes újraellenőrzést külön worktree-n `origin/main`-ről végeztem.

**Coverage (teljes bizalmi-határ + adatfolyam-trace `origin/main` HEAD-en):** `gateway-token.ts`
(HS256 `verifyJwt`/`issueGatewayToken`/`verifyGatewayToken`), `model-gateway-jwt-key.ts` (kulcs-
betöltés), `proxy.ts` (`handleChatCompletion`, provider-hívás, stream-peek, tartalék-lánc,
`requirePrivate`/`local_only` kikényszerítés), `content-filter.ts` (`filterMessages`, surrogate-
session, horgok, dry-run), `response-restorer.ts`, `fallback-chain.ts`, `client-install.ts`
(managed/open kapu), `resolve-effective-policy.ts` (effektív policy), `capabilities.ts` (presetek),
`privacy-category-policy.ts`, `sensitivity-match-spans.ts` (PAN/IBAN/TAJ/… felismerés). A kötelező
scoped scan (Claude Security `scan-changes`) **ütemezett munkamenetben továbbra sem futtatható**
(a 3. lépés költség-megerősítése nem fogad el wake-up nyugtázást) — a mélyaudit kézi end-to-end
trace + futtatott reprodukciók.

### Biztonsági megállapítás — NINCS bizonyított finding; a felület helytáll (origin/main)

Tételesen verifikálva, több esetben **futtatott reprodukcióval** (memória-vault + hamis provider):
- **Token/auth:** `alg` fix HS256 (fejléc nem választhat algoritmust), `safeSecretEquals` időzítés-
  biztos aláírás-összevetés, 10 perc TTL, és `verifyGatewayToken` **minden hívásnál** újraellenőrzi
  (user aktív, tenant aktív, tagság, agent látható) → visszavont user/agent a következő híváson elvész.
  Kulcs < 32 bájt / hiány → fail-closed (503, nincs fallback). Indító-token (#858) hozzáférés-
  ellenőrzött (a user által látható legrégebbi agent).
- **Tartalomszűrő (enforce):** reprodukcióval igazolva, hogy `bound` presetben telefon→`[[PHONE_1]]`,
  bankszámla→`[[ACCOUNT_1]]`, TAJ→`[[TAJ_1]]`, adószám→`[[ADOSZAM_1]]`, IBAN→`[[IBAN_1]]`
  **visszafordítható álnevet** kap (nyers érték sosem megy ki; az open-namespace surrogate a nem-
  default típusokra is működik), PAN és titkos kulcs **blokk**. A válaszban a surrogate visszaáll.
- **Tartalomszűrő (observe/off):** `standard`=observe **szándékosan** nem blokkol/tokenizál (figyelő
  mód), de `client_policy.content_observed` auditot ír `wouldBlock` listával — a nyers egress tehát
  **naplózott**, nem néma. `free`=off. (A „standard raw egress" nem leak, hanem a #747 főkapcsoló
  `figyel` módja.)
- **`local_only` kikényszerítés:** a proxy a `requirePrivate` jelzésre a láncot céges (saját
  üzemeltetésű) providerre szűri, és ha nincs ilyen, **blokkol** — reprodukcióval + meglévő teszttel.
- **Policy-feloldás fail-closed:** ismeretlen szint → a legszigorúbb (`content_filter` esetén `block`);
  agent-plafon csak szigoríthat (strictness-min); tool-szabály azonos mintán a legszigorúbb nyer.
- **Managed/Open kapu:** friss heartbeat + regisztrált session + egyező managedDir-hash kell a céges
  modellhez; bármi hiányzik → Open (szintetikus üzenet + eltérés-audit).
- **Tartalék-lánc:** hiba-osztályozás az ms-utótagot kiszűri; keret/blokk/auth/tartalom-hiba **nem**
  vált tartalékra; első token után már nincs váltás. SSRF nincs (provider-registry env-alapú, nem
  user-vezérelt). Modell-route csak egy van (`/v1/chat/completions`) → nincs szűrőt megkerülő 2. út.
- **Teszt-lefedettség:** a `model-gateway-content-filter.test.ts` már pontosan tartalmazza a „nincs
  nyers egress a `bound` preset alatt" regressziós tesztet (minden kategória) + a `local_only`
  kényszerítést — tehát a féltett refaktor-regresszió ellen **van** élő guardrail. Nincs teszt-rés.

### Bizonyított finding — NINCS. Kódmódosítás nem indokolt.
Egy jól megírt, fail-closed, átfogóan tesztelt privacy/auth-kontrollba kockázat-csökkentő indok nélkül
beavatkozni **kockázatot adna, nem csökkentene**. A felállított `fix/gateway-tokenize-phone-account`
worktree-t (a stale-branch alapján tervezett javítással) eldobtam, miután `origin/main`-en a viselkedés
helyesnek bizonyult.

### Residual risk / következő audithoz
- **🟡 Gateway-költségkeret hiánya (megerősítendő):** a `handleChatCompletion`-ben **nincs** per-tenant/
  per-user modell-költségkeret-ellenőrzés; a `gate` horog csak Managed/Open. Egy érvényes 10-perces
  tokennel (managed módban) a kliens **korlátlanul** költhet a céges OpenRouter-kulcson. A platform saját
  dispatchjének van kerete (`dispatch-budget-tenant-scope`), de nem világos, hogy a Hermes-gateway
  egress-útra is érvényesül-e. **Következő kör:** tisztázni a spec szerint, és ha szándékosan deferred
  (V1-7), rögzíteni; ha nem, a kaput kiterjeszteni keret-ellenőrzésre. (Nem kódoltam: spec-döntés + a
  gate bővítése érdemi feature.)
- **🟡 DNS-rebinding by-name TOCTOU (platform-szintű, carry-forward a 10-20-i körből):** az egress-guard
  a feloldás-utáni IP re-check UTÁN host-névvel csatlakozik → rebind-ablak. Minden egress-hívót
  (web_fetch, MCP-connector, sandbox-teszt) érint; külön, dedikált kör + óvatos regressziós fedezet kell
  (feloldott IP pinelése a kapcsolatba). A gateway provider-registry env-alapú, így ez a gateway-t
  közvetlenül nem érinti.
- **ℹ️ A #747 „teljes tartalomszűrés" aktív** (`feat/747-content-filter-full` worktree, PR #911 nyitott):
  person-név katalógus + főkapcsoló. A phone/account/taj/adoszam szabad-szöveges tokenizálás a merge-elt
  `origin/main`-en MÁR él — a korábbi „csak email/person" V1-rés lezárult.
- A **következő audit** érdemes, még nem auditált, magas kockázatú jelöltjei: `external_services`/
  `attachments_only` kliens-oldali kikényszerítés (#873/#877) — figyelni, hogy a szerver csak publikálja
  a capabilityt, a tényleges korlát a Hermes-kliensen van; valamint a fenti gateway-keret kérdés.

## 2026-10-20 — Kimenő MCP-connector (#395 / PR #909, merge `10db7cc1`): külső MCP-szerver mint agent-eszközforrás

**Scope-választás (kockázati alapon):** a ledger utolsó bejegyzése 10-01 volt, azóta
19 nap merge-elt munka auditálatlan. `git log --since 10-01 --first-parent main` +
memória után a legmagasabb **új, külső-felületű** kockázat egyértelműen a **#909 MCP-connector**
(merge 10-17, +3212 sor, 41 fájl): a platform **MCP-kliensként** kapcsolódik egy admin által
megadott **külső MCP-szerverhez**, felderíti annak eszközeit, és agenteknek adja ki azokat.
Ez egyszerre **szerveroldali kimenő-hálózati (SSRF-osztályú)**, **külső-adat-beömlés
(prompt-injekció/trust)**, **tenant-izolációs** és **jóváhagyás-kapu** felület — friss +
komplex + kétirányú bizalmi határ = a legnagyobb nem-auditált kockázat.

**Coverage (teljes bizalmi-határ + adatfolyam-trace, kézi end-to-end):** `mcp-client.ts`
(egress-őrzött fetch, redirect-tiltás, méret/idő-plafon, OAuth-felderítés), `egress-guard.ts`
(SSRF + feloldás-utáni IP re-check + deny-by-default allowlist), `mcp-tools.ts` (besorolás,
trust-envelope, méret-vágás, fail-closed jóváhagyás), `handlers/mcp.ts` (kapu + retry-politika),
`invoke-enterprise-tool.ts` MCP-ág (`mcp_list_tools`/`mcp_call`, authz, write/danger-jóváhagyás),
`gateway-operation-service.ts` jóváhagyás-utáni végrehajtás, `actions/mcp-connectors.ts`
(admin CRUD, szerep-kapuk), `platform-settings-service.ts` (allowlist-setter), `auth/mcp-server.ts`
(tool-regisztráció), input-sémák. **A kötelező scoped security scan (Claude Security
`scan-changes`) ebben a kontextusban NEM futtatható** — a skill 3. lépésének költség-megerősítése
kifejezetten **nem fogad el ütemezett/wake-up sorból érkező nyugtázást**, és nem-interaktív
munkamenetben leáll (semmit nem indít). Ezt rögzítem; a mélyaudit kézi end-to-end trace-szel történt.

### Biztonsági megállapítás — NINCS bizonyított finding; a felület helytáll

Tételesen verifikálva (nem feltételezve):
- **SSRF/egress:** minden kimenő kérés `guardEgressUrl`-en megy (https-only, tiltott host-minták,
  feloldás-utáni privát/reserved IP re-check, deny-by-default **pontos** host-allowlist);
  `redirect: 'manual'` → 3xx-en `redirect_blocked` (a Bearer token sosem követ átirányítást);
  válasz-méret 2 MB, hívás 30 s plafon. Az allowlistet **csak platform-`superadmin`** írhatja
  (`setMcpHostAllowed`, wildcard + tiltott host elutasítva); tenant-admin csak már-allowlistázott
  hostra mutathat. A hívásonkénti domain-újraellenőrzés miatt a visszavonás azonnal hat.
- **Tenant-izoláció:** connector `findFirst({id, tenantId, type:'mcp'})`, aktív eszközlista
  `{connectorId, tenantId}` szerint, grant per-user. Cross-tenant szivárgásra nincs út.
- **Trust-envelope:** a külső eszközleírás és -eredmény `untrustedExternalText`/`untrustedExternalData`
  jelöléssel, `EXTERNAL_NOTE`-tal, 2 000 / 40 000 karakteres vágással megy a modell felé (D6/D7).
- **Jóváhagyás-kapu:** `write`/`danger` kockázat emberi jóváhagyásra; `danger` mindig; új/változott
  eszköz `danger`+`approved:false` (fail-closed); a **jóváhagyás-utáni** végrehajtás **újra**
  lefuttatja `checkMcpCallGate`-et (visszavont domain / de-approvolt eszköz nem fut).
- **Szerep-kapuk:** create/approve `requireTenantRole('admin')`, list `operator`, allowlist-írás
  `superadmin`. Mind helyes.

### Bizonyított finding (reliability / correctness) — javítva (PR **#931**)

**`mcpListTools` lapozó ciklusa nem-haladó szervernél a session-timeoutig pörög.** A `do…while`
csak az **összesített** eszközszámot plafonozta (`MCP_MAX_TOOLS = 1000`), a **lapok számát** nem.
Egy szerver, amely **üres lapot** ad vissza nem-null `nextCursor`-ral, vagy **ugyanazt a kurzort**
ismétli, új eszköz híján sosem érte el a plafont → a 30 s-os `AbortController`-ig másodpercenként
tucatnyi `tools/list` kérést zúdított a szerverre.
- **Hatás:** egy admin „ellenőrzés / eszközök frissítése" művelet egy **hibás (vagy rosszindulatú,
  allowlistázott)** külső szervernél ~30 s-ig lógott + fölösleges kérés-özön. **Súlyosság:** alacsony
  (allowlist-kapuzott, időben már eddig is bounded; de valós buggos third-party szervernél is jelentkezik).

### Javítás (root-cause, a megosztott lapozóban — minden hívó ezen megy át)
- `mcp-client.ts` `mcpListTools`: ha egy lap **nem hoz új eszközt** (`batch.length === 0`), vagy a
  visszakapott kurzor **nem mozdult** (`cursor === sent`), lezárjuk. A szabályos lapozást (nem üres
  lap + mozgó kurzor) és a `MCP_MAX_TOOLS` plafont nem érinti. Egy `page.tools ?? []` null-guard is
  bekerült (az üres-lap ellenőrzéshez amúgy is kell).

### Ellenőrzések
- `test:mcp-connector` (új eset): üres-lap + nem-null kurzor → **1** kérés után lezár; tartalommal
  visszatérő, nem mozduló kurzor → **2** kérés után lezár. Teljes suite **zöld**.
- `tsc`/`eslint` tiszta a módosított fájlokra.
- Független **`/code-review`** (Matt Pocock, 2 párhuzamos axis): **Standards** — 0 hard violation,
  0 érdemi smell (root-cause elhelyezés, helyi idiómákhoz illeszkedő nevek). **Spec** — helyes,
  minimális, root-cause; a `MCP_MAX_TOOLS` plafon megmarad, a szabályos lapozás nem csonkul.
  Egyetlen érdemi megjegyzés: egy **spec-szerinti üres KÖZBÜLSŐ lap** (nem-null kurzorral) a mostani
  üres-lap kapun csonkolna — gyakorlatban nem fordul elő, a pörgés-stop fontosabb; a tradeoff most
  a kódban `ponytail:` jelöléssel **néven nevezve** (upgrade-út: lap-plafon a break helyett).

### PR
- **#931** — `fix(mcp-connector): don't spin tools/list on a non-advancing cursor`
  (branch `fix/mcp-list-tools-pagination-loop`, `origin/main`-ről, külön worktree; 2 commit).

### Residual risk / következő audithoz
- **🟡 DNS-rebinding by-name TOCTOU (megosztott, pre-existing minta):** a `guardedMcpFetch` a
  `guardEgressUrl` IP-re-checkje UTÁN **host-névvel** csatlakozik (`fetchImpl(guard.url)`), így a
  fetch connect-kori újra-feloldása és az ellenőrzés közt van egy rebind-ablak. Ez a **platform
  egészére** jellemző (web_fetch, sandbox-connection-tester ugyanígy), **allowlist-kapuzott**
  (superadmin által felvett hostok), ezért nem e PR findingja. **Upgrade-út:** feloldott IP
  pinelése a kapcsolatba (`lookup` → `agent`/`dispatcher` a pin-elt IP-vel). Platform-szintű, külön
  kör jelöltje — minden egress-hívót egyszerre javítana.
- **🟡 üres KÖZBÜLSŐ lap csonkolás:** l. fent, néven nevezve a kódban; near-theoretical.
- **🟡 `idempotencyKey` nem kötelezett írásnál:** a `mcpCallInputSchema` szerint opcionális, a
  leírás „required for write/danger"; a jóváhagyás + `#618` write-confirm HMAC egyszer-használat
  már gátol, de a kulcs tényleges kötelezése külön finomítás lehet (nem biztonsági rés).
- A **következő audit** érdemes témái (10-01 óta merge-elt, még nem auditált, magas kockázatú):
  Hermes-guard tartalomszűrő (#871–#875, #782), Hermes gateway-token lejárat/csere lánc
  (#890/#896/#907 — a memóriában 401-regresszió-jelzés van), gateway `maxTokens` közvetlen-író ág
  (#903), attachments-only external services (#873/#877).

## 2026-10-01 — Kimenő író-kliensek 5xx retry-duplikátum (Drive/Sheets/Docs/Slides + http_api)

**Scope-választás (kockázati alapon):** a 2026-09-25-i kör a #674-ben a Gmail-küldés
non-idempotens 5xx-retry duplikátumát javította, és a ledger **explicit prioritált
követő körként** jegyezte a *többi* kimenő író-kliens ugyanezen retry-mintáját
(`google_sheets_write_range`, `google_drive_upload_file`, `http_api_request` POST/PUT).
Ez volt a legmagasabb nem-auditált, **visszavonhatatlan külső hatású** felület (dupla
fájl / dupla sor / dupla megrendelés-számla). `gh pr list` + ledger után ezt vettem.

**Coverage (teljes retry-mátrix + minden `fetchWithBackoff` hívási hely, 3 kliens):**
`GoogleDriveApiClient`, `GoogleWorkspaceApiClient` (Docs/Sheets/Slides),
`HttpApiClient` (közvetlen **és** protokoll ág). Minden írási/olvasási hívás
idempotencia szerint osztályozva.

### Bizonyított finding (reliability / correctness) — javítva (PR **#762**)

**Non-idempotens kimenő POST újrapróbálja az ambivalens 5xx-et → dupla mellékhatás.**
Mindhárom kliens `fetchWithBackoff`-ja 429 mellett **minden 5xx-re** (500/502/503/504)
újrapróbált, **minden** művelettípusra. A nem-idempotens create/append POST-oknál ez
duplikátumot okoz, ha a művelet a szerveren már lefutott, de a válasz ambivalens (502):
- **Drive:** `uploadFile` (dupla feltöltött fájl), `createFolder`, `copyFile`, `shareFile`.
- **Workspace:** `applyDocsEdits` / `applySlidesEdits` batchUpdate `insertText` (dupla
  bekezdés), `writeSheetsRange` `:append` (dupla sor).
- **http_api közvetlen ág** (`request()`, `route ~915`): POST/PUT/PATCH/DELETE egy
  generikus üzleti API-n → **dupla megrendelés / dupla számla**. (A **protokoll-ág** —
  `requestViaProtocol` ~1015 — már helyesen letiltotta: `READ_METHODS.has(method)`; a
  közvetlen ág volt az **inkonzisztens, kapuzatlan** testvér-ingress.)

- **Hatás:** kettős üzleti cselekvés (fájl/sor/bekezdés/bizonylat), bizalomvesztés,
  költség. **Súlyosság:** közepes (hitelesített, de visszavonhatatlan külső hatás;
  nincs cross-tenant szivárgás).

### Javítás (root-cause, a határon — a #674 Gmail-mintát tükrözve)
- A grant-kliensek `fetchWithBackoff`-ja `retryServerErrors` kapcsolót kap:
  `false`-nál **csak a 429-et** ismétli (elutasított = fel nem dolgozott), az 5xx-et nem.
  Minden nem-idempotens create/append POST a `NO_5XX_RETRY` ágra kerül; az **olvasások**
  és az **idempotens** írások (Sheets range-felülíró **PUT**, Drive metaadat-**PATCH** /
  átnevezés / áthelyezés / kuka) **tartják** az 5xx-retryt.
- `http_api` közvetlen ág: `READ_METHODS.has(method)` átadása (a protokoll-ággal azonos).
- **Code-review follow-up (mindkét axis egybehangzó nitje):** a http_api kliens a
  `retry` boolean újrahasznosításával az írásoknál a **429-et is** letiltotta — a
  grant-kliensek és a spec viszont a 429-et megtartják. A `fetchWithBackoff` mostantól a
  grant-kliensekkel azonos `retryServerErrors` szemantikájú (írás = csak 429, olvasás =
  429+5xx); ez a **protokoll-ágat is** javítja és megszünteti a kliensek közti eltérést.

### Ellenőrzések
- `test:google-drive-api-client` (3 új): upload/create_folder egyszer fut 5xx-en
  (nincs dupla), olvasás továbbra is retryz. **Zöld.**
- `test:google-workspace-api-client` (4 új): Sheets `:append` + Docs/Slides batchUpdate
  egyszer fut; Sheets range-**PUT** retryz. **Zöld.**
- `test:http-api` (3 új): nem-idempotens POST **nem** ismétel 5xx-et (1 hívás), de
  **ismétel** 429-et (2 hívás), olvasó GET retryz (3 hívás). **Zöld.**
- A Drive/Workspace kliens-tesztek eddig **nem futottak** CI-ben — most npm-scriptként
  **és** a CI pipeline-ban is futnak (coverage-nyereség önmagában).
- `tsc`/`eslint` tiszta a módosított fájlokra (a `localRoots` tsc-zaj pre-existing
  Prisma-client drift a `main`-en, nem e kör).
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis): **Standards** — 0 hard
  violation; a minta a már-mergelt `gmail-api-client` konvencióját követi (nem smell);
  egyetlen actionable nit (http_api 429-divergencia) **átvezetve**. **Spec** — hű, teljes,
  0 scope-creep; minden non-idempotens hely lefedve, az idempotensek helyesen retryznak;
  az egyetlen P1 (429-megtartás) **átvezetve**.

### PR
- **#762** — `fix(connectors): don't replay ambiguous 5xx on non-idempotent write POSTs`
  (branch `fix/write-client-5xx-retry-duplicate`, `origin/main`-ről, külön worktree).

### Residual risk / következő audithoz
- **🟡 batchUpdate szemcsézettség:** a Docs/Slides batchUpdate `replaceAllText`/`deleteObject`
  önmagában idempotens; most az egész batchUpdate nem-retryző (mert `insertText`-et is
  tartalmazhat). Konzervatív (dupla-mentes), de egy tiszta-replace batch 5xx-en fölöslegesen
  elbukik. Finomhangolás (operation-típus szerint) lehetséges, de YAGNI — a dupla-mentesség
  fontosabb.
- **🟡 http_api idempotens-flagelt végpont retry-vesztése:** egy `idempotent:true` +
  idempotencia-kulcs headeres végpont írása ma sem retryzi az 5xx-et (a protokoll-ág
  mintáját követve). Biztonságos default; ha a megbízhatóság gond lesz, az idempotencia-kulcs
  mellett az 5xx-retry visszaengedhető — jelen körben szándékosan nem.
- **`create_draft`-szerű „bukás átmeneti 5xx-en" UX** (l. 09-25): a nem-idempotens írás
  5xx-en hangosan elbukik (dupla helyett nulla) — a user/agent tudatos új művelettel
  ismétel. Ha a bukás gyakori lesz, végpontonkénti idempotencia-kulcs az upgrade-út.
- A VERIFIKÁLTAN lefedett kliensek (Gmail #674 + e kör 3 kliense) retry-politikája zárt;
  új kimenő író-kliens bevezetésekor ugyanezt a `retryServerErrors`-mintát kell követni.

## 2026-09-26 — KB-keresés/-olvasás MCP-n (#678, `9be5b023`): nyers FTS-SQL, tenant-határ, HTML-ingest

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után a legmagasabb **nem-auditált**
felület a **tudásbázis-lekérdezés MCP-n** (`kb_search`/`kb_get_document`/`kb_get_page`/`kb_ingest`/
`kb_list_index`) — külső, OAuth-hitelesített, **adat-kiszivárgás-osztályú** olvasó felület, amely a
napi ledgerben eddig **nem szerepelt** (csak a 09-24 MCP-írás-kör érintette a read-oldali méret-kapukat).
Egyúttal ez a felület kapta a legfrissebb, **legnagyobb** kódváltozást (#678 / `9be5b023`, +334 sor):
új nyers Postgres FTS-SQL (`hungarian` regconfig, `regexp_split_to_table` szakasz-vágás, IDF-rangsor),
szakasz-szintű raw-keresés és HTML-ingest. Friss + komplex + adat-felület = a legnagyobb új kockázat.

**Coverage (teljes bizalmi-határ + adatfolyam-trace, kézi end-to-end + kötelező scoped security scan):**
`executeKnowledgeBaseTool` (handlers/knowledge-base.ts — a `connectorId`/`tenantId` **szerver-feloldott**
`ctx`-ből, SOHA a tool-argsból; csak `documentId`/`path`/`section`/`query`/ingest-tartalom
támadó-vezérelt) → `KnowledgeBaseService.search`/`getDocument`/`getPage`/`listIndex`/`ingest` →
`PostgresDocumentRepository.searchRaw` + `PostgresKnowledgeChunkRepository.searchChunks` (nyers
`$queryRaw`), `assembleKbHits`/`rankKbHits`/`outlineSections`, `extractHtml`/`htmlToText`, 0011 migráció
+ apply-kb-fts index-script.

### Biztonsági megállapítás — NINCS finding (≥8 konfidencia); a felület helytáll

A kötelező scoped security scan (`/security-review`, dedikált felderítő + false-positive szűrő
sub-agent) **és** a független kézi end-to-end trace **egyaránt 0 bizonyítható, ≥8-konfidenciájú
kihasználható hibát** talált. Tételesen verifikálva (nem feltételezve):

- **SQL-injekció — nincs.** Minden támadó-befolyásolt érték **bound paraméterként** vagy **futásidejű
  függvény-argumentumként** jut a Postgresbe, sosem SQL-szövegbe fűzve. `KB_FTS_CONFIG =
  Prisma.sql`'hungarian'::regconfig`` konstans (nincs benne interpoláció). `tsquery` (`toKbTsQuery`)
  és a `terms` (`kbQueryTerms`) **csak `\p{L}\p{N}` tokeneket** enged (`token:*`/`unnest($n::text[])`),
  Prisma `$n`-ként köti — a `to_tsquery`/`regexp_split_to_table`/`unnest` mind adatként kapja.
  `KB_SECTION_SPLIT_SQL` modul-konstans, kötve. `connectorId`/`connectorIds` `::uuid`, kötve + trusted.
  Nincs malformed-tsquery hibaút sem (a token sosem üres). Az egyetlen `$executeRawUnsafe`
  (apply-kb-fts) hardcode-olt, dev/ops-only.
- **Cross-tenant / cross-connector — nincs.** `searchRaw`: `WHERE d.connector_id = ${connectorId}::uuid`;
  `searchChunks`: `c.connector_id IN (...)`; `getDocument`: `document.connectorId !== input.connectorId
  → found:false`; `getPage`/`listIndex`: `[connectorId]`-scope. Mindegyik `connectorId` a szerver-feloldott
  `ctx.connectorId`-ból (agent KB-connectora, tenant-kötött), nem argsból → hamisított `documentId`/`path`
  nem lép ki a connector-határból.
- **Adat-kiszivárgás a SELECT-ben — nincs.** Az újonnan lekért `d.extracted_text` **csak szerveroldalon**
  fogy (a szakasz-cím `kbSectionForSegment` számításához), nem kerül a visszaadott `KnowledgeRawHit`-be.
  A `matched` a hívó **saját** kérdésszavaiból származik; a `section` ugyanazon connector heading-útvonala.
- **HTML-ingest (XXE/SSRF/RCE/stored-XSS) — nincs.** `extractHtml` tisztán regex-`String.replace`
  (nincs XML/DOM-parser → nincs XXE; nincs hálózat → nincs SSRF; nincs `eval` → nincs RCE). A kimenet
  **minden tag-et eltávolít** (`htmlToText` záró `<[^>]+>`→''), és **szövegként** tárolódik/adódik vissza,
  nem renderelt HTML-ként → nincs stored-XSS a KB-tartalmon keresztül.

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding

- **SQL↔JS szakasz-vágás paritás.** A raw-találat `section`-je a SQL `regexp_split_to_table(...,
  KB_SECTION_SPLIT_SQL) WITH ORDINALITY` `ord`-ját a JS `splitKbSegments`-be indexeli (`ord-1`).
  Verifikálva: a Postgres ARE **támogatja** a `(?=…)` lookaheadet (a delimiter egyetlen `\n`,
  zero-width constraint-tel), így a vágás element-for-element egyezik a JS `String.split`-tel
  (vezető/köztes üres-szegmens szemantika is), beleértve a `\r\n` és a headingnélküli/vezető-heading
  eseteket. A round-trip (`kbSectionForSegment` → `kb_get_document({section})` → `findSection` exact/leaf/
  partial + `(n)` dedup) zárt.
- **IDF-rangsor pozíciós illesztés.** A service `k: okfChunkHits.length`-szel hívja az `assembleKbHits`-et,
  üres `memoryContent`/`docs` mellett → a visszaadott `okfHits` **hossza és sorrendje azonos** az
  `okfChunkHits`-szel, így a `okfHits[i] ↔ okfChunkHits[i]` (matched/rank) illesztés helytáll; a
  `rankKbHits` DF-je minden `matched` termre tartalmaz kulcsot (`df.get(term)!` biztonságos).
- **Migráció-drift-ellenállás (kapcsolódik a visszatérő 🔴 „deploy nem migrál" incidenshez).** A 0011
  GIN-index **csak teljesítmény** — a keresés **korrektsége index nélkül is helyes** (seq scan), a migráció
  explicit így dokumentálja. Az index-kifejezés `to_tsvector('hungarian'::regconfig, …)` **IMMUTABLE**
  (2-argumentumú, explicit regconfig) → az index-építés nem bukik. A `hungarian` snowball beépített (Neon).

### Ellenőrzések
- `npm run test:kb-retrieval` — **zöld** (21 assert; köztük `kbSectionForSegment` SQL↔JS mapping,
  `rankKbHits` IDF, egyedi útvonal-címek + jelöltlista, superseded raw-elrejtés).
- Kötelező scoped security scan (`/security-review`): dedikált felderítő sub-agent + FP-szűrés →
  **0 finding ≥8 konfidencián**, a fenti SAFE-kontrollok tételes (soronkénti) verifikációjával.
- **Nettó kód-változás e körből: 0** — nincs bizonyítható finding, ezért a szabály szerint (`csak
  bizonyítható finding alapján módosíts`) nincs kód-módosítás, nincs fix-PR és nincs `/code-review`
  (az a *létrehozott változtatásra* való). Precedens: 09-16 sandbox 0-finding kör. Az érték a **coverage**:
  a KB-lekérdezés/-ingest felület első dokumentált biztonsági + reliability-verifikációja, és a friss,
  magas kockázatú #678 változás igazolása.

### Residual risk / következő audithoz
- **🟡 SQL↔JS vágás-paritás csak JS-oldalon tesztelt.** A `test:kb-retrieval` a JS `splitKbSegments`-et
  futtatja, a **valódi** `regexp_split_to_table` viselkedést nem (stub-DB). A paritás elemzéssel igazolt
  (Postgres ARE lookahead-támogatás), de egy jövőbeli Postgres-verzióváltás vagy a regex/`KB_SECTION_SPLIT_SQL`
  konstans szétdriftelése **néma szakasz-félrecímkézést** okozhatna. Olcsó follow-up: egy `test:kb-gate`
  (valódi Neon-kompat. Postgres) paritás-assert (`regexp_split_to_table` ↔ `splitKbSegments`). Nem e-kör-
  finding (nem bizonyított hiba), de a legérdemesebb megerősítés.
- **🟡 `rankKbHits` pozíciós illesztés törékeny.** Ma helyes, de az `assembleKbHits` belső viselkedésére
  (üres memory/docs, okf-first, nincs átrendezés) épül; ha az `assembleKbHits` valaha szűr/átrendez, a
  matched/rank metaadat elcsúszhat. Defenzív alternatíva: a matched/rank a `hit` objektumon utazzon
  (nem külön párhuzamos tömbben). Nem bizonyított hiba → nincs e-kör-módosítás (ponytail: nincs spekulatív
  hardening).
- **Raw-keresés seq scan + szakaszonkénti `to_tsvector`** (ponytail-komment jelzi): korrekt, de a raw-korpusz
  növekedésével lassul; GIN/tárolt szakaszok az upgrade-út. DoS-osztály, scope-on kívül.
- **`kb_ingest` fájltípus-hamisítás/tartalom-vizsgálat** (magic-bytes/AV) változatlanul nyitva — l. idea #447;
  önálló, tágabb scope.

---

## 2026-09-25 — MCP Gmail írási felület (#637), reliability-kör: non-idempotens küldés retry-duplikátum

**Scope-választás (kockázati alapon):** a **09-24-i kör** (lentebb) a #637 MCP Gmail
*írási* felületét már mélyen auditálta a **bizalmi-határ / auth / jóváhagyás /
fejléc-injekció / scope** tengelyen, és high-confidence biztonsági findingot nem talált
(a `draftId`/válasz következmény-kártya-rés residualként jegyezve; #668 DRAFT javítja). Az
a kör azonban a `GmailApiClient` **hálózati megbízhatósági viselkedését (retry-politika)
nem vizsgálta** — ez maradt a felület legnagyobb nem-auditált kockázata, és mivel a kimenő
e-mail visszavonhatatlan, külső hatású, ezt a reliability-tengelyt auditáltam.

**Coverage:** `GmailApiClient.fetchWithBackoff` retry-mátrixa és minden hívási helye
(search/get/list olvasások, `send` messages/send + drafts/send, `create_draft`,
`modify_labels`, `trash`, `delete_draft`, `getReplyContext`, `count`). Kereszt-ellenőrzés a
művelet-szintű idempotenciával (`enqueueGatewayOperation` idempotencyKey-dedup) — az a
kliens *teljes-művelet* újraküldését fedi, az egyetlen végrehajtáson belüli HTTP-retryt nem.

### Bizonyított finding (reliability / correctness) — javítva
**Non-idempotens küldés újrapróbálja az ambivalens 5xx-et → dupla kimenő e-mail.** A
`fetchWithBackoff` a 429 mellett **minden 5xx-re** (500/502/503/504) újrapróbál. Olvasásnál
és idempotens írásnál (címke/kuka) ez helyes, de a **küldés POST nem idempotens**, és a
Gmail nem fogad kliens-idempotencia tokent: ha egy `502` után a levél valójában már kiment,
a retry **mégegyszer elküldi** — a címzett két azonos levelet kap. A művelet-szintű
`idempotencyKey` csak a teljes-művelet kliens-újraküldést szűri; ezt a HTTP-szintű retryt
**nem** fedi. A 09-24-i kör MIME-építést és fejléc-injekciót nézett a `gmail-api-client`-ben,
a retry-viselkedést nem — így ez **net-új** finding, nem az előző kör duplikátuma. Üzleti
hatás: dupla megrendelés-visszaigazolás / fizetési felszólítás → kettős cselekvés,
bizalomvesztés.

**Root-cause javítás a határon** (PR **#674**, ág `fix/gmail-send-no-5xx-retry-duplicate`,
külön git worktree-ben — a felhasználó i18n-WIP-je érintetlen):
- `fetchWithBackoff` új `retryServerErrors` kapcsoló: `false` esetén **csak a 429-et**
  ismétli (elutasított = fel nem dolgozott, biztonságos), az ambivalens 5xx-et nem.
- A három nem-idempotens create/send POST (`gmail_send` messages/send + drafts/send,
  `gmail_create_draft`) a nem-retryző ágra kerül; 5xx-en a művelet **hangosan elbukik**
  (`gateway.operation.failed`) → dupla helyett nulla, a user új művelettel újraküld.
- `gmail_modify_labels`/`gmail_trash` idempotens → marad a default 5xx-retry.

### Ellenőrzések
- `npm run test:gmail-mcp-tools` — **zöld**, 5 új regressziós eset: send / draftId-send /
  create_draft egyszer fut 5xx-en (nincs dupla), send 429-en még újrapróbál és sikeres,
  olvasás 5xx-en továbbra is retryz.
- `tsc --noEmit` és `eslint` tiszta a módosított fájlokra.
- Matt Pocock `/code-review` (Standards + Spec, párhuzamos sub-agentek): mindkét tengely
  „a mechanizmus helyes és minimálisan scope-olt". Standards: 1 soft nit (angol kommentek
  magyar-kommentelt fájlban) → **átvezetve**. Spec: 0 scope-creep, 0 hibás implementáció;
  teszt-lefedettségi rés (draftId-send + create_draft) → **átvezetve** (2 új call-count teszt).

### Residual risk / következő audithoz
- **🟠 HTTP/Drive/Sheets write POST-ok ugyanezen retry-mintája (más kliensek).** A
  non-idempotens retry-duplikátum máshol is fennállhat — pl. `google_sheets_write_range`,
  `google_drive_upload_file`, `http_api_request` POST/PUT — külön `fetchWithBackoff`-szerű
  helper nélkül vagy azzal. **Prioritált követő kör:** a Drive/Sheets/HTTP írási kliensek
  retry-politikájának ugyanilyen auditja.
- **`create_draft` 5xx→bukás:** a piszkozat-létrehozás is elbukik átmeneti 5xx-en (retry
  nélkül). A duplikátum-mentesség fontosabb; ha a megbízhatóság gond lesz, a Gmail
  draft-létrehozás felülírható ugyanarra a threadId-re — YAGNI most.
- **09-24-i residualok továbbra is nyitva:** következmény-kártya címzett-láthatóság
  válasznál/draftId-nél (#668 részben), reply compose-only scope fail-closed UX,
  `getProfileEmail` csak primary (send-as alias nem kizárva reply-all self-szűrésnél).

---

## 2026-09-24 — MCP resource-server írási felület (Gmail send/reply/draft/label/trash, #637): bizalmi határ + jóváhagyás-kötés + fejléc-injekció

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az utolsó bejegyzés
(09-17) óta egy **nagy MCP-hullám** ment main-re: **#637 teljes Gmail-írás az MCP-n**
(küldés/válasz/piszkozat/címke/kuka), #631 http_api path-illesztés, #635/#634/#632
projektmemória, #627 KB raw_text. Az egész **MCP resource-server** (`/api/mcp/[tenantSlug]`)
— külső, OAuth-hitelesített, most **író képességű** támadási felület — **nem szerepelt a
ledgerben**, és a #637 a legmagasabb új blast-radiusú változás (agent által vezérelt,
emberi jóváhagyás mögötti valós e-mail-küldés/kuka). Ez volt a legnagyobb nem-auditált kockázat.

**Coverage (teljes bizalmi-határ trace, kézi end-to-end):**
`route.ts` → `handleMcpRequest` (`withMcpAuth`, Clerk OAuth verify) →
`resolveMcpPrincipal` (token-verify → **foreign `aud`/`resource`-origin elutasítás** →
aktív user → **URL-slug szerinti tenant** → tenant-státusz → **aktív tenant-membership**
kötelező, különben `not_a_member`; superadmin → `assumed`; `userId`/`tenantId` SOHA a
tool-JSON-ból) → `tools/call` (allowlist-kapu `MCP_ALLOWED_TOOLS`) →
`invokeEnterpriseTool` (definitionId-kapu, `isDispatchable`, definition-pin/`agent_stale`,
`args.agentId` egyeztetés, `canOperateAgent` grant-kapu) → írónál `enqueueWrite`
(`enqueueGatewayOperation` → `loadAuthorizedWrite`: séma + `authorizeToolCall` connector/scope-
kapu + kötelező `idempotencyKey`) → jóváhagyás (`approveGatewayOperation`
`withLockedOperation` egyszer-használat, `pendingDecisionError` státusz+döntés-kapu) →
`executeApprovedOperation` (**újra-authorizál a kérő élő szerepével**, tenant-kötött,
token a kérő grantjából) → `executeGmailTool`/`GmailApiClient`. Melléksávok: write-confirm
MRTR-űrlap (#618, `argsHash`+`operationId`+principal-kötés a `requestState`-ben),
`gmail-api-client` MIME-építés, http_api path-allowlist (#631), read-oldali méret-kapuk.

### Biztonsági megállapítás — a bizalmi határ helytáll (nincs ≥ high-confidence finding)

Minden vizsgált kontroll explicit verifikálva (nem feltételezve):
- **Cross-tenant izoláció.** A tenant kizárólag az URL-slugból + kötelező aktív
  membershipből oldódik; idegen tenant URL-jére hitelesített nem-tag `not_a_member`-t kap.
  Token-`aud`/`resource` idegen originre elutasítva.
- **Jóváhagyás egyszer-használat + confused-deputy.** A gateway-operation zárolt
  státuszátmenettel egyszer fut; `canDecideGatewayOperation` csak a kérő vagy admin/approver;
  idegen tenant/operáció `operation_not_found` (nem szivárog). Végrehajtáskor **újra-authorizál**
  a kérő élő szerepével és grantjával — az approver jogai nem emelik a műveletet.
- **Fejléc-injekció (SMTP/MIME).** `headerValue` minden `To/Cc/Bcc/In-Reply-To/References`
  értékből kiszűri a CR/LF-et; a `Subject` RFC 2047 encoded-word (a nyers érték előbb CRLF-mentes).
  A válasz `In-Reply-To`/`References` az eredeti (támadó-vezérelt) levél fejléceiből jön, de
  ugyanazon a CRLF-szűrőn megy át. A MIME-boundary szerver-generált, nem input.
- **Scope-kapu.** Readonly Gmail-grant `gmail_scope_not_granted`-tal **már az enqueue-nál**
  elutasítva (teszttel igazolva).
- **http_api path-allowlist (#631).** A sablon adminvezérelt; a `{param}` szegmensen belüli
  regex `[^/]+` (nem lép szegmenshatárt), a szegmensszám egyeznie kell, a literál részek
  escape-eltek és `^…$`-horgonyzottak → a modellvezérelt `path` nem illeszt nem szándékolt
  endpointra. Traverzál (`..`) a szegmensszám-kapu miatt nem szökik ki a baseUrl-ből.
- **Read-oldali amplifikáció.** `gmail_search maxResults` ≤ 50, `list_drafts` ≤ 25 — az N+1
  metadata-lehívás korlátos.

### Residual risk / következő audithoz
- **🟠 Következmény-kapu láthatósági rés a Gmail-válasznál és piszkozat-küldésnél
  (transzparencia).** A write-confirm űrlap (#618) és a control-plane kártya a tárolt
  args-ból épül. **Válasznál** (`replyToMessageId`, nincs explicit `to`) a jóváhagyó csak
  „címzett: az eredeti feladó" / „(mindenkinek)" szöveget lát, a **konkrét címzett(ek)et
  nem** — az `resolveCompose` a valós címzettet csak *végrehajtáskor* oldja fel a Gmailből.
  **`gmail_send({draftId})`** esetén a kártyán csak az átlátszatlan draftId látszik, tartalom
  nélkül. Egy (akár prompt-injektált) modell így olyan levelet küldethet jóvá, amelynek
  címzettjét/tartalmát az ember nem látja — az „auditálható, ember által kontrollált AI-írás"
  ígéret réselődik. Azonos osztály, mint a korábban jegyzett `code-review-consequence-card-
  outbound-content`. **Nem lett kódmódosítás:** a rés bezárása a jóváhagyási úton élő
  Gmail-olvasást (token-feloldás az enqueue/confirm ágon) igényel — nem „lazy", viselkedést
  változtató fix, amit felügyelet nélküli futásban szándékosan nem erőltettem; felhasználói
  döntést kér (címzett/tárgy felbontása enqueue-kor vs. külön előnézeti hívás).
- **Válasz compose-only scope-pal fail-closed.** Ha egy grant csak `gmail.compose`, a válasz
  `getReplyContext` (messages.get) végrehajtáskor 403-mal bukik → `gmail_auth_failed`,
  művelet `failed`. Biztonságos hibamód, de rossz UX; érdemes az enqueue-scope-kapuban a
  `replyToMessageId` jelenlétekor olvasó scope-ot is megkövetelni (fail-fast).
- **`security-review` diff-eszköz nem futott** — a #637 már merged, a jelenlegi ág
  (feat/signal-design) nem tartalmazza; a felderítés a kézi end-to-end trace + a `gmail-mcp-tools`
  tesztfuttatás volt (precedens: 09-17 üres-diff eset).

### Ellenőrzések
- `npm run test:gmail-mcp-tools` — **zöld** (küldés jóváhagyás után pontosan egyszer;
  readonly grant enqueue-nál elutasítva; multipart body/cc/attachment olvasás).

---

## 2026-09-17 — Külső gateway (`POST /v1/chat/completions`): agent-API bizalmi határ + `x-agent-version` NaN költség-/audit-rés

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az előző körök az
OOM-ingress, a tool-diszpécser és a kódfuttató sandbox felületét fedték. A **külső,
hitelesített OpenAI-kompatibilis gateway** (`/api/v1/gateway/v1/chat/completions`) — a
platform egyik legmagasabb értékű külső támadási felülete (agent API-kulcs auth, tenant-
feloldás, költség/keret-kikényszerítés) — **nem szerepelt a napi ledgerben**, ezért ez volt
a legnagyobb nem-auditált kockázat. Az ág épp itt dolgozott (ticket confused-deputy), ami a
felület fontosságát is jelzi.

**Coverage (teljes bizalmi-határ trace):** `authenticateAgentRequest` → `authenticateApiKey`
(formátum-kapu → HKDF egyedi lookup-hash → `bcrypt.compare` + usability; legacy-út csak a
hash nélküli sorokat bcrypteli, backfillel) → `requireAgentScope` → `openAiChatCompletionSchema`
→ tenant-gate (`assertAgentWorkTenantOperable`, `ticket.tenantId ?? agent.tenantId`) →
`resolveGatewayRequestModel` + `RoutingEngine.resolve` (kliens `overrideHint` CSAK explicit
policy-engedéllyel; nincs policy → agent-config, az override eldobva). Melléksáv: **minden**
agent-API ingress cross-tenant kontextus-kapuja — `agent/tools`, `agent/tickets/[id]`,
`harness/tickets/[id]/process`, `agent/tickets` create — mind kikényszeríti a
`ticket.agentId === auth.agentId` / tenant-tulajdont; a `board_write` args-ticketId külön a
`referencedTicketIds`-be kerül; a connector a broker `authorizer`-én az agent grantjából
oldódik (nincs args-vezérelt `connectorId` IDOR); `resolveWorkspaceStorageTenantId` csak a
felső-szintű (kapuzott) `ticketId`/`conversationId`-ből választ tenantot.

### Biztonsági megállapítás — a bizalmi határ helytáll (nincs auth/IDOR finding)

Az auth, a scope, a cross-tenant kontextus-tulajdon, a connector-authz és a modell-override-
routing mind megfelelően kapuzott. A gateway `x-ticket-id` confused-deputy (idegen ticket
call-capjének fogyasztása) volt az utolsó rés, és azt a **felhasználó egyidejűleg javította**
(`386f4d548 fix(gateway): bind ticket usage to authenticated agent`, `isAgentApiToolContext­OwnedByAgent`
kapu a tenant-gate elé). A kötelező diff-alapú `/security-review` a **committálatlan** ág-állapoton
üres diffet kapott (az ág 0 branch-commit volt a munka idején), ezért a finding-felderítés a
kézi end-to-end trace volt.

### Bizonyított finding (correctness / cost-integrity, ≥9) — javítva

**`x-agent-version` NaN → néma költség- és audit-rés.** A gateway a fejlécet nyers
`Number.parseInt`-tel olvasta; nem-numerikus értékre (`x-agent-version: abc`) ez `NaN`, és a
`NaN ?? agent.currentVersion` **nem** esik vissza (a `NaN` nem nullish). A `NaN` továbbfolyt a
`services.gateway.call({ agentVersion })` → `modelCalls.create({ agentVersion })`-ba, ahol a
`ModelCall.agentVersion` **`Int?`**. A Prisma a `NaN`-t elutasítja — de a **fizetős
`provider.chat()` EKKOR MÁR lefutott** (`model-gateway.ts:2253` a hívás, `:2279` a rögzítés).
Következmény: valós provider-költség keletkezik, de a hívás **soha nem könyvelődik** a per-ticket
modellhívás-plafon, a keret-aggregátum és az auditnapló felé; a hívó 502-t kap. Egy hibás
verzió-fejlécet küldő kliens minden hívásnál láthatatlanul megkerülné a platform két
alapígéretét (**költség-kontroll + auditálhatóság**, AGENTS.md).

**Root-cause javítás a bizalmi határon** (PR **#512**, ág `fix/gateway-agent-version-header-validation`,
main-re bázisolva; a felhasználó WIP-je érintetlen — külön git worktree-ben készült):
- `app/src/lib/agent-version-header.ts` — `parseAgentVersionHeader`: csak nemnegatív egész, minden
  más `undefined` → a hívó `?? agent.currentVersion` fallbackje lép; `NaN` sosem keletkezik.
- `route.ts` — a nyers `parseInt` cseréje a határ-parserre (mind a 4 downstream site — normál és
  stub út — a közös `??` fallbackre esik).
- `app/scripts/agent-version-header.test.ts` — 12 eset + invariáns-loop: a visszaadott érték sosem NaN.

### Ellenőrzések
- `npm run test:agent-version-header` — **12 passed, 0 failed**.
- Matt Pocock `/code-review` (Standards + Spec, párhuzamos sub-agentek): **mindkét tengely „ship"**.
  Standards: 0 dokumentált-standard sértés; egy judgement-call (sibling `readPositiveInt` — nem
  használható, mert fallbackot ad és a `0`-t eldobja) → JSDoc-jegyzet hozzáadva. Spec: a fix a
  helyes egyetlen choke-pointon oldja meg, NaN egyik downstream siten sem jut át; a `3abc → 3`
  csonkolás szándékos és spec-konform (jegyzetelve).

### Residual risk / következő audithoz
- **`agentVersion` a chat-úton is `??`-ozódik** — ott `agent.currentVersion`-ból jön (nem fejléc),
  így a NaN-rés kizárólag a gateway-fejléc volt; más ingress nem olvas `x-agent-version`-t (grep-elve).
- **`3abc → 3` parseInt-csonkolás szándékos** (a cél a NaN kizárása). Ha később szigorú
  verzió-egyeztetés kell (a fejléc ↔ létező AgentVersion), az külön kapu — ma az agentVersion csak
  attribúció, nem authz.
- **Egyéb ingress-méret-kapuk (OOM) továbbra is nyitottak** (PR #445/#448/#443 merge-re vár) — az a
  külön, már ledgerezett munka.
- **A felhasználó ticket-ownership javítása (`386f4d548`) még az ágon van, nincs main-en** — a két
  változtatás logikailag független (más sorok), de a `package.json` scripts-blokk és a `route.ts`
  szomszédos hunkjai a two-branch merge-nél kézi egyeztetést kérhetnek; nem PR-blokkoló.

---

## 2026-09-16 — Kódfuttató sandbox (`sandbox_exec` / #485): agent-vezérelt tetszőleges kódfuttatás izolációja

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az összes eddigi kör
az OOM/ingress/tool-diszpécser felületet fedte. A `feat/485-code-sandbox` ágon egy **teljesen
új, még commitálatlan** (29 munkafa-fájl, 0 branch-commit) **kódfuttató sandbox** él: az agent
`sandbox_exec` toolon keresztül **tetszőleges parancsot/scriptet** futtat hívásonként új,
izolált sandboxban, workspace-fájlokat mountolva be/ki. Ez a platform **legmagasabb blast-radiusú
felülete** (RCE-osztály), és eddig **auditálatlan** volt → egyértelműen a legnagyobb kockázat.

**Coverage (a teljes végrehajtási lánc bejárva):** `sandbox-exec.handler.ts` → `CodeSandboxService`
(input/output méret-, fájlszám-, path-kapuk, atomikus visszaírás) → `HttpSandboxProvider`
(HTTP-protokoll, Cloud Run metadata identity token) → `code-sandbox-server.ts` →
`executeCloudRunSandbox` (`spawn` a `sandbox` CLI-re, mount-ok, output-begyűjtés) → `sandbox` CLI.
Melléksávok: consequence-gate (`sandbox_egress`), per-scope hívás/idő-keret
(`tool-broker-service.ts:432`), audit-surrogate (`tool-broker-support.ts:747`, kód SOHA nem
naplózódik, csak hash), connector-követelmény (`code_sandbox`+write), tenant-feloldás
(`resolveWorkspaceStorageTenantId`), admin-only server-action (`actions/code-sandbox.ts`),
deploy/Docker config.

### Biztonsági megállapítás — NINCS finding (≥8 konfidencia); az izolációs kontrollok helytállnak

A kötelező scoped security scan (`/security-review`, dedikált felderítő sub-agent) **és** a
független end-to-end kézi trace **egyaránt 0 bizonyítható, ≥8-konfidenciájú kihasználható
hibát** talált. Ellenőrzötten **SAFE** (mind explicit verifikálva, nem feltételezve):

- **Command injection — nincs.** `spawn(binary, argv)` shell nélkül; az agent `command[]`-je a
  `--` terminátor MÖGÖTT megy (nem injektálhat sandbox-flaget); provision fix `/bin/sleep 1000`;
  `env` az agent számára elérhetetlen (a service sosem ad át env-et).
- **Path traversal — nincs.** `normalizeSandboxWorkspacePath` (kontrollkarakter/backslash/abszolút/
  drive-betű/`..`/nem-kanonikus tiltás, `normalized===value` követelmény) app- ÉS szerveroldalon;
  `safeMountedPath` `resolve`+`startsWith(root+sep)`; a `file-editor` `resolveSafePath` rétege alatta.
- **Sandbox-escape output-linkkel — nincs.** `collectSandboxOutputs` `lstat`-tal **symlinket,
  nem-reguláris fájlt és hardlinket (`nlink!==1`) eldob** → a sandbox nem szivárogtathat ki
  host-fájlt `/work/out`-ba; csak az explicit kért (normalizált) output-ok kerülnek vissza.
- **Egress-kontroll — nincs split-brain.** A consequence-gate és a végrehajtás **ugyanazt a
  mappelt `invokeInput.args`-ot** olvassa; `boolArg` csak szigorú `true`-ra ad egresst; a runner
  `--allow-egress`-t csak `request.allowEgress===true`-ra fűz. `allowEgress:true` → **emberi
  jóváhagyás** (`sandbox_egress`). A hálózat-tiltás alapértelmezés a GCP Sandbox Launcher opt-in
  `--allow-egress` szemantikáján áll (megbízható infra, nem kód-defektus).
- **Szerver-authz — SAFE a deploy-konfiggal.** `authorizeSandboxRequest` token hiányában `true`-t
  ad (Cloud Run IAM a határ); a deploy `--no-allow-unauthenticated` (privát), token esetén
  hossz-ellenőrzés + `timingSafeEqual`.
- **Cross-tenant — nincs.** `scopeKey=ticketId??conversationId` runtime-kontextusból (nem agent-arg);
  tenant a közös `resolveWorkspaceStorageTenantId`-vel, a fájl-toolokkal azonos mintán; a
  server-action mind `requireTenantRole('admin')` + tenant-scoped `findFirst` (nincs IDOR).

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding

- **Atomikus output-visszaírás:** `writeOutputsAtomically` a régi tartalmat elmenti és hibára
  visszagörgeti (üres puffer is truthy → helyes restore; null=nem létezett → delete). Nincs
  adatvesztési ág normál futásban.
- **Failure-mode:** minden ág `finally`-ben `provider.destroy` + a runner saját `finally`-je
  `sandbox delete --force` → nincs árva sandbox; hiba esetén nincs parciális visszaírás.
- **Kill-switch:** `CODE_SANDBOX_ENABLED=false` globálisan, connectoronként lifecycle-tiltás.

### Ellenőrzések

- `npm run test:code-sandbox` — **zöld** (path-normalizálás elutasítások, egress consequence-gate
  `required` állapotok, EU-régió kényszerítés, symlink/hardlink output-elutasítás, provider
  teardown sikeren ÉS hibán, egress-default-false).
- Kötelező scoped security scan (`/security-review`): dedikált felderítő sub-agent + false-positive
  szűrés → **0 finding ≥8 konfidencián**, a fenti SAFE-kontrollok tételes verifikációjával.
- **Nettó kód-változás e körből: 0** — nincs bizonyítható finding, ezért a szabály szerint (`csak
  bizonyítható finding alapján módosíts`) nincs kód-módosítás, nincs PR és nincs `/code-review`
  (az a *létrehozott változtatásra* való; nincs ilyen). Az érték a coverage: a platform
  legmagasabb kockázatú (RCE-osztály) felületének első, dokumentált izoláció-verifikációja.

### Residual risk / következő audithoz

- **`authorizeSandboxRequest` fail-open token nélkül:** Cloud Runon IAM+privát ingress fedi, de
  **nem-Cloud-Run** deployon (a doc explicit említi ezt az utat) token-felejtés esetén az RCE-végpont
  auth nélkül nyitva. Hardening-javaslat (nem e-kör-finding, mert env/config admin-felelősség):
  fail-closed default nem-Cloud-Run providernél, vagy kötelező token, ha a provider nem `cloud_run`.
- **`baseUrl` ↔ `region` eltérés:** a Zod EU-régió-kényszer csak metaadat; a tényleges futtató a
  `baseUrl` (admin-állítja, nem validált a régióhoz). Adat-honosság (GDPR) szempontból a `baseUrl`
  a valódi döntő — admin-felelősség, de érdemes a mentéskor egyeztetni/figyelmeztetni. (Kapcsolódik:
  idea #413 adat-honosság.)
- **Egress-default a `sandbox` CLI-n múlik:** ha a GCP launcher valaha network-ON default-ra váltana,
  a jóvá-nem-hagyott (non-egress) futások hálózatot kapnának. Egy soros infra-verifikáció a launcher
  doksijával ajánlott; a kód opt-in, helyes.
- **Output-fájlszám/-méret kapu ALL `/work/out`-ra:** a runner az összes out/ fájlra számol
  (`maxFiles-files.length`), nem csak a kért output-okra → egy sok scratch-fájlt író script az
  egész futást „output_file_count_exceeded"-del bukhatja, hiába csak 1 output-ot kért. UX/megbízhatóság
  foot-gun a limiten belül, nem adatvesztés — opcionális follow-up (csak a kért output-okra számolni).
- **Precheck-race a per-scope keretnél:** ponytail-komment jelzi; Cloud Run `concurrency=1` ma szűkíti.
- **A feature még commitálatlan (0 branch-commit):** amíg nincs main-en/PR-ben, a fenti verifikáció
  a *jelenlegi munkafa-állapotra* érvényes; a merge előtti végső állapotot újra kell nézni, ha változik.

---

## 2026-09-15 — Halasztott tool-betöltés (#468 `tool_describe` + tool-index): describe-láthatóság ↔ hívhatóság

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az előző 5 kör
mind az OOM/törzs-méret-kapu felületet fedte (több nyitott OOM-PR merge-re vár —
azok átvezetése PR-menedzsment, nem új finding). A legnagyobb **nem-auditált** felület
a friss (09-14 main-re került) **#468 halasztott tool-betöltés**: a `tool_describe`
meta-tool + tool-index a **minden agent-fordulóra ható tool-diszpécser** kritikus úton
van, és eddig auditálatlan volt. Egy diszpécser-hiba blast-radiusa platform-szintű.

**Coverage:** `chat-tool-loop.ts` teljes `tool_describe`-ág + `activatedTools`
(preload ∪ skill ∪ prior ∪ checkpoint) + a D5 közvetlen-hívás-ág + a http_api
connector describe-blokk + a hívás-idejű kapuk (allow-list 2697, skill-hatókör 2714,
következmény-kapu) átnézve. `tool-registry.ts` `preload`/`toolIndexSummary`/drift-teszt
átnézve.

### Biztonsági megállapítás (NINCS finding) — a láthatóság authz-semleges

A jogosultság **invoke-időben** dől el, a láthatóságtól függetlenül: grant-allow-list
(2697), skill-hatókör (2714), broker/következmény-kapu — mind a describe/aktiválás
UTÁN, attól függetlenül fut. Ellenőrizve: (a) `tool_describe` **nem** ad ki nem-grantolt
tool sémát (`allowedTools.includes` kapu); (b) a connector-katalógus **agent-scoped**
(`findConnectorsForAgent(agentId)` → `describeBlocks` map, ismeretlen connectorId →
„nem elérhető"), nincs cross-tenant szivárgás; (c) D5 (le-nem-írt grantolt tool
közvetlen hívása) a skill-hatókör-kapu UTÁN aktivál, nem kerüli meg. **Nincs
cross-tenant / OOM / séma-szivárgás finding.**

### Finding 1 (CONFIRMED, low) — describe-láthatóság ≠ hívhatóság betöltött skill alatt

A `tool_describe` csak `allowedTools` (teljes grant) alapján kapuzott, a betöltött
skill hatókörét (`skillToolScope`) **figyelmen kívül hagyva**. Skill-szűkített futásban
a modell lekérhette a skill által kizárt (bár grantolt) tool sémáját — amit a hívás-kapu
(2714) utána úgyis elutasít. Describe és invoke **eltérő választ** adott → felesleges
modell-kör + pont a skill-hatókör-kapu által tiltott „kézi kerülőút" csábítása.
**Súlyosság:** alacsony (nincs titok-szivárgás: a séma nem érzékeny; nem cross-tenant;
a tool továbbra sem hívható). Megbízhatóság/UX + a skill-kontraktus konzisztenciája.

### Finding 2 (CONFIRMED, teszt) — stale `http_api` grant-kártya teszt = csendes hamis-zöld

A provider-független grant-kapu teszt közös `{ query:'x' }` inputot adott mindkét ágnak.
`gmail_search`-re érvényes (query=string), `http_api_get`-re **nem** (a séma `query`-t
`record`-ként várja) → a Zod-validáció a `buildToolInvokeInput`-ban a **broker ELŐTT**
dobott, így a http_api grant-kártya ág **sosem futott le** (a teszt nem azt mérte, amit
állított). Nem termék-bug (a grant-kártya éles úton helyes), hanem valódi **coverage-rés**.

### Javítás

- **Forrás (már main-en, `41f40d3d5`, PR #475 auto-merge):** a `tool_describe`-ág is
  `skillToolScope`-ra kapuz → hatókörön kívüli tool sémája „nem elérhető".
- **Drift-mentesítés (#477, review-driven):** egy `toolInSkillScope` predikátum a
  három hely helyett (tools[]-szűrés, describe-láthatóság, hívás-kapu 2714) — az
  invariáns nem drift-elhet szét inverz feltételekkel. Viselkedés változatlan.
- **Teszt (#477):** eszközönként érvényes args → a http_api grant-ág valódi lefutása,
  + új regresszió a hatókörön kívüli describe elrejtésére.

### Ellenőrzések

- `scripts/agent-tool-loop.test.ts` — teljes fájl **zöld** (új skill-hatókör describe
  assert + a javított http_api grant-ág). `tool-registry-drift.test.ts` zöld.
- `tsc --noEmit` + `eslint` tiszta az érintett fájlokra (a 2 megmaradt tsc-hiba —
  `scheduled-task-enterprise.test.ts`, `.next-local-auth` generált — **pre-existing**
  main-baseline, nem ebből a körből).
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** nincs hard violation; a describe-predikátum a hívás-kapu pontos
    inverze („közös kapu / nincs drift" standardot erősíti). Egyetlen judgement-call
    (a hármas ismétlés drift-kockázata) **átvezetve** a `toolInSkillScope` predikátummal.
  - **Spec:** _defensible alignment, nem violation_ — a spec §1.3 „nem-leírt ≠
    jogosultsági állapot" a *fail-open* irányt (D5) védi; a nem-hívható séma elrejtése a
    *szigorúbb* irány, és a §1.3+D10 maga is a skill-hatókört hívhatóság-döntőnek nevezi.
    Nincs hibás implementáció.

### PR

- **#477** — `fix(tools): tool_describe kövesse a skill-hatókört — regresszió +
  drift-mentesítés` (branch `test/tool-describe-skill-scope-coverage`, `main`-ről).
- A forrás-fix (`41f40d3d5`) **már main-en** (a környezet automatizációja PR #475-öt e
  kör közben auto-merge-elte; a #468 forrás-fix ezért main-en, #477 a tesztet+refaktort viszi).

### Residual risk / következő audithoz

- **D2 index (stabil prefix) skill-hatókörön kívüli grantolt toolt is felsorol:**
  az index-blokk `allowedTools`-ból épül (D8: prior-független stabil prefix), így betöltött
  skill alatt olyan toolt is mutat, amit a modell most már **sem describe-olni, sem hívni**
  nem tud. Nem szivárgás (a név nem érzékeny), de UX/konzisztencia-rés — a skill-hatókör-jegyzet
  jelzi a valóban használhatókat. Follow-up: index is szűkíthető skill-hatókörre (a stabil-prefix
  cache-előny mérlegelésével).
- **Describe üzenet-paritás:** a hatókörön kívüli describe ugyanazt a terse „nem elérhető"-t
  adja, mint a nem-grantolt eset, míg a hívás-kapu (2714) gazdagabb „nincs a skill listájában"
  üzenetet ad. A modell így nem különbözteti meg a két okot — apró, spec-néma, opcionális UX-nicety.
- **`priorToolNames` wire↔belső név:** a `ToolCall.toolName` (belső név) egyezik az
  `allowedTools`-szal; ha valaha wire-néven tárolódna, csak +1 describe-kör az ára (nem authz).
- **Nyitott OOM-PR stack (#443/#445/#448) továbbra is merge-re vár** — a tartós OOM-kockázat
  csökkentése ezek átvezetése; a következő kör prioritása lehet.

---

## 2026-09-11 — Fájlfeltöltés (`formData()`) OOM: a scope MÁR javítva (#448) — duplikátum visszavonva + coverage-rés rögzítve

**Scope-választás (kockázati alapon):** a 09-09 kör lezárt residualja explicit ezt
jelölte a „legfontosabb követő"-nek: a multipart **fájlfeltöltés** — a két
`.../workspace/files` POST route (`tickets` + `conversations`) a `request.formData()`-tal
a teljes törzset memóriába pufferelte, és csak UTÁNA nézte az 50 MB-os kaput
(OOM ellen hatástalan). Ez közvetlenül a **nyitott Cloud Run OOM-incidens**
(`healthcheck-cloud-run-oom-concurrency`) vektora → a legmagasabb *gyakorlati* kockázat.

### Finding A (CONFIRMED, de MÁR JAVÍTVA) — méret-kapu a teljes törzs pufferelése UTÁN → OOM

Mindkét feltöltő route a `await request.formData()`-tal a teljes multipart törzset
memóriába pufferelte, MIELŐTT a `file.size > 50 MB` kapu lefutott volna → hitelesített
operátor tetszőlegesen nagy törzzsel OOM-kill-t válthatott ki. A finding valós; **de a
kódbázisban már nyitva van rá a kanonikus fix:** **PR #448**
(`fix/bounded-upload-formData-oom`, 09-10) — `lib/bounded-form-data.ts` /
`readBoundedFormData`. Ez a helyes, **erős** megoldás: Content-Length gyors-elutasítás
MELLETT egy streamelő `TransformStream` bájt-számláló megszakítja a parse-t a teljes
pufferelés BEFEJEZÉSE előtt — így a chunked / hiányzó / hazudott Content-Length
támadói utat is zárja. Mindkét route-on helyesen bekötve, `RequestBodyTooLargeError` →
413, a pontos per-fájl `file.size` kapu megtartva.

### Finding B (PROCESS/COVERAGE) — a 09-10 audit-kör terméke (#448) nem került a naplóba

A napló utolsó bejegyzése 09-09 volt; a 09-10 kör létrehozta #448-at, de sem a
`production_audit.md`-ben, sem a memóriában nem jelölte. Emiatt **ez a kör kockázati
alapon ugyanazt a (már megoldott) scope-ot választotta** és egy gyengébb, csak
Content-Length-alapú duplikátumot (#450) kezdett. **Tanulság / következő audithoz:** a
scope-választás ELŐTT a nyitott PR-eket (`gh pr list`) is nézni kell, nemcsak a ledgert —
több nyitott OOM-keményítő PR halmozódik (#443 process-input, #445 nyers-JSON,
#448 multipart), egyik sincs main-en.

### Tevékenység ebben a körben

- **#448 független verifikáció:** átnéztem a `readBoundedFormData`-t és a két route
  bekötését — korrekt, a streaming bájt-számláló a `Content-Length`-only megközelítésnél
  erősebb (zárja az attacker-path residualt). **Javaslat: #448 a kanonikus fix, mergelni.**
- **#450 (saját duplikátum) LEZÁRVA + branch törölve:** gyengébb (csak Content-Length),
  felesleges a #448 mellett. A zárás-komment rögzíti az okot.
- Nettó kód-változás e körből: **0** (a napló-bejegyzésen kívül) — a kockázatot #448 fedi.

### Residual risk / következő audithoz

- **#448 MERGE-re vár:** amíg nincs main-en, az OOM-vektor élesben nyitva marad. A
  három nyitott OOM-PR (#443/#445/#448) merge-sorrendje és CI-státusza a következő
  kör prioritása — új scope helyett ezek átvezetése csökkenti ténylegesen a kockázatot.
- **Tartós OOM-fix:** platform/ingress-szintű törzs-méret plafon (apphosting/Cloud Run)
  + a #114 runtime-szétválasztás; a nyitott OOM-incidenst NE jelöljük lezártnak #448
  merge-ével sem (csak a feltöltés-vektort zárja, nem a teljes párhuzamos-chat OOM-ot).
- **Malware / content-type hamisítás (idea #447):** változatlanul nyitva; külön, tágabb
  biztonsági kapu (magic-bytes + AV + makró-vizsgálat, karantén) — önálló scope, e kör
  NEM érintette.

---

## 2026-09-09 — Nyers JSON kérés-törzs méret-kapu MINDEN ingressen (DoS/OOM)

**Scope-választás (kockázati alapon):** a 09-08 kör lezárt residualja explicit ezt jelölte
„a legfontosabb követő"-nek: a mező-szintű kapuk (#438/#443) UTÁN is nyitva maradt a
**nyers kérés-törzs** — `request.json()` / `readJson` egyik route-on sem volt globálisan
méret-kapuzva, így egy több MB-os *body* már a `JSON.parse`-nál OOM-olhatott, a mező-kapu
ELŐTT. Ez közvetlenül a **nyitott Cloud Run OOM-incidens** (`healthcheck-cloud-run-oom-concurrency`)
vektora → a legmagasabb *gyakorlati* kockázat.

**Coverage (a teljes JSON-ingress-felület felmérve):**
- Minden `app/src/app/api/**` body-olvasó felderítve: 7 nyers `request.json()`, 4 `readJson`,
  1 nyers `request.text()` (dispatch-cycle), 2 `formData()` (fájlfeltöltés).
- A `formData()` multipart-utak (`tickets|conversations/.../workspace/files`) szándékosan
  **kívül** vannak a JSON-scope-on (feltöltés-méret ≠ JSON-parse OOM) — residual.

### Finding (CONFIRMED) — határ nélküli kérés-törzs → OOM a `JSON.parse` előtt

A control-plane JSON-végpontjai a teljes kérés-törzset a memóriába pufferelték `JSON.parse`
elé, felső korlát nélkül. Hitelesített kliens (a Telegram-webhooknál külső fél) több MB-os
törzzsel a memória-szűkös konténerben OOM-ot válthatott ki — a mező-szintű kapuk ez ELŐTT
hatástalanok. **Súlyosság:** közepes (hitelesített DoS/OOM), de a nyitott OOM-incidens miatt
a gyakorlati kockázat magasabb. Nincs cross-tenant szivárgás.

### Javítás (root cause a megosztott határon)

`readJson` (`lib/api-response.ts`) mostantól a bájt-plafonig olvas a törzsből, **mielőtt**
memóriába pufferelné: Content-Length gyors-elutasítás + stream-darabolós számláló, ami
`reader.cancel()`-lel megszakít a plafon átlépésekor (chunked / Content-Length nélküli
törzsnél is). Egy hely, minden JSON-ingress rajta megy át:
- 4 process-route (`readJson`-t már használ) → ingyen véd;
- 7 nyers `request.json()` hívó átállítva (`agent-chat/stream`, `gateway/chat/completions`,
  `agent/tickets`, `agent/tools`, `harness .../complete` + `.../process`, `telegram/webhook`);
- `internal/dispatch-cycle` nyers `request.text()`-je a közös `readBoundedText`-en (a handler
  meglévő catch-e 400-at ad túl nagy törzsre).
- Alap plafon **1 MiB**; a nagy modell-kontextust hordozó **gateway explicit 4 MiB**.

### Ellenőrzések

- `scripts/read-json-body-limit.test.ts` (új, 10 assert, zöld): plafon-határ (exact-max/+1),
  Content-Length gyors út, **chunked stream-számláló** (a fő bypass-teszt), `readBoundedText`
  viselkedés, érvénytelen-JSON elkülönítése a méret-hibától, route-wiring forrás-assertek
  (nincs maradék nyers `request.json()` / `request.text()`). `test:read-json-body-limit`.
- `tsc --noEmit` + `eslint` tiszta a módosított fájlokra.
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** hard violation nincs; a „közös kapu, nincs drift" standardot **erősíti**.
    Judgement-callok: Shotgun Surgery (a közös kapu elkerülhetetlen ára), a try/catch-duplikáció
    **nem e diff terméke**, a forrás-szkennelő teszt-assert törékeny (de a repo bevett mintája).
  - **Spec:** mag-követelmény teljesül, **nincs bypass** (a stream-út a chunked törzset a parse
    előtt megszakítja). Két pont **átvezetve ugyanebben a PR-ben:** (a) dispatch-cycle nyers
    törzs kapuzása; (b) a `RequestBodyTooLargeError` félrevezető 413-ígéretének törlése
    (a típus valódi haszna: méret- vs. JSON-hiba megkülönböztetés a teszteknek).

### PR

- **#445** — `fix(api): bound JSON request bodies at every ingress (DoS/OOM)`
  (branch `fix/bounded-json-body-oom`, `main`-ről; izolált worktree — a `main` munkafa 29
  idegen, commit-olatlan változást tartalmazott, ezek NEM kerültek a PR-be).

### Residual risk / következő audithoz

- **Státuszkód-finomítás:** a process-route-ok generikus catch-e a túl nagy törzsre 500-at ad
  (a többi ingress 400/null-t); rejection mindkét esetben (nincs OOM). A `413`-ra képezés
  opcionális UX-nicety, nem biztonsági kérdés.
- **Fájlfeltöltés (`formData()`):** a `workspace/files` multipart útjai külön feltöltés-méret-
  kapu (GCS-kvóta) tárgya — nem JSON-scope, follow-up.
- **Gateway 4 MiB:** tapasztalati plafon; ha valós nagy-kontextusú agent-forgalom efölé nő,
  emelni kell (l. `workspace/files` streamelés follow-up).
- A teljes JSON-ingress-felület mostantól egyetlen kapuzott helyen (`readJson`/`readBoundedText`)
  fut — új route csak ezeken át olvasson törzset (regressziós forrás-assert őrzi a meglévőket).

---

## 2026-09-08 — Folyamat-indító bemenet méret-kapu + ingress/authz-felület átvizsgálás

**Scope-választás (kockázati alapon):** a 09-07 kör lezárása után a legnagyobb
nyitott, klienstartalmú, határok nélküli ingress a **folyamat-indító `inputPayload`**
volt — a ledger `processInputPayload` residual-ját célozza, és közvetlenül a nyitott
**Cloud Run OOM-incidenshez** (`healthcheck-cloud-run-oom-concurrency`) kapcsolódik.
A kiválasztás előtt széles authz/ingress-átvizsgálás futott (lásd Coverage), amelyből
kockázati sorrendben ez a bizonyítható finding emelkedett ki.

**Coverage (átvizsgálva, VERIFIKÁLTAN ZÁRT — nem finding):**
- **Folyamat-definíció életciklus** (`process-definitions/*` route-család:
  create/patch/activate/archive/runs/triggers): minden mutátor `requireDef(tenantId,id)`
  → `defs.findById` `where:{id,tenantId}`. Tenant-scoped, szerepkör-kapuval. Tiszta.
- **`startProcess` / `startFromDefinition`**: def+verzió+playbook mind `input.tenantId`-re
  szűrve; `rootTicketId` a belépő ticketre felülíródik; `conversationId` nincs cross-tenant
  olvasva. Tiszta.
- **Workspace fájl-letöltés** (conversations + tickets párhuzamos route): szimmetrikus,
  `resolveWorkspaceTenantKey` + közös `resolveDownloadableWorkspacePath` letöltés-kapu. Tiszta.
- **Agent-turn cancel + reconnect-stream**: `findById` után `isAgentTurnAccessible`
  (tenant ÉS létrehozó egyezés). Tiszta.
- **Telegram jóváhagyás-callback** (untrusted external ingress): titkos fejléc (konstans idő),
  aláírás a kötött mezőkre, címzett-identitás kötés, aktív+tenant egyezés, allowedActions,
  ÉLŐ szerep-újraellenőrzés, saját-kérés kapu, atomikus egyszer-használat CAS. Tiszta.
- **OAuth connector-callback**: AES-256-GCM state (nem hamisítható), `state.userId===actorId`
  + connector-tenant egyezés + PKCE → nincs OAuth-CSRF/token-injekció. Tiszta.
- **Dispatcher HTTP-szerződés** (`handleDispatchCycleRequest`): fail-closed token (üres titok→401),
  timing-safe, body csak auth után. Tiszta.
- **Harness route-ok**: `/process` agent-kulcs + scope + `ticket.agentId===auth.agentId`;
  `/complete` platform-szintű shared token (infra-auth). Tiszta a tenant-határon.
- **Write-gate token consume**: státusz/lejárat/diff-hash/subject/aláírás + egyszer-használat CAS. Tiszta.
- **Tool-broker `document_read` / `tulajdoni_lap_parse`**: `canAccessDocument` +
  `isDocumentReachableFromTenant` (fail-closed, bélyeg-pontos tenant-egyezés); a
  `conversationId`/`ticketId` szerver-injektált futáskontextus, nem agent-arg. Tiszta.

### Finding (CONFIRMED) — validálatlan `inputPayload` / `processInputPayload` (DoS/OOM/költség)

A folyamat-indító bemenet (`Record<string, unknown>`) **méret-kapu nélkül** jutott el a
runtime-ba, a DB-be (`Prisma.InputJsonValue`) és az agent promptjába, KÉT klienstartalmú
ingressen:
1. **Chat-stream** (`POST /api/v1/agent-chat/stream`) — a `processInputPayload` mezőt a
   09-07 (#438) `agentChatStreamTurnInputSchema` **nem** fedte (explicit residual).
2. **REST futás-indító** (`POST /api/v1/process-definitions/[id]/runs`) — a
   `startProcessSchema.inputPayload` szabad `z.record(...)` volt, korlát nélkül.

- **Hatás:** hitelesített kliens tetszőlegesen nagy/mély JSON-objektumot küldhetett →
  erőforrás-kimerítés (OOM-irány a memória-szűkös Cloud Run konténerben), DB-hízás,
  fölös modellköltség. Nincs cross-tenant szivárgás.
- **Súlyosság:** közepes (hitelesített DoS / OOM / költség), de a **nyitott OOM-incidens**
  miatt gyakorlati kockázata a szokásosnál magasabb.

### Javítás (root cause a határon)

Közös `processInputPayloadSchema` (`validators/actions.ts`): `z.record` + szerializált
méret ≤ **64 KiB** (`PROCESS_INPUT_PAYLOAD_MAX_BYTES`). Egy helyen definiálva, **mindkét**
ingressen alkalmazva (nincs kapu-drift): `agentChatStreamTurnInputSchema.processInputPayload`
és `startProcessSchema.inputPayload`. A chat-route a határon `safeParse`-el →
`400 invalid_turn_input`, és a lefelé küldött érték a **validált** `turnInput.data.processInputPayload`
(a nyers body-mező csak kapu-input). A közös séma a `startProcessSchema` révén a
`app/actions/process.ts` server-action utat is fedi → mindkét úton (chat + ticket/action) véd.

### Ellenőrzések

- `scripts/agent-chat-stream-input.test.ts` (15 assert, zöld): folyamat-bemenet exact-max
  átmegy, +1 bájt bukik a chat-stream ÉS a REST `startProcessSchema` sémán, normál payload
  átmegy, route-wiring forrás-assert (`safeParse`-ben + validált érték downstream).
- `tsc --noEmit` + `eslint`: a módosított fájlokra tiszta.
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** nincs hard violation; magyar kommentek/üzenetek, „mindkét úton" elv
    teljesül, a közös séma az anti-smell (Duplicated Code/Shotgun Surgery megszűnik).
    Két triviális judgement-call (a refine-üzenet „bájt" szava belső Zod-üzenet;
    a route egyetlen mezője megy `turnInput.data`-ból — okát komment fedi).
  - **Spec:** követelmények teljesülve, nincs scope-creep, nem bypassable (a `safeParse`
    feltétel nélkül fut a route tetején, folytatáskor is). Egyetlen ismert plafon: a
    nyers body a payload-kapu ELŐTT parse-olódik (l. residual).

### PR

- **#443** — `fix(process): bound process-start input payload at both ingresses (DoS/OOM)`
  (branch `fix/process-input-payload-size-limit`, commit `0c71c5a8b`, `main`-ről).

### Residual risk / következő audithoz

- **Nyers kérés-törzs plafon (a legfontosabb követő):** `request.json()` / `readJson`
  egyik érintett route-on sincs globálisan méret-kapuzva, így egy több MB-os *body* már a
  `JSON.parse`-nál OOM-olhat, a mező-szintű kapu ELŐTT. A #438 mintát követve most a
  parse-olt mezőt kapuztuk; a raw-body plafon szélesebb, minden route-ot érintő follow-up
  (közös `readJsonBounded` a `readJson`/`request.json()` helyére).
- **Mélység-kapu:** a 64 KiB-os szerializált méret közvetve korlátozza a beágyazást; külön
  depth-limit nem szükséges (a `JSON.parse` rekurziós plafonja alatt maradunk), de ha a
  raw-body kapu bejön, érdemes együtt nézni.
- A fent felsorolt VERIFIKÁLTAN ZÁRT scope-ok újra-auditja nem szükséges, hacsak új hívó/
  ingress nem kerül be (különösen: `agent-chat-runtime.setProjectKey` sink, ha új hívót kap).

---

## 2026-09-07 — Agent-chat stream API: kliens forduló-bemenet méret-kapui (DoS/OOM)

**Scope:** `POST /api/v1/agent-chat/stream` kliens-vezérelt bemenetei — `content`,
`taskBriefing.*`, `attachmentDocumentIds` — végig a downstream fogyasztásig
(`agent-chat-runtime` / `general-task-runtime` / `scheduled-task-service`).
Kockázati alapon: a 09-05 kör három residual pontját célozta (attachment IDOR,
content/briefing méret, non-web ingress), és közvetlenül kapcsolódik a nyitott
Cloud Run **OOM-incidenshez** (`ops/cloud-run-oom-concurrency`).

**Coverage:**
- **Attachment tenant-határ (IDOR) — VERIFIKÁLTAN ZÁRT (nem finding).** Mindkét
  futási út (`agent-chat-runtime.loadDocuments` 1202/2125, `general-task-runtime`
  1208) a `assertDocumentsReachableFromTenant`-en megy át; a `findByIds` teljes
  `Document` sort ad (metadata/uploadedById/connectorId a guardnak megvan). A view-
  építő út (2463) már kötött, historikus ID-kkel dolgozik (tenant-scope-olt
  `getConversation`), nem fresh IDOR. A scheduled-task tárolt attachment-listája is
  csak futáskor, a `loadDocuments`-en át materializálódik → fail-closed.
- **Input méret-kapu — FINDING (lásd lent).**
- `processInputPayload` méret-kapu: **nem** része ennek a körnek (residual).

### Finding (CONFIRMED) — validálatlan `content` / `taskBriefing` / `attachmentDocumentIds`

A stream-route a kliens `content`, `taskBriefing.*` és `attachmentDocumentIds`
mezőit **méret-/formátum-ellenőrzés nélkül** adta tovább az agent-fordulónak
(prompt-összeállítás, DB-írás, modellhívás). A szentesített szerver-action utak
(`createAgentTaskTicketSchema`, `addTicketCommentSchema`, `taskBriefingSchema`) már
kapuzzák ugyanezeket; ez a route volt az **egyetlen** határok nélküli ingress —
ugyanaz a minta, mint a 09-05 `projectKey` finding.

- **Hatás:** egy hitelesített kliens tetszőlegesen nagy üzenetet/briefinget és
  tetszőlegesen hosszú (nem UUID) csatolmány-listát küldhetett → memória-kimerülés
  (OOM-irány), fölösleges modellköltség, lassulás; a nem-UUID azonosítók közvetlenül
  a prisma `in`-lekérdezésbe kerültek.
- **Súlyosság:** közepes (hitelesített DoS / erőforrás-kimerítés / költség; nincs
  cross-tenant szivárgás).

### Javítás

`agentChatStreamTurnInputSchema` (Zod) a `validators/actions.ts`-ben, a route a
határon `safeParse`-el → `400 invalid_turn_input` (a chat-felület olvasható hibaként
jeleníti meg, nincs beragadt „dolgozik"). Kapuk: `content` ≤ 16 KiB (komment-törzs
precedens), `taskBriefing` a meglévő `taskBriefingSchema.partial().nullish()` újra-
használatával (nincs kapu-drift), `attachmentDocumentIds` max 8 valódi UUID. A kapu
a folytatás-elágazás fölött, feltétel nélkül fut (folytatáskor is véd). Root-cause
szintű: minden `content`/csatolmány ingress ugyanazon a kapun megy át.

### Ellenőrzések

- `scripts/agent-chat-stream-input.test.ts` (új, 10 assert): séma-határok (content
  exact-max/+1, exact-8 és >8 csatolmány, non-UUID, briefing 2000/approval 500) +
  route-wiring forrás-assert. Zöld. `package.json` `test:agent-chat-stream-input`.
- `eslint` tiszta a módosított fájlokra; a módosított fájlok `tsc`-tiszták (a
  `scheduled-task-enterprise.test.ts` tsc-hiba a `main`-en is fennáll, nem ide tartozik).
- Független `/code-review` (Standards + Spec): _lásd lentebb_.

### PR

- **#438** — `fix(chat): bound client turn input at the agent-chat stream boundary`
  (branch `fix/chat-stream-input-limits`, `origin/main`-ről).

### /code-review eredmény (Matt Pocock skill, 2 párhuzamos axis)

- **Standards:** nincs sértés; a séma a többi validátor mellett, a route a
  `resolveChatStreamProjectKey`-jel azonos `safeParse→400` mintát követi. Egyetlen
  actionable smell (Duplicated Code/Data Clumps: briefing-mezők újradeklarálása)
  **átvezetve** → `taskBriefingSchema.partial().nullish()` újrahasználat.
- **Spec:** helyes és hű; a kapu **mindkét** ágon (normál + folytatás) fut, a
  16 KiB defenzálható (chat = szabad szöveg ≈ komment-törzs), a `400` tiszta UI-
  állapot. Nincs scope-creep (a séma kimenete eldobva, viselkedés nem változik).
  Két teszt-rés (exact-8, approval-500) **átvezetve**.

### Residual risk / következő audithoz

- **`processInputPayload` (folyamat-indító payload) méret-kapu nélkül** megy tovább
  a stream-route-on (route.ts). Nem volt e finding hatóköre — **prioritált követő**.
- **Chat-composer nincs kliens-oldali csatolmány-számkapu:** >8 csatolmánynál most
  `400` (a platform-standard 8-hoz igazodva) — érdemes a composerben graceful 8-as
  kapu (UX, nem biztonság).
- **Content 16 KiB:** ha valós chat-használat rendszeresen efölött paste-el, a kapu
  látható lesz — akkor emelni/streamelni kell (l. `workspace/files` streamelés follow-up).
- Nem-web ingress-ek (agent API-kulcs, csatorna-integrációk, monitor-eszkaláció)
  `content`/méret-kezelése változatlanul ellenőrizendő (fogadnak-e ilyen mezőt).

---

## 2026-09-05 — Agent-chat stream API: work-project kulcs validáció

**Scope:** `POST /api/v1/agent-chat/stream` (`app/src/app/api/v1/agent-chat/stream/route.ts`)
— a webes chat-felület egyetlen kliens-vezérelt fordulóindító végpontja. Kockázati
alapon választva: ez a legnagyobb támadási felületű, autentikált, kliens-adatot
(`projectKey`, `content`, `taskBriefing`, `attachmentDocumentIds`) az agent-runtime-ba
továbbító ingress, és a `projectKey` a **memória + audit hatóköre**.

**Coverage:** a `projectKey` teljes ingress-felülete végignézve (API-route + a
`app/src/app/actions/` server-action írási útvonalak), valamint a downstream memória-
és audit-felhasználás (`memory-runtime-helper`, `memory-*-service`, `inputRef: project:<key>`).
A route egyéb bemenetei (consequence-approval folytatás, connector-grant folytatás,
task-only kapu, aktív-forduló 409, SSE keep-alive/`after` életciklus) áttekintve —
ezeken nem találtam új bizonyítható findingot ebben a körben.

### Finding (CONFIRMED) — validálatlan `projectKey` → árva memória/audit névtér

A stream-route a kliens `projectKey`-jét **validáció nélkül** adta tovább az agent-
fordulónak. A `projectKey` a munkatárs-memória lekérés/írás szűrője és az audit
`inputRef` (`project:<key>`) hatóköre. A ticket- és server-action útvonalak már a
`workProjects.assignableKey(tenantId, key)` kapun mennek át; ez a route volt az
**egyetlen** API-ingress, amely megkerülte azt.

- **Hatás:** egy ismeretlen vagy archivált kulccsal a chat-felületről új,
  nyomon követhetetlen memória-szeletet lehetett nyitni a tenanten belül (adat-
  integritás / auditálhatóság sérül). Tenant-határ nem sérült: az `assignableKey`
  a `findByKey(tenantId, key)`-t használja, így másik tenant kulcsa „nem található".
- **Súlyosság:** közepes (adat-integritás / audit-scope, nem cross-tenant szivárgás).

### Javítás

`app/src/app/api/v1/agent-chat/stream/route.ts`: nem-folytatás fordulónál a route
mostantól a `services.workProjects.assignableKey`-t hívja:
- ismeretlen / archivált / érvénytelen kulcs → `400 invalid_work_project` (forduló nem indul),
- foglalt/üres kulcs → `Általános` gyűjtőre normalizál,
- a tovább adott érték a validált, normalizált kulcs (`assignedProjectKey`).

Root-cause szintű: minden `projectKey` ingress most ugyanazon a kapun megy át.

### Ellenőrzések

- `scripts/work-project.test.ts` — kiegészítve a stream-route validáció regressziós
  assertjével (assignableKey-hívás, `invalid_work_project` hiba, `assignedProjectKey`
  továbbadása). Teljes fájl zöld.
- `tsc --noEmit` tiszta; `eslint` tiszta a módosított fájlokra.
- Független `/code-review` (Standards + Spec): _lásd lentebb_.

### PR

- **#430** — `fix(chat): validate work project keys at API boundary`
  (branch `fix/chat-work-project-validation`, commit `d13484223`).

### /code-review eredmény (Matt Pocock skill, 2 párhuzamos axis)

- **Standards:** nincs hard violation; a változás **javítja** a konformitást
  (`AGENTS.md` „mindkét úton működjön" elv — a chat-út most ugyanazt a kaput
  használja, mint a ticket/server-action út). Csak triviális judgement-call
  smell-ek (a régi inline feltétel felemelése egy helyre = szándékos cleanup;
  a teszt forrás-string regex asszertjei a fájl meglévő stílusa).
- **Spec:** követelmények teljesülve, root cause a határon javítva, nincs scope
  creep. A route az **egyetlen** app-szintű `sendMessageStream` hívó — nincs
  ungated testvér-ingress. A `assigned.key` (nem a nyers input) továbbadása
  tiszteletben tartja a foglalt-kulcs normalizálást (agent-memory §2.1
  `__general__` szentinel, nincs null-kulcs).

### Residual risk / következő audithoz

- **Defense-in-depth (opcionális, YAGNI-ból most kihagyva):** az
  `agent-chat-runtime.ts` `setProjectKey` sink továbbra is közvetlenül veszi a
  `params.projectKey`-t, `assignableKey` nélkül. Gyakorlatban zárt (az egyetlen
  nem-megbízható hívó most kapuzott), de egy jövőbeli hívó újranyithatná — érdemes
  runtime-szintű kapuval megerősíteni, ha újabb ingress kerül be.
- **Continuation-on-archived él (scope-on kívül):** ha egy beszélgetés projektjét a
  létrehozás UTÁN archiválják, a folytatás továbbra is a már-archivált névtérbe ír
  (a névtér már létezett; a folytatás nem küld `projectKey`-t).
- A `content` és `taskBriefing.*` mezők tartalom-validációja/hossz-plafonja külön
  vizsgálandó (DoS / prompt-méret) — nem része ennek a körnek.
- `attachmentDocumentIds` és `processInputPayload` bizalmi-határa (IDOR/tenant-scope
  a downstream `sendMessageStream`-ben) — jövőbeli scope.
- Nem-web ingress-ek (agent API-kulcs, csatorna-integrációk, monitor-eszkaláció)
  `projectKey`/scope kezelése — jelen körben nem érintett, ellenőrizendő, hogy ezek
  egyáltalán fogadnak-e projektkulcsot.
